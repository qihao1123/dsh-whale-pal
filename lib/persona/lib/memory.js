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

export const MEMORY_KINDS = ['facts', 'preferences', 'events', 'openTopics']

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
  if (!Array.isArray(list)) return -1
  let best = -1
  let bestScore = 0
  for (let i = 0; i < list.length; i += 1) {
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

/** 整条记忆归一化：兼容 v3 的字符串与 { text, at, session } 老形状。 */
export function normalizeEntry(raw, kind, now = Date.now()) {
  const source = typeof raw === 'string' ? { text: raw } : isObject(raw) ? raw : null
  if (!source) return null
  const text = String(source.text ?? '').trim().slice(0, 300)
  if (text === '' || ENTRY_JUNK.test(text)) return null
  const session = Math.max(0, Math.floor(Number(source.session) || 0))
  return {
    // 编号：老条目没有就留空，由 state 迁移时补（这里不凭空造，免得每次读盘都换号）。
    id: typeof source.id === 'string' && source.id !== '' ? source.id : '',
    // 发号时间：补号时写一次，之后原样带着。不保留它，normalize 两次就不相等了。
    idIssuedAt: Number(source.idIssuedAt) || 0,
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

/** 记忆的「值得想起来」程度：重要度 × 新鲜度。陈旧不是删除，只是降权。 */
export function scoreEntry(entry, session = 0) {
  const salience = clamp01(entry?.salience, 0.3)
  const gap = Math.max(0, Number(session) - Number(entry?.lastSeenSession ?? 0))
  const freshness = 1 - 0.4 * Math.min(1, gap / 80)
  return salience * freshness
}

function lowestIndex(list, session) {
  let index = -1
  let lowest = Infinity
  for (let i = 0; i < list.length; i += 1) {
    const score = scoreEntry(list[i], session)
    if (score < lowest) {
      lowest = score
      index = i
    }
  }
  return index
}

/**
 * 写入一条记忆。重复的合并（不新增条目），满了淘汰最淡的一条。
 * 返回 { status, index, evicted }，status 是 added / bumped / skipped。
 */
export function addMemory(list, text, options = {}) {
  const { kind = 'facts', now = Date.now(), session = 0, cap = 200, ref = null } = options
  if (!Array.isArray(list)) return { status: 'skipped', index: -1, evicted: null }
  const clean = String(text ?? '').trim().slice(0, 300)
  if (clean === '') return { status: 'skipped', index: -1, evicted: null }

  const existing = findSimilar(list, clean)
  if (existing >= 0) {
    const entry = list[existing]
    entry.hits = Math.max(1, Number(entry.hits) || 1) + 1
    entry.salience = clamp01(Number(entry.salience) + HIT_GAIN, BASE_SALIENCE[kind] ?? 0.5)
    entry.lastSeenAt = now
    entry.lastSeenSession = session
    // 合并只补不换：来源是「第一次说这件事」的那一轮，后来的重复不该把指针挪走。
    // 老条目没有来源时，这次补上（升级前写的条目就是这种情况）。
    if (!isObject(entry.ref) && isObject(ref)) entry.ref = ref
    // 这次说的更完整就换用新的措辞，但仍然只占一条。
    if (clean.length > String(entry.text).length + 4) entry.text = clean
    return { status: 'bumped', index: existing, evicted: null }
  }

  list.push({
    text: clean,
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
  while (list.length > cap) {
    const index = lowestIndex(list, session)
    if (index < 0) break
    evicted = list[index].text
    list.splice(index, 1)
  }
  return { status: 'added', index: list.length - 1, evicted }
}

/**
 * 遗忘：每轮把没被提到的记忆调淡一点，容量超过八成时清掉已经淡到没意义的那几条。
 * 返回被清掉的条目文本，供审计。
 */
export function fadeMemory(list, options = {}) {
  const { session = 0, rate = 0.02, cap = 200, touched = [] } = options
  const forgotten = []
  if (!Array.isArray(list)) return forgotten
  const touchedSet = new Set(touched.map((item) => memoryKey(item)))
  for (const entry of list) {
    if (touchedSet.has(memoryKey(entry.text))) continue
    const before = Number(entry.salience) || 0
    entry.salience = clamp01(before * (1 - rate), before)
  }
  if (list.length > cap * 0.8) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list.length <= cap * 0.6) break
      if (Number(list[i].salience) < FADE_FLOOR) {
        forgotten.push(list[i].text)
        list.splice(i, 1)
      }
    }
  }
  return forgotten
}

/** 检索：跨类别按分数取前 limit 条，返回 [{kind, text, score, tier}]。 */
export function selectMemory(memory, options = {}) {
  const { session = 0, limit = 4, kinds = ['facts', 'preferences', 'events'], query = '', tiered = true } = options
  const out = []
  for (const kind of kinds) {
    const list = memory?.[kind]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry.resolved || entry.promoted) continue
      const score = scoreEntry(entry, session)
      if (score < FADE_FLOOR) continue
      // lastSeenSession 一起带出去：分档要判「多久没被提起」，没有它就判不了无权重。
      out.push({ kind, text: entry.text, score, lastSeenSession: Number(entry.lastSeenSession) || 0 })
    }
  }
  // 先召回（这句话在问什么），后排序（存量分）。没有 query 时退回纯排序。
  const { picked } = recallThenRank(out, { query, limit })
  if (!tiered) return picked
  // 分档：无权重的不进注入（只在取回工具里出现），其余带上档位标记。
  const { kept } = splitByTier(picked, { session })
  return kept
}

/**
 * 把一件事标记为「做完了」。不是删除：分数砍半，从此不再进摘要，
 * 但还在状态里，人问起时仍能翻到。
 */
export function resolveMemory(list, text, options = {}) {
  if (!Array.isArray(list)) return null
  const { session = 0 } = options
  const index = findSimilar(list, text, 0.6)
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
  const text = String(source.text ?? '').trim().slice(0, 300)
  if (text === '' || ENTRY_JUNK.test(text)) return null
  const session = Math.max(0, Math.floor(Number(source.session) || 0))
  return {
    id: typeof source.id === 'string' && source.id !== '' ? source.id : '',
    idIssuedAt: Number(source.idIssuedAt) || 0,
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

/** 长期层里最该记住的几条：钉住的优先，其次看最近被提起的时间。 */
export function selectLong(longList, limit = 3) {
  if (!Array.isArray(longList)) return []
  return [...longList]
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (Number(b.lastSeenSession) || 0) - (Number(a.lastSeenSession) || 0)
    })
    .slice(0, limit)
}

/** 腾位置：挑没钉住、最久没被提起的那条。全都被钉住就放弃这次晋升。 */
function evictLong(long, options = {}) {
  const { now = Date.now(), reason = 'long-full' } = options
  let index = -1
  let oldest = Infinity
  for (let i = 0; i < long.length; i += 1) {
    if (long[i].pinned) continue
    const seen = Number(long[i].lastSeenSession) || 0
    if (seen < oldest) {
      oldest = seen
      index = i
    }
  }
  if (index < 0) return null
  const gone = long.splice(index, 1)[0]
  // 挤出不是静默删除：理由留在条目上（连同台账那一行），才查得出「它为什么没了」。
  if (isObject(gone)) {
    gone.evictedAt = now
    gone.evictedReason = reason
  }
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
  const added = []

  const consider = (text, kind, hits, at, lastSeenSession, extra = {}) => {
    const clean = String(text ?? '').trim().slice(0, 300)
    if (clean === '') return false
    if (findSimilar(long, clean, 0.75) >= 0) return true // 已经在里面，算成功
    if (long.length >= cap) {
      evictLong(long, { now, reason: 'long-full' })
      if (long.length >= cap) return false
    }
    long.push({
      // 编号跟着条目走：升上去之后 `read M-003` 还得能取到同一件事。
      id: typeof extra.id === 'string' ? extra.id : '',
      idIssuedAt: Number(extra.idIssuedAt) || now,
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
  const { pinned = true, kind = 'facts', cap = 40, session = 0, now = Date.now() } = options
  if (!Array.isArray(longList)) return null
  const clean = String(text ?? '').trim().slice(0, 300)
  if (clean === '') return null
  const index = findSimilar(longList, clean, 0.75)
  if (index >= 0) {
    longList[index].pinned = pinned === true
    return longList[index]
  }
  if (pinned !== true) return null
  if (longList.length >= cap) {
    evictLong(longList)
    if (longList.length >= cap) return null
  }
  const entry = normalizeLong({ text: clean, kind, at: now, session, hits: 1, pinned: true }, now)
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
