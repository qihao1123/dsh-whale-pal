/**
 * 场景树：一条记忆属于哪一层（记忆分层 P0）。
 *
 * 为什么是树而不是几个平铺的池子：平铺的话，每加一个场景都要重新回答一次
 * 「它和别的场景什么关系」；树上这个问题只有「隔多远」。召回从当前节点往上走，
 * 越近权重越高——这是 P2 的事，这里先把结构定下来。
 *
 * ```
 * 主人（root）
 * ├─ 工作
 * │   ├─ 项目通用        work:general
 * │   └─ 项目 A          project:<名字>
 * ├─ 闲聊                chat
 * ├─ 群聊                group
 * │   └─ 群 1            group:<平台>:<群号>
 * │       └─ 说话人      group:<平台>:<群号>:<人>
 * └─ …外部注册的场景     （谁来挂谁注册，开源包不认识具体是哪一类）
 * ```
 *
 * 两条硬规矩：
 *   1. **没有场景字段的条目一律算主人层。** 老数据全部进主人层，不猜——猜错了
 *      的代价是把项目细节塞进闲聊，全放主人层最多只是多几条用不上的。
 *   2. **场景 id 只是字符串，不做枚举校验。** 未知 id 照样是一个池子；界面（P4）
 *      负责把「树里没有这个节点」标出来，存储层不许因为它不认识就吞掉一条记忆。
 */

import { sceneRegistry } from './scene-registry.js'

/** 根节点：主人层。召回最广，但只该放跨全部场景的东西。 */
export const SCENE_OWNER = 'owner'

/** 项目通用层：做项目时都用的规则、方式。它也是所有项目的父节点。 */
export const SCENE_WORK_GENERAL = 'work:general'

export const SCENE_VERSION = 1

/** 场景清单的容量：够用就行，不是数据主体。 */
const SCENES = Object.freeze({
  projects: 50,
  groups: 200,
  members: 200,
  registered: 20,
})

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * 场景 id 的片段：群号、目录名、人名都可能带冒号或斜杠，
 * 压成安全片段，否则 `group:qq:123:456` 会被拆成四段，父节点就算错。
 */
export function scenePart(value) {
  return String(value ?? '')
    .trim()
    .replace(/[\\/:：*?"<>|\s]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function projectScene(name) {
  const part = scenePart(name)
  return part === '' ? '' : `project:${part}`
}

export function groupScene(platform, groupId) {
  const p = scenePart(platform)
  const g = scenePart(groupId)
  return p === '' || g === '' ? '' : `group:${p}:${g}`
}

export function speakerScene(groupId, speaker) {
  const base = String(groupId ?? '').trim()
  const who = scenePart(speaker)
  if (base === '' || who === '') return ''
  return `${base}:${who}`
}

/** 外部注册的父子关系：开源包不认识具体场景，问注册表。 */
function registeredParent(id) {
  try {
    return sceneRegistry.parentOf(id)
  } catch {
    return null
  }
}

/** 条目属于哪个场景。缺失、空串、非字符串一律算主人层。 */
export function sceneOf(entry) {
  const id = typeof entry?.scene === 'string' ? entry.scene.trim() : ''
  return id === '' ? SCENE_OWNER : id
}

/** 场景 id 归一：给条目写盘前用。不做白名单校验（见文件头第 2 条）。 */
export function normalizeSceneId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 120) : SCENE_OWNER
}

/**
 * 父节点。`owner` 没有父节点，返回 null。
 *
 * 项目往上走是「项目通用」而不是「工作」：方案 §2 的召回路径写的是
 * 「项目 A → 项目通用 → 主人」，所以项目通用是项目的祖先，不是兄弟。
 */
export function parentScene(id) {
  const scene = String(id ?? '').trim()
  if (scene === '' || scene === SCENE_OWNER) return null
  const [axis, ...rest] = scene.split(':')
  if (axis === 'project') return SCENE_WORK_GENERAL
  if (axis === 'work') return SCENE_OWNER
  if (axis === 'group') {
    if (rest.length <= 1) return SCENE_OWNER
    if (rest.length === 2) return `group:${rest[0]}`
    return scene.slice(0, scene.lastIndexOf(':'))
  }
  // 外部注册的场景：谁来挂谁注册，问不到就退回主人层。
  return registeredParent(scene) ?? SCENE_OWNER
}

/** 从自己走到根的整条链，第一个是自己。深度封顶，防脏数据绕成环。 */
export function sceneChain(id) {
  const chain = []
  let current = String(id ?? '').trim() || SCENE_OWNER
  for (let i = 0; i < 8; i += 1) {
    if (chain.includes(current)) break
    chain.push(current)
    const up = parentScene(current)
    if (up === null) break
    current = up
  }
  return chain
}

/**
 * 当前场景和一条记忆的归属是什么关系（P2 召回按距离排序）。
 *
 * - `onChain: true` 表示它在这条「自己 → 父 → 根」的链上，`distance` 是隔了几层；
 * - `onChain: false` 是另一枝（别的项目、别的群），默认不该主动冒出来。
 */
export function sceneRelation(current, candidate) {
  const cur = normalizeSceneId(current)
  const target = normalizeSceneId(candidate)
  if (target === cur) return { onChain: true, distance: 0 }
  const index = sceneChain(cur).indexOf(target)
  if (index >= 0) return { onChain: true, distance: index }
  return { onChain: false, distance: null }
}

/**
 * 距离折算成权重。
 *
 * 当前场景满权；往上每层轻折一点，主人层几乎不折——「越近越高」要成立，
 * 但不能折到「主人层的偏好被项目里一条新鲜事压掉」，那是把分层做成了健忘。
 * 另一枝给一个明显的低权重：只有这句话真的问到它（召回命中）才轮到它。
 */
export function sceneWeight(relation) {
  if (!relation || relation.onChain !== true) return 0.5
  const distance = Math.max(0, Number(relation.distance) || 0)
  return distance === 0 ? 1 : Math.max(0.85, 1 - 0.05 * distance)
}

/**
 * 几个场景的共同父节点（P3 计数晋升用）。
 *
 * 「同一件事在两个项目都出现过，该放到它们的共同父节点」——不是最深的那个，
 * 也不是主人层，是两边都认的那一层。项目 A 和项目 B 的答案是「项目通用」。
 */
export function sceneCommonAncestor(ids) {
  const list = (Array.isArray(ids) ? ids : []).map((id) => sceneChain(id))
  if (list.length === 0) return SCENE_OWNER
  const [first, ...rest] = list
  const common = first.filter((id) => rest.every((chain) => chain.includes(id)))
  // chain 的第一个是自己，所以 common[0] 就是最深的公共节点。
  return common.length > 0 ? common[0] : SCENE_OWNER
}

/** 隔了几层到根：主人层是 0，项目是 2。 */
export function sceneDepth(id) {
  return Math.max(0, sceneChain(id).length - 1)
}

/** 场景说人话：界面和提示词里的「记得」都要能看出来源。 */
export function sceneLabel(id, scenes = null) {
  const scene = normalizeSceneId(id)
  if (scene === SCENE_OWNER) return '主人'
  if (scene === SCENE_WORK_GENERAL) return '项目通用'
  const projects = Array.isArray(scenes?.projects) ? scenes.projects : []
  for (const project of projects) {
    if (project?.id === scene) return String(project.name ?? '').trim() || scene
  }
  const groups = Array.isArray(scenes?.groups) ? scenes.groups : []
  for (const group of groups) {
    if (group?.id === scene) return String(group.name ?? '').trim() || group.groupId || scene
    // 说话人：`group:<平台>:<群号>:<人>`，标成「群 · 人」。
    if (typeof scene === 'string' && scene.startsWith(`${group?.id}:`)) {
      const who = scene.slice(String(group.id).length + 1)
      const base = String(group.name ?? '').trim() || group.groupId || '群'
      return `${base}·${who}`
    }
  }
  // 外部注册的场景：问注册表要显示名。
  if (sceneRegistry.typeOf(scene) !== null) return sceneRegistry.labelOf(scene)
  // 树里没有这个节点：不吞掉，退回 id 的最后一段，人还能看出是哪。
  const parts = scene.split(':')
  return parts[parts.length - 1] || scene
}

/** 初始的场景树。外部场景不写死在这里：谁挂谁注册，节点记在 `external` 里。 */
export function createScenes() {
  return {
    version: SCENE_VERSION,
    root: { id: SCENE_OWNER, label: '主人' },
    projects: [],
    groups: [],
    // 外部注册的类型挂出来的节点：{ id, type, label, createdAt, updatedAt }
    external: [],
    registered: [],
  }
}

function normalizeList(raw, cap) {
  return Array.isArray(raw) ? raw.filter(isObject).slice(-cap) : []
}

function normalizeProject(raw) {
  if (!isObject(raw)) return null
  const name = String(raw.name ?? '').trim().slice(0, 60)
  const id = normalizeSceneId(raw.id ?? (name === '' ? '' : projectScene(name)))
  if (id === SCENE_OWNER || id === '') return null
  const dirs = Array.isArray(raw.dirs)
    ? raw.dirs.map((dir) => String(dir ?? '').trim()).filter((dir) => dir !== '').slice(-20)
    : []
  return {
    id,
    name: name === '' ? id : name,
    dirs,
    // 「名字可改」：这条是界面用的开关，不是权限。改场景名不该改动 id。
    editable: raw.editable !== false,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  }
}

function normalizeGroup(raw) {
  if (!isObject(raw)) return null
  const platform = String(raw.platform ?? '').trim().slice(0, 20)
  const groupId = String(raw.groupId ?? '').trim().slice(0, 60)
  const id = normalizeSceneId(raw.id ?? (platform && groupId ? groupScene(platform, groupId) : ''))
  if (id === SCENE_OWNER || id === '') return null
  const members = Array.isArray(raw.members)
    ? raw.members
        .map((member) => (isObject(member)
          ? { id: scenePart(member.id ?? member.name), name: String(member.name ?? '').trim().slice(0, 40) }
          : { id: scenePart(member), name: String(member ?? '').trim().slice(0, 40) }))
        .filter((member) => member.id !== '' || member.name !== '')
        .slice(-SCENES.members)
    : []
  return {
    id,
    platform,
    groupId,
    name: String(raw.name ?? '').trim().slice(0, 60),
    members,
    // 群记录里存的那条会话编号：宿主建会话时挂不了自定义字段，标记只能存在这边。
    sessionId: String(raw.sessionId ?? '').trim().slice(0, 80),
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  }
}

/** 读盘后的场景树归一：缺的补，坏的丢，重复 id 只留一个。 */
export function normalizeScenes(raw) {
  const base = createScenes()
  if (!isObject(raw)) return base
  const seen = new Set([SCENE_OWNER, SCENE_WORK_GENERAL])
  const unique = (list, idOf) => {
    const out = []
    for (const item of list) {
      const id = idOf(item)
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      out.push(item)
    }
    return out
  }
  return {
    version: SCENE_VERSION,
    root: { id: SCENE_OWNER, label: String(raw.root?.label ?? base.root.label).slice(0, 20) || base.root.label },
    projects: unique(normalizeList(raw.projects, SCENES.projects).map(normalizeProject).filter(Boolean), (item) => item.id),
    groups: unique(normalizeList(raw.groups, SCENES.groups).map(normalizeGroup).filter(Boolean), (item) => item.id),
    // 外部注册的场景节点：开源包只保存，不解释它们是什么。
    external: normalizeList(raw.external, SCENES.registered)
      .map((item) => {
        // 这里不能用 normalizeSceneId：它会把空串当主人层，空 id 的垃圾节点会冒充根节点。
        const id = String(item?.id ?? '').trim().slice(0, 120)
        if (id === '' || id === SCENE_OWNER) return null
        return {
          id,
          type: String(item.type ?? '').trim().slice(0, 20),
          label: String(item.label ?? '').trim().slice(0, 60),
          createdAt: Number(item.createdAt) || 0,
          updatedAt: Number(item.updatedAt) || 0,
        }
      })
      .filter(Boolean),
    // 注册口（P6）：场景类型只能从外部注册，不能写死某一类。
    registered: Array.isArray(raw.registered)
      ? raw.registered.map((item) => String(item ?? '').trim()).filter((item) => item !== '').slice(-SCENES.registered)
      : [],
  }
}

/** 按场景分组：返回 Map<场景 id, 条目[]>，保持原顺序。 */
export function groupByScene(list) {
  const pools = new Map()
  if (!Array.isArray(list)) return pools
  for (const entry of list) {
    if (!isObject(entry)) continue
    const key = sceneOf(entry)
    const pool = pools.get(key)
    if (pool) pool.push(entry)
    else pools.set(key, [entry])
  }
  return pools
}

/** 某个池子里有几条。 */
export function countInScene(list, scene) {
  if (!Array.isArray(list)) return 0
  const want = normalizeSceneId(scene)
  let n = 0
  for (const entry of list) if (sceneOf(entry) === want) n += 1
  return n
}

/**
 * 每个池子各留最新 `cap` 条，其余丢掉，返回新数组。
 *
 * 为什么不是整条列表 `slice(-cap)`：那是整份记忆共用一个名额。
 * 一个池子满了，不该把别的池子的条目顶掉——这正是 P0 要撑开的那件事。
 * 老数据全在主人层，只有一个池子，结果和 `slice(-cap)` 逐条一致。
 */
export function trimToPoolCaps(list, cap) {
  if (!Array.isArray(list)) return []
  const limit = Math.max(0, Math.floor(Number(cap) || 0))
  if (limit === 0) return []
  const keep = new Set()
  const seen = new Map()
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const key = sceneOf(list[i])
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    if (n <= limit) keep.add(i)
  }
  return list.filter((_, index) => keep.has(index))
}
