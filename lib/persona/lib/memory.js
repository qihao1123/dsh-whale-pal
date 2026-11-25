/**
 * 记忆的存取规则。
 *
 * 活人感不是「什么都记得」，而是「只记得住一部分，剩下的会淡」：
 *   - 每条记忆有重要度（salience），由「类型 + 被重复提到几次」决定，不由模型随口给；
 *   - 反复出现的内容会合并（同义去重），而不是堆成十条；
 *   - 没再被提起的记忆缓慢变淡，容量满了先淘汰最淡的；
 *   - 检索时按「重要度 × 新鲜度」取前几条，所以早期的琐事会自然让位。
 *
 * 所有函数都不修改入参以外的状态；写入前一律归一化。
 */

import { recallThenRank, splitByTier } from './recall.js'
import {
  countInScene,
  normalizeSceneId,
  sceneCommonAncestor,
  sceneOf,
  sceneRelation,
  sceneWeight,
  SCENE_OWNER,
  SCENE_WORK_GENERAL,
  trimToPoolCaps,
} from './scene.js'

export const MEMORY_KINDS = ['facts', 'preferences', 'events', 'openTopics']

/** 升级来源（P3）：为什么这条跑到上一层去了。空串表示没升过。 */
export const ELEVATED_BY = ['', 'explicit', 'category', 'count', 'manual']

/** 靠计数升上去的权重：打七折。看得见，但同层同样新旧时得让半步。 */
export const COUNT_WEIGHT = 0.7

/** 项目通用层的硬上限：满了不许自己丢一条，提出请求让人决定。 */
export const GENERAL_CAP = 50

/** 靠计数升上去的条目，别的场景多久没再提起到就降回去（按轮次算）。 */
export const DOWNGRADE_STALE_SESSIONS = 60

/** 不同类别的初始重要度：底线与承诺最该记住，随口提的事最轻。 */
export const BASE_SALIENCE = {
  facts: 0.6,
  preferences: 0.7,
  events: 0.5,
  openTopics: 0.45,
  boundaries: 0.95,
  commitments: 0.8,
}

/** 先把对象当字符串写进来留下的残渣：这种条目没有内容，留着只会污染摘要。 */
const ENTRY_JUNK = /^\[object \w+\]$/

/** 低于这个重要度就不再主动想起来（数据仍留着，除非容量紧张）。 */
export const FADE_FLOOR = 0.12

/** 重复提到一次加多少重要度。 */
const HIT_GAIN = 0.08

/** 合并阈值：0.8 以上算同一件事。 */
const DUP_THRESHOLD = 0.8

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 淘汰最多留几条墓碑。留的是「它曾经是什么」，不是正文。 */
export const TOMBSTONE_CAP = 60

/** 墓碑上的原因码 → 说人话。取回时直接用这一句，不临场编。 */
export const TOMBSTONE_REASON_TEXT = {
  cap: '容量满了，被分数更低的条目顶掉',
  faded: '久没被提起，淡到不再进目录后清掉了',
  'long-full': '长期层满了，被最久没提起的条目顶掉',
}

/**
 * 淘汰留痕：条目从池子里移走前，先把「谁、什么时候、为什么」记下来。
 *
 * 以前淘汰只是 `splice`，条目上写的 evictedAt / evictedReason 跟着条目一起没了，
 * 于是 `read M-042` 只会回「没有这条」——分不清「从没记过」和「记过、被顶掉了」。
 * 墓碑只留编号、类别、一句主题和时间，正文不留（留正文等于没淘汰）。
 */
export function pushTombstone(tombstones, entry, options = {}) {
  if (!Array.isArray(tombstones) || !isObject(entry)) return null
  const { reason = 'cap', now = Date.now(), session = 0 } = options
  const record = {
    id: typeof entry.id === 'string' ? entry.id : '',
    kind: typeof entry.kind === 'string' ? entry.kind : '',
    topic: cleanMemoryText(entry.text).slice(0, 60),
    at: Number(now) || Date.now(),
    reason: String(reason ?? 'cap').slice(0, 40),
    session: Math.max(0, Math.floor(Number(session) || 0)),
  }
  tombstones.push(record)
  while (tombstones.length > TOMBSTONE_CAP) tombstones.shift()
  return record
}

/** 状态里那份墓碑列表，缺了就补一个空数组。 */
export function tombstonesOf(state) {
  if (!isObject(state)) return []
  if (!Array.isArray(state.memoryTombstones)) state.memoryTombstones = []
  return state.memoryTombstones
}

/** 按编号找墓碑（新的优先）。取回时用来区分「没记过」和「被淘汰了」。 */
export function findTombstone(state, id) {
  const want = String(id ?? '').trim().toUpperCase()
  if (want === '' || !isObject(state)) return null
  const list = Array.isArray(state.memoryTombstones) ? state.memoryTombstones : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (String(list[i]?.id ?? '').toUpperCase() === want) return list[i]
  }
  return null
}

const clamp01 = (value, fallback = 0) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/** 比较用的键：去掉空白与标点，全角转半角，保留汉字和字母数字。 */
export function memoryKey(text) {
  return String(text ?? '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s，。、,.！!？?：:；;「」『』()（）【】\[\]~～\-—_]/g, '')
}

function bigrams(key) {
  const out = new Set()
  for (let i = 0; i < key.length - 1; i += 1) out.add(key.slice(i, i + 2))
  return out
}

/**
 * 相似度：完全相同 1；一个包含另一个（短句 ≥4 字）0.85；否则二元组 Jaccard。
 * 目的是合并「用户在做人格插件」和「用户正在做人格插件」这类重复。
 */
export function similarity(a, b) {
  const ka = memoryKey(a)
  const kb = memoryKey(b)
  if (!ka || !kb) return 0
  if (ka === kb) return 1
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka]
  if (short.length >= 4 && long.includes(short)) return 0.85
  const setA = bigrams(ka)
  const setB = bigrams(kb)
  if (setA.size === 0 || setB.size === 0) return 0
  let shared = 0
  for (const gram of setA) if (setB.has(gram)) shared += 1
  // Dice 而不是 Jaccard：中文里多一个「正在」「的」不该把同一件事判成两件事。
  return (2 * shared) / (setA.size + setB.size)
}

/** 在列表里找最像的那条，返回下标（找不到 -1）。 */
export function findSimilar(list, text, threshold = DUP_THRESHOLD) {
  return findSimilarInScene(list, text, null, threshold)
}

/**
 * 只在指定池子里找相似条目（P1）。
 *
 * 为什么必须分池：全局比对时，A 项目说过「这个要重构」，B 项目说一句很像的，
 * 就会被判成「重复」而并进 A 的条目——两个人的话记成一条，是串台，不是去重。
 * `scene` 传 null 才是全局比对（人工操作在用）。
 */
export function findSimilarInScene(list, text, scene = null, threshold = DUP_THRESHOLD) {
  if (!Array.isArray(list)) return -1
  const want = scene === null ? null : normalizeSceneId(scene)
  let best = -1
  let bestScore = 0
  for (let i = 0; i < list.length; i += 1) {
    if (want !== null && sceneOf(list[i]) !== want) continue
    const score = similarity(list[i]?.text ?? '', text)
    if (score >= threshold && score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

/**
 * 记忆编号：`M-001` 这种形式。
 *
 * 为什么带横杠：会话档案用 `C001`，两套编号都进上下文，`M001` 和 `C001`
 * 一眼扫过去只差一个字母，撞的是人的眼睛。横杠是最便宜的区分。
 * 编号一旦给出**不再复用** —— 复用了，`read M-003` 就可能取到另一条东西。
 */
export const MEMORY_ID_PREFIX = 'M-'

export function formatMemoryId(seq) {
  const n = Math.max(1, Math.floor(Number(seq) || 1))
  return `${MEMORY_ID_PREFIX}${String(n).padStart(3, '0')}`
}

/** 从编号反解序号；认不出来回 0（调用方据此判「没有这个编号」）。 */
export function parseMemoryId(id) {
  const text = String(id ?? '').trim()
  const match = /^M-(\d{1,6})$/i.exec(text)
  return match ? Math.max(0, Number(match[1])) : 0
}

/**
 * 记忆文本归一：换行压成空格，再去首尾空白、截到 300 字。
 *
 * 为什么必须压换行：正文是按「一行一条」的形态进系统提示的，条目里带一个换行
 * 就能在提示里多伪造出一行（结构注入），JSON 里夹着转义也更费 token。
 * 这条通道本来只放一句话，不是文档 —— 压掉不丢信息。
 */
export function cleanMemoryText(value) {
  return String(value ?? '').replace(/\s*[\r\n]+\s*/gu, ' ').trim().slice(0, 300)
}

/** 权重：默认 1；只允许往下折（计数晋升的 0.7），不接受模型随手调高。 */
function normalizeWeight(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.min(1, n)
}

/** 「这条在哪些场景出现过」：计数晋升和降级全靠它。最多记 8 个场景。 */
function normalizeSeenIn(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (!isObject(item)) continue
    const id = normalizeSceneId(item.id)
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      count: Math.max(0, Math.floor(Number(item.count) || 0)),
      lastSession: Math.max(0, Math.floor(Number(item.lastSession) || 0)),
    })
    if (out.length >= 8) break
  }
  return out
}

/** 整条记忆归一化：兼容 v3 的字符串与 { text, at, session } 老形状。 */
export function normalizeEntry(raw, kind, now = Date.now()) {
  const source = typeof raw === 'string' ? { text: raw } : isObject(raw) ? raw : null
  if (!source) return null
  const text = cleanMemoryText(source.text)
  if (text === '' || ENTRY_JUNK.test(text)) return null
  const session = Math.max(0, Math.floor(Number(source.session) || 0))
  return {
    // 编号：老条目没有就留空，由 state 迁移时补（这里不凭空造，免得每次读盘都换号）。
    id: typeof source.id === 'string' && source.id !== '' ? source.id : '',
    // 发号时间：补号时写一次，之后原样带着。不保留它，normalize 两次就不相等了。
    idIssuedAt: Number(source.idIssuedAt) || 0,
    // 场景（记忆分层 P0）：这条属于哪一层。老条目没有这个字段，读的时候一律算主人层
    // ——迁移不猜归属，猜错会把项目细节塞进闲聊。
    scene: normalizeSceneId(source.scene),
    // 第一次落在哪（P3）：降级要降回「出现最多的那个场景」，没有它就回不去。
    originScene: normalizeSceneId(source.originScene ?? source.scene),
    // 升过级没有、为什么升的（P3）：explicit / category / count / manual。
    elevatedBy: ELEVATED_BY.includes(source.elevatedBy) ? source.elevatedBy : '',
    // 权重：靠计数升上去的打七折，其余 1。只影响排序，不影响存不存。
    weight: normalizeWeight(source.weight),
    // 这条在哪些场景出现过、各几次（P3）。
    seenIn: normalizeSeenIn(source.seenIn),
    demotedAt: Number(source.demotedAt) || 0,
    text,
    at: Number(source.at) || now,
    session,
    lastSeenAt: Number(source.lastSeenAt) || Number(source.at) || now,
    lastSeenSession: Math.max(0, Math.floor(Number(source.lastSeenSession) || session)),
    salience: clamp01(source.salience, BASE_SALIENCE[kind] ?? 0.5),
    hits: Math.max(1, Math.floor(Number(source.hits) || 1)),
    // 做完的事不再往摘要里钻，但还留着（人问「上次那件事」时要想得起来）。
    resolved: source.resolved === true,
    // 已经升进长期层的，不再和短期记忆抢那四个位置（否则摘要里会出现两遍）。
    promoted: source.promoted === true,
    // 升进长期层那一刻：短期条目此后从池里移除，这个字段是它「去过哪」的凭据。
    promotedAt: Number(source.promotedAt) || 0,
    // 来源：{session, turn} 或压缩档案 blockId。拿不到就是 null —— 允许空，不许编造。
    ref: isObject(source.ref) ? source.ref : null,
    // 被挤出时写入。挤出不是静默删除：理由得留下来，否则查不出「为什么它没了」。
    evictedAt: Number(source.evictedAt) || 0,
    evictedReason: typeof source.evictedReason === 'string' ? source.evictedReason.slice(0, 80) : '',
  }
}

/** 记忆的「值得想起来」程度：重要度 × 新鲜度 × 权重。陈旧不是删除，只是降权。 */
export function scoreEntry(entry, session = 0) {
  const salience = clamp01(entry?.salience, 0.3)
  const gap = Math.max(0, Number(session) - Number(entry?.lastSeenSession ?? 0))
  const freshness = 1 - 0.4 * Math.min(1, gap / 80)
  return salience * freshness * normalizeWeight(entry?.weight)
}

function lowestIndex(list, session, scene = null) {
  const want = scene === null ? null : normalizeSceneId(scene)
  let index = -1
  let lowest = Infinity
  for (let i = 0; i < list.length; i += 1) {
    if (want !== null && sceneOf(list[i]) !== want) continue
    // 「明确说过」的那一类只能人删（P3）：容量满了也不拿它顶位置。
    if (list[i]?.elevatedBy === 'explicit') continue
    const score = scoreEntry(list[i], session)
    if (score < lowest) {
      lowest = score
      index = i
    }
  }
  return index
}

/**
 * 这一笔该落哪一层（P3 规则二：按类别）。
 *
 * 偏好默认升主人层（「喜欢深色主题」跟哪个项目无关）；但偏好里点名了
 * 项目名、路径，或者说「这个项目」的，留在项目层——不能因为它带「喜欢」
 * 两个字就升上去，那会把项目口味写成通用口味。
 */
export function planWriteScene(kind, scene, text, scenes = null) {
  const current = normalizeSceneId(scene)
  if (kind !== 'preferences') return current
  if (!current.startsWith('project:')) return current
  return mentionsProject(text, current, scenes) ? current : SCENE_OWNER
}

/**
 * 这段字是不是在说「当前这个项目」。
 *
 * 只看确定的线索：项目名、它的目录、以及「这个项目 / 本项目 / 这个仓库」这类指代。
 * 技术栈这种半确定的东西不猜——猜错了没人知道为什么，归类就没法修。
 */
export function mentionsProject(text, scene, scenes = null) {
  const body = String(text ?? '').toLowerCase()
  if (body === '') return false
  if (/这个项目|本项目|这个仓库|当前项目|本项目里/u.test(body)) return true
  const project = (Array.isArray(scenes?.projects) ? scenes.projects : []).find((item) => item?.id === scene)
  const name = String(project?.name ?? '').trim() || String(scene).slice('project:'.length)
  if (name !== '' && body.includes(name.toLowerCase())) return true
  for (const dir of Array.isArray(project?.dirs) ? project.dirs : []) {
    const value = String(dir ?? '').trim().toLowerCase()
    if (value !== '' && body.includes(value)) return true
  }
  return false
}

/** 一字不差的同一条，可能出现在别的场景——这是计数晋升的前提。 */
function findSameAcrossScenes(list, text) {
  if (!Array.isArray(list)) return -1
  const key = memoryKey(text)
  if (key === '') return -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (memoryKey(list[i]?.text ?? '') === key) return i
  }
  return -1
}

/** 记一笔「这条又在这个场景出现了一次」。 */
export function noteAppearance(entry, scene, session = 0, now = Date.now()) {
  if (!isObject(entry)) return null
  const id = normalizeSceneId(scene)
  const seen = Array.isArray(entry.seenIn) ? entry.seenIn : (entry.seenIn = [])
  let row = seen.find((item) => item.id === id)
  if (row) {
    row.count = Math.max(0, Number(row.count) || 0) + 1
    row.lastSession = Math.max(Number(row.lastSession) || 0, session)
  } else {
    row = { id, count: 1, lastSession: Math.max(0, session) }
    seen.push(row)
  }
  seen.sort((a, b) => b.count - a.count)
  while (seen.length > 8) seen.pop()
  return row
}

/**
 * 计数晋升（P3 规则三）：同一条在两个以上不同场景出现过，升到它们的共同父节点。
 *
 * 三个前提缺一不可：打七折、参与常规衰减、能降回来。只有「升级」没有后两条，
 * 它就会变成「学了一堆自以为是的通用规矩」。
 *
 * 共同父节点是项目通用层时受硬上限（50）管：满了不自己丢，返回 blocked，
 * 由调用方提请求让人决定。
 */
export function elevateByCount(entry, options = {}) {
  if (!isObject(entry)) return null
  const { list = null, generalCap = GENERAL_CAP } = options
  const seen = Array.isArray(entry.seenIn) ? entry.seenIn : []
  const distinct = seen.filter((item) => Number(item.count) > 0).map((item) => item.id)
  if (distinct.length < 2) return null
  const target = sceneCommonAncestor(distinct)
  if (target === entry.scene) {
    // 已经在共同父节点，之后又在别的场景出现：第二次证据，恢复权重。
    if (entry.elevatedBy === 'count') entry.weight = 1
    return null
  }
  if (target === SCENE_WORK_GENERAL && Array.isArray(list) && countInScene(list, target) >= generalCap) {
    return { blocked: true, scene: target, text: entry.text, id: entry.id ?? '' }
  }
  const from = entry.scene
  entry.scene = target
  entry.elevatedBy = 'count'
  entry.weight = COUNT_WEIGHT
  return { from, to: target, text: entry.text }
}

/**
 * 降级检查（P3）：靠计数升上去的，别的场景不再提起了，就降回出现最多的那个场景。
 *
 * 降级不是删除：编号不变，正文不变，只是不再占通用层的位置。
 * 判据是「别的场景最后一次提到距今超过 staleSessions 轮」，不是一个隐藏的分数。
 */
export function reevaluateElevations(state, options = {}) {
  const {
    session = 0,
    now = Date.now(),
    staleSessions = DOWNGRADE_STALE_SESSIONS,
  } = options
  const changes = []
  if (!isObject(state)) return changes
  const visit = (entry, scope, kind) => {
    if (!isObject(entry) || entry.elevatedBy !== 'count') return
    const seen = Array.isArray(entry.seenIn) ? [...entry.seenIn].sort((a, b) => b.count - a.count) : []
    if (seen.length === 0) return
    const othersFresh = seen
      .slice(1)
      .some((item) => Number(item.lastSession) > Number(session) - staleSessions)
    if (seen.length >= 2 && othersFresh) return
    const target = normalizeSceneId(seen[0].id)
    if (target === entry.scene) return
    changes.push({ id: entry.id, text: entry.text, kind, scope, from: entry.scene, to: target })
    entry.scene = target
    entry.elevatedBy = ''
    entry.weight = 1
    entry.demotedAt = now
  }
  for (const kind of MEMORY_KINDS) {
    for (const entry of state.memory?.[kind] ?? []) visit(entry, 'short', kind)
  }
  for (const entry of state.longMemory ?? []) visit(entry, 'long', entry.kind ?? 'facts')
  return changes
}

/**
 * 写入一条记忆。重复的合并（不新增条目），满了淘汰最淡的一条。
 * 返回 { status, index, evicted, elevation }，status 是 added / bumped / skipped。
 *
 * 名额是按池子算的（P0）：`cap` 是「这个场景最多几条」，不是「这一类总共几条」。
 * 一个话多的人刷满自己的池子，不该把别的场景的记忆顶掉。
 */
export function addMemory(list, text, options = {}) {
  const {
    kind = 'facts',
    now = Date.now(),
    session = 0,
    cap = 200,
    ref = null,
    tombstones = null,
    scene = SCENE_OWNER,
  } = options
  if (!Array.isArray(list)) return { status: 'skipped', index: -1, evicted: null }
  const pool = normalizeSceneId(scene)
  const clean = cleanMemoryText(text)
  if (clean === '') return { status: 'skipped', index: -1, evicted: null }

  // ① 一字不差的同一条，先看整张表里有没有（可能出现在别的场景）：
  //    那算「同一件事在两个场景出现」，把这次记到它身上（P3 计数晋升的前提）。
  const same = findSameAcrossScenes(list, clean)
  if (same >= 0) {
    const entry = list[same]
    entry.hits = Math.max(1, Number(entry.hits) || 1) + 1
    entry.salience = clamp01(Number(entry.salience) + HIT_GAIN, BASE_SALIENCE[kind] ?? 0.5)
    entry.lastSeenAt = now
    entry.lastSeenSession = session
    // 合并只补不换：来源是「第一次说这件事」的那一轮，后来的重复不该把指针挪走。
    if (!isObject(entry.ref) && isObject(ref)) entry.ref = ref
    noteAppearance(entry, pool, session, now)
    const elevation = elevateByCount(entry, { list })
    return { status: 'bumped', index: same, evicted: null, elevation }
  }

  // ② 去重只在同一个池子里比（P1）：不同项目里措辞很像的两句话是两件事，不是重复。
  const existing = findSimilarInScene(list, clean, pool)
  if (existing >= 0) {
    const entry = list[existing]
    entry.hits = Math.max(1, Number(entry.hits) || 1) + 1
    entry.salience = clamp01(Number(entry.salience) + HIT_GAIN, BASE_SALIENCE[kind] ?? 0.5)
    entry.lastSeenAt = now
    entry.lastSeenSession = session
    // 合并只补不换：来源是「第一次说这件事」的那一轮，后来的重复不该把指针挪走。
    // 老条目没有来源时，这次补上（升级前写的条目就是这种情况）。
    if (!isObject(entry.ref) && isObject(ref)) entry.ref = ref
    // 这条的归属跟着它自己走：在另一个场景听到同一句话，不改第一条的归属（P0 不改行为，
    // 跨场景计数是 P3 的事）。
    if (typeof entry.scene !== 'string' || entry.scene === '') entry.scene = pool
    // 这次说的更完整就换用新的措辞，但仍然只占一条。
    if (clean.length > String(entry.text).length + 4) entry.text = clean
    return { status: 'bumped', index: existing, evicted: null }
  }

  list.push({
    text: clean,
    // 场景：没给就是主人层。
    scene: pool,
    // 第一次落在哪（P3）：降级要降回它。
    originScene: pool,
    elevatedBy: '',
    weight: 1,
    seenIn: [{ id: pool, count: 1, lastSession: Math.max(0, session) }],
    at: now,
    session,
    lastSeenAt: now,
    lastSeenSession: session,
    salience: BASE_SALIENCE[kind] ?? 0.5,
    hits: 1,
    // 来源指针：`{ session, turn, seq }`。seq 指回会话事件，取原文靠它；
    // 拿不到就是 null，不许编一个「大概在哪」。
    ref: isObject(ref) ? ref : null,
  })

  let evicted = null
  while (countInScene(list, pool) > cap) {
    const index = lowestIndex(list, session, pool)
    if (index < 0) break
    const gone = list[index]
    evicted = gone.text
    // 短期池里条目不带类别（类别是列表本身），墓碑补上，不然查回来不知道当时算哪类。
    pushTombstone(tombstones, { ...gone, kind }, { reason: 'cap', now, session })
    list.splice(index, 1)
  }
  return { status: 'added', index: list.length - 1, evicted }
}

/**
 * 遗忘：每轮把没被提到的记忆调淡一点，池子超过八成时清掉已经淡到没意义的那几条。
 * 返回被清掉的条目文本，供审计。
 *
 * 名额按池子算（P0）：某一道池子挤了，只清那道池子里最淡的；别的池子不受牵连。
 */
export function fadeMemory(list, options = {}) {
  const { session = 0, rate = 0.02, cap = 200, touched = [], tombstones = null, kind = '' } = options
  const forgotten = []
  if (!Array.isArray(list)) return forgotten
  const touchedSet = new Set(touched.map((item) => memoryKey(item)))
  for (const entry of list) {
    if (touchedSet.has(memoryKey(entry.text))) continue
    // 「明确说过，以后都这样」的不衰减（P3）：它只能人删。
    if (entry.elevatedBy === 'explicit') continue
    const before = Number(entry.salience) || 0
    entry.salience = clamp01(before * (1 - rate), before)
  }
  const sizes = new Map()
  for (const entry of list) {
    const pool = sceneOf(entry)
    sizes.set(pool, (sizes.get(pool) ?? 0) + 1)
  }
  for (const [pool, size] of sizes) {
    if (size <= cap * 0.8) continue
    let remaining = size
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (remaining <= cap * 0.6) break
      if (sceneOf(list[i]) !== pool) continue
      if (Number(list[i].salience) < FADE_FLOOR) {
        forgotten.push(list[i].text)
        pushTombstone(tombstones, { ...list[i], kind }, { reason: 'faded', session })
        list.splice(i, 1)
        remaining -= 1
      }
    }
  }
  return forgotten
}

/**
 * 检索：跨类别按分数取前 limit 条，返回 [{kind, text, score, tier, scene}]。
 *
 * `scene`（P2）是「现在在哪」：候选按距离加权，越近越先被想起来；
 * 另一枝（别的项目、别的群）默认不冒出来，除非这句话真的问到它（召回命中）。
 */
export function selectMemory(memory, options = {}) {
  const {
    session = 0,
    limit = 4,
    kinds = ['facts', 'preferences', 'events'],
    query = '',
    tiered = true,
    scene = null,
  } = options
  const current = normalizeSceneId(scene ?? SCENE_OWNER)
  const out = []
  for (const kind of kinds) {
    const list = memory?.[kind]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry.resolved || entry.promoted) continue
      const base = scoreEntry(entry, session)
      if (base < FADE_FLOOR) continue
      const entryScene = sceneOf(entry)
      const relation = sceneRelation(current, entryScene)
      // lastSeenSession 一起带出去：分档要判「多久没被提起」，没有它就判不了无权重。
      out.push({
        kind,
        text: entry.text,
        score: base * sceneWeight(relation),
        lastSeenSession: Number(entry.lastSeenSession) || 0,
        scene: entryScene,
        onBranch: relation.onChain,
        distance: relation.distance,
      })
    }
  }
  // 先召回（这句话在问什么），后排序（存量分）。没有 query 时退回纯排序。
  // 槽位给满：另一枝的条目要等召回结果出来才知道该留还是该丢，
  // 先按 limit 切会把位置浪费在随后被丢掉的那些上。
  const budget = out.length > 0 ? out.length : limit
  const { picked } = recallThenRank(out, { query, limit: budget })
  // 另一枝的条目：只有这句话明确提到（召回命中 > 0）才允许出现。
  const onBranch = picked.filter((item) => item.onBranch || Number(item.recallHit) > 0)
  const chosen = onBranch.slice(0, Math.max(0, limit))
  if (!tiered) return chosen
  // 分档：无权重的不进注入（只在取回工具里出现），其余带上档位标记。
  const { kept } = splitByTier(chosen, { session })
  return kept
}

/**
 * 把一件事标记为「做完了」。不是删除：分数砍半，从此不再进摘要，
 * 但还在状态里，人问起时仍能翻到。
 */
export function resolveMemory(list, text, options = {}) {
  if (!Array.isArray(list)) return null
  const { session = 0, scene = null } = options
  // 也只在同一个池子里找（P1）：A 项目说「这件事做完了」，不该把 B 项目里的同名事结掉。
  const index = findSimilarInScene(list, text, scene, 0.6)
  if (index < 0) return null
  const entry = list[index]
  if (entry.resolved) return null
  entry.resolved = true
  entry.salience = clamp01(Number(entry.salience) * 0.5, 0)
  entry.lastSeenSession = Math.max(Number(entry.lastSeenSession) || 0, session)
  return entry.text
}

/**
 * 长期记忆：从短期层里升上来的那部分。
 *
 * 短期层靠「重要度 × 新鲜度」抢那四个位置，久远但重要的事很容易被最近的正事挤掉——
 * 一个人不会因为最近在忙别的，就忘了你去年说过的话。
 * 所以再分一层：
 *   - 反复被提到（hits ≥ 3）的，说明它一直在回来；
 *   - 结构性的事实（底线、答应过的事）本来就不是「琐事」，直接进；
 *   - 人也可以手动钉住一条，等于直接说「这个重要」。
 * 进了长期层就不衰减，但也不无限堆：满了先淘汰没钉住、最久没被提起的那条。
 */

/** 被提到几次才算「一直在回来」。 */
export const PROMOTE_HITS = 3

/**
 * 从各种形状里取出一句话。
 * 记忆条目是对象、底线是对象、转录是字符串——混着来，取错了就会写出 "[object Object]"。
 */
export function entryText(item) {
  if (typeof item === 'string') return item
  if (!isObject(item)) return ''
  return typeof item.text === 'string' ? item.text : ''
}

export function normalizeLong(raw, now = Date.now()) {
  const source = typeof raw === 'string' ? { text: raw } : isObject(raw) ? raw : null
  if (!source) return null
  const text = cleanMemoryText(source.text)
  if (text === '' || ENTRY_JUNK.test(text)) return null
  const session = Math.max(0, Math.floor(Number(source.session) || 0))
  return {
    id: typeof source.id === 'string' && source.id !== '' ? source.id : '',
    idIssuedAt: Number(source.idIssuedAt) || 0,
    // 长期层也分场景：升上去的时候把归属一起带过来，否则「她是哪个项目的」这一层就丢了。
    scene: normalizeSceneId(source.scene),
    originScene: normalizeSceneId(source.originScene ?? source.scene),
    elevatedBy: ELEVATED_BY.includes(source.elevatedBy) ? source.elevatedBy : '',
    weight: normalizeWeight(source.weight),
    seenIn: normalizeSeenIn(source.seenIn),
    demotedAt: Number(source.demotedAt) || 0,
    text,
    kind: ['facts', 'preferences', 'events', 'openTopics', 'boundaries', 'commitments'].includes(source.kind)
      ? source.kind
      : 'facts',
    at: Number(source.at) || now,
    session,
    lastSeenAt: Number(source.lastSeenAt) || Number(source.at) || now,
    lastSeenSession: Math.max(0, Math.floor(Number(source.lastSeenSession) || session)),
    hits: Math.max(1, Math.floor(Number(source.hits) || 1)),
    pinned: source.pinned === true,
    // 长期层是「能取回原文」的那一层，所以 ref 更要紧：这里允许 null，但不许编造。
    ref: isObject(source.ref) ? source.ref : null,
    // 升上来那一刻。晋升不留两份，短条目已经移除，这一格是它「从哪来」的唯一凭据。
    promotedAt: Number(source.promotedAt) || 0,
    evictedAt: Number(source.evictedAt) || 0,
    evictedReason: typeof source.evictedReason === 'string' ? source.evictedReason.slice(0, 80) : '',
  }
}

/**
 * 给还没有编号的条目补号，返回 { state, assigned }。
 *
 * 编号是取回的钥匙（`M-003` → 原文），所以两条硬规则：
 *   1. **只增不回收**：发号器 `state.memorySeq` 只往上走，删掉的条目不会把号让出来；
 *   2. **老条目按原顺序补**：升级前落的条目没有号，补的时候按当前顺序发，
 *      不按时间戳重排 —— 重排会让「我记得的第 3 条」变成另一条。
 */
export function assignMemoryIds(state, now = Date.now()) {
  if (!isObject(state)) return { state, assigned: [] }
  const assigned = []
  let seq = Math.max(0, Math.floor(Number(state.memorySeq) || 0))

  const taken = new Set()
  const visit = (list) => {
    if (!Array.isArray(list)) return
    for (const entry of list) {
      if (!isObject(entry)) continue
      if (typeof entry.id === 'string' && entry.id !== '' && !taken.has(entry.id)) {
        taken.add(entry.id)
        const n = parseMemoryId(entry.id)
        if (n > seq) seq = n
      }
    }
  }
  for (const kind of MEMORY_KINDS) visit(state.memory?.[kind])
  visit(state.longMemory)

  const fill = (list) => {
    if (!Array.isArray(list)) return
    for (const entry of list) {
      if (!isObject(entry)) continue
      if (typeof entry.id === 'string' && entry.id !== '') continue
      seq += 1
      entry.id = formatMemoryId(seq)
      if (!Number(entry.idIssuedAt)) entry.idIssuedAt = now
      assigned.push({ id: entry.id, text: entry.text })
    }
  }
  for (const kind of MEMORY_KINDS) fill(state.memory?.[kind])
  fill(state.longMemory)

  state.memorySeq = seq
  return { state, assigned }
}

/** 全部记忆条目（短期四类 + 长期层），带类别与编号。取回工具和分档都从这里读。 */
export function allMemoryEntries(state) {
  const out = []
  if (!isObject(state)) return out
  for (const kind of MEMORY_KINDS) {
    for (const entry of state.memory?.[kind] ?? []) {
      if (isObject(entry)) out.push({ kind, scope: 'short', entry })
    }
  }
  for (const entry of state.longMemory ?? []) {
    if (isObject(entry)) out.push({ kind: entry.kind ?? 'facts', scope: 'long', entry })
  }
  return out
}

/** 按编号取一条（短期与长期都查）。取回工具的唯一入口。 */
export function findMemoryById(state, id) {
  const want = String(id ?? '').trim().toUpperCase()
  if (want === '') return null
  for (const item of allMemoryEntries(state)) {
    if (String(item.entry.id ?? '').toUpperCase() === want) return item
  }
  return null
}

/**
 * 长期层里最该记住的几条：钉住的优先，其次看最近被提起的时间。
 *
 * `scene`（P2）：只取落在当前场景这条链上的（含主人层）。别的项目钉住的事
 * 不该在这个项目里常驻——那样分层就白做了。
 */
export function selectLong(longList, limit = 3, options = {}) {
  if (!Array.isArray(longList)) return []
  const scene = normalizeSceneId(options?.scene ?? SCENE_OWNER)
  return [...longList]
    .filter((entry) => sceneRelation(scene, sceneOf(entry)).onChain)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (Number(b.lastSeenSession) || 0) - (Number(a.lastSeenSession) || 0)
    })
    .slice(0, limit)
}

/** 腾位置：同一道池子里挑没钉住、最久没被提起的那条。全都被钉住就放弃这次晋升。 */
function evictLong(long, options = {}) {
  const {
    now = Date.now(),
    reason = 'long-full',
    tombstones = null,
    session = 0,
    scene = SCENE_OWNER,
  } = options
  const pool = normalizeSceneId(scene)
  let index = -1
  let oldest = Infinity
  for (let i = 0; i < long.length; i += 1) {
    if (sceneOf(long[i]) !== pool) continue
    if (long[i].pinned) continue
    const seen = Number(long[i].lastSeenSession) || 0
    if (seen < oldest) {
      oldest = seen
      index = i
    }
  }
  if (index < 0) return null
  const gone = long[index]
  // 挤出不是静默删除：墓碑先落，条目再移走。写在条目上的理由会跟着条目一起没掉。
  pushTombstone(tombstones, gone, { reason, now, session })
  long.splice(index, 1)
  return gone?.text ?? ''
}

/**
 * 把够格的东西从短期层升进长期层。幂等：已经升过的会被标记，不会重复晋升。
 * 返回这次新升上去的文本，供审计。
 *
 * **晋升不留两份**：升上去之后短条目从池里移除，只留 `promotedAt` 作凭据。
 * 以前只标 `promoted: true` 还留着占容量，等于同一件事占两个名额。
 */
export function promoteMemory(state, options = {}) {
  const { session = 0, now = Date.now(), cap = 40 } = options
  if (!isObject(state)) return []
  const long = Array.isArray(state.longMemory) ? state.longMemory : (state.longMemory = [])
  const tombstones = tombstonesOf(state)
  const added = []

  const consider = (text, kind, hits, at, lastSeenSession, extra = {}) => {
    const clean = cleanMemoryText(text)
    if (clean === '') return false
    // 长期层的名额也按池子算：升上去的条目把归属一起带过来。
    const pool = normalizeSceneId(extra.scene)
    if (findSimilarInScene(long, clean, pool, 0.75) >= 0) return true // 已经在里面，算成功
    if (countInScene(long, pool) >= cap) {
      evictLong(long, { now, reason: 'long-full', tombstones, session, scene: pool })
      if (countInScene(long, pool) >= cap) return false
    }
    long.push({
      // 编号跟着条目走：升上去之后 `read M-003` 还得能取到同一件事。
      id: typeof extra.id === 'string' ? extra.id : '',
      idIssuedAt: Number(extra.idIssuedAt) || now,
      scene: pool,
      // 归属一起搬过去：升到长期层不该把「它在哪个场景、为什么在这层」丢掉。
      originScene: normalizeSceneId(extra.originScene ?? pool),
      elevatedBy: ELEVATED_BY.includes(extra.elevatedBy) ? extra.elevatedBy : '',
      weight: normalizeWeight(extra.weight),
      seenIn: normalizeSeenIn(extra.seenIn),
      text: clean,
      kind,
      at: Number(at) || now,
      session,
      lastSeenAt: now,
      lastSeenSession: Math.max(Number(lastSeenSession) || 0, session),
      hits: Math.max(1, Math.floor(Number(hits) || 1)),
      pinned: false,
      // 来源也一起带过去，否则升上去就成了「查不到原话」的那一层。
      ref: isObject(extra.ref) ? extra.ref : null,
      promotedAt: now,
      evictedAt: 0,
      evictedReason: '',
    })
    added.push(clean)
    return true
  }

  for (const kind of MEMORY_KINDS) {
    const list = state.memory?.[kind]
    if (!Array.isArray(list)) continue
    const kept = []
    for (const entry of list) {
      if (entry.promoted) {
        // 上一版只标了 promoted 还留着的老条目：这次一并清掉。
        continue
      }
      if (Number(entry.hits) < PROMOTE_HITS) {
        kept.push(entry)
        continue
      }
      const ok = consider(entry.text, kind, entry.hits, entry.at, entry.lastSeenSession, {
        id: entry.id,
        idIssuedAt: entry.idIssuedAt,
        ref: entry.ref,
        scene: sceneOf(entry),
        originScene: entry.originScene,
        elevatedBy: entry.elevatedBy,
        weight: entry.weight,
        seenIn: entry.seenIn,
      })
      // 升上去了就从池里移除：同一件事不该占两个名额。
      if (!ok) kept.push(entry)
    }
    if (kept.length !== list.length) state.memory[kind] = kept
  }

  // 底线和答应过的事不是「记性好不好的问题」，是账。到期、退场由它们自己的规则管。
  // v6：边界写在内核配置里，不再从状态提升；承诺已迁到顶层。
  for (const item of state.commitments ?? []) {
    if (item?.status === 'done') continue
    consider(item.text, 'commitments', 1, item.at, session)
  }

  return added
}

/** 人手动钉住一条（或取消钉住）。钉住等于直接告诉它：这条别忘。 */
export function pinLong(longList, text, options = {}) {
  const {
    pinned = true,
    kind = 'facts',
    cap = 40,
    session = 0,
    now = Date.now(),
    ref = null,
    tombstones = null,
    scene = SCENE_OWNER,
    // 「明确说过」这类（P3）：不衰减、只能人删。理由也一起带过去。
    elevatedBy = '',
    originScene = null,
  } = options
  const pool = normalizeSceneId(scene)
  if (!Array.isArray(longList)) return null
  const clean = cleanMemoryText(text)
  if (clean === '') return null
  // 钉住也只在同一个池子里认：两个池子里各有一条同文，是两件事。
  const index = findSimilarInScene(longList, clean, pool, 0.75)
  if (index >= 0) {
    longList[index].pinned = pinned === true
    if (ELEVATED_BY.includes(elevatedBy) && elevatedBy !== '') longList[index].elevatedBy = elevatedBy
    // 老条目没来源时补上，别让「钉住」把来源弄丢。
    if (!isObject(longList[index].ref) && isObject(ref)) longList[index].ref = ref
    return longList[index]
  }
  if (pinned !== true) return null
  if (countInScene(longList, pool) >= cap) {
    evictLong(longList, { now, reason: 'long-full', tombstones, session, scene: pool })
    if (countInScene(longList, pool) >= cap) return null
  }
  const entry = normalizeLong(
    {
      text: clean,
      kind,
      at: now,
      session,
      hits: 1,
      pinned: true,
      ref,
      scene: pool,
      originScene: originScene ?? pool,
      elevatedBy: ELEVATED_BY.includes(elevatedBy) ? elevatedBy : '',
      seenIn: [{ id: pool, count: 1, lastSession: Math.max(0, session) }],
    },
    now,
  )
  longList.push(entry)
  return entry
}

/** 删掉一条长期记忆（只有人类能删）。 */
export function forgetLong(longList, text) {
  if (!Array.isArray(longList)) return null
  const index = findSimilar(longList, text, 0.6)
  if (index < 0) return null
  return longList.splice(index, 1)[0]?.text ?? null
}

export { DUP_THRESHOLD }

/** 某个类别的完整列表，按分数排序（设置页展示用）。 */
export function listMemory(memory, kind, session = 0) {
  const list = Array.isArray(memory?.[kind]) ? memory[kind] : []
  return [...list]
    .map((entry, index) => ({
      index,
      text: entry.text,
      salience: Number(Number(entry.salience).toFixed(3)),
      score: Number(scoreEntry(entry, session).toFixed(3)),
      hits: entry.hits,
      resolved: entry.resolved === true,
      at: entry.at,
      session: entry.session,
    }))
    .sort((a, b) => b.score - a.score)
}
