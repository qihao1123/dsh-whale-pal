/**
 * 状态结构：记忆（短期 + 长期）+ 承诺 + 自称。
 *
 * v6（2026-11-10）砍掉了人格状态机：traits / mood / relationship 数值 /
 * values 权重 / 称呼意愿值 / goal 都不再落盘。留下的只有「发生过什么」，
 * 不再给「我是什么样」打分——判断交给模型自己从记忆里读。
 *
 * 设计约束：
 *   - 每个集合都有硬上限，超出时按「证据数 / 最近使用」淘汰，绝不无限增长；
 *   - `revision` 每次落盘自增，提示词摘要靠它判断「有必要重算吗」。
 */
import { clean } from '../sanitize.js'
import { effectiveSelfNameInitial } from '../config.js'
import { assignMemoryIds, MEMORY_KINDS, normalizeEntry, normalizeLong } from '../memory.js'

export const STATE_VERSION = 6

export const CAPS = Object.freeze({
  facts: 200,
  preferences: 60,
  events: 60,
  openTopics: 30,
  longMemory: 40,
  commitments: 20,
  selfNameHistory: 20,
  titleNameHistory: 20,
})

function clamp01(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

export function createInitialState(config, now = Date.now()) {
  const initialSelfName = effectiveSelfNameInitial(config)
  return {
    stateVersion: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    sessionOrdinal: 0,
    selfName: {
      current: initialSelfName,
      history: [{ name: initialSelfName, from: 0, to: null, trigger: 'initial' }],
    },
    // 称呼是身份（人类给对方的叫法），不是意愿值机制：这里只存当前值与历史，
    // 候选池、待确认提案、意愿衰减都已随状态机删掉。
    titleName: { current: '', history: [] },
    memory: { facts: [], preferences: [], events: [], openTopics: [] },
    // 长期层：升上来的那几条，不参与衰减。
    longMemory: [],
    // 记忆发号器：只增不回收。`M-003` 一旦发出去，就永远是那条，不会让给新条目。
    memorySeq: 0,
    // 约定（承诺）不是记忆：它有状态。open=答应了还没做，done=做到了，lapsed=说到没做到。
    // v6 从 relationship 挪到顶层——关系数值没了，承诺是具体的事，得留。
    commitments: [],
    audit: { lastSeq: 0 },
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 自称：当前值 + 带时间跨度的历史。这是身份，不是状态机。 */
function normalizeNameBlock(raw, fallback, cap) {
  const source = isObject(raw) ? raw : {}
  const history = Array.isArray(source.history)
    ? source.history
        .filter(isObject)
        .map((item) => ({
          name: String(item.name ?? '').slice(0, 20),
          from: Number(item.from) || 0,
          to: item.to === null || item.to === undefined ? null : Number(item.to) || 0,
          trigger: String(item.trigger ?? '').slice(0, 120),
        }))
        .filter((item) => item.name !== '')
        .slice(-cap)
    : []
  return {
    current: String(source.current ?? fallback.current).slice(0, 20) || fallback.current,
    history: history.length > 0 ? history : fallback.history,
  }
}

/**
 * 读盘后的兜底：字段缺失按初始值补，越界钳制，超限截断。
 * 旧版 state.json 里的 traits / mood / relationship / values / titleName /
 * goal 等字段在这里被静默丢弃——不报错，也不尝试迁移，因为已经没有读它们的代码。
 */
export function normalizeState(raw, config, now = Date.now()) {
  const base = createInitialState(config, now)
  if (!isObject(raw)) return base
  const state = { ...base, ...raw }

  state.stateVersion = STATE_VERSION
  state.revision = Math.max(0, Number(raw.revision) || 0)
  state.sessionOrdinal = Math.max(0, Math.floor(Number(raw.sessionOrdinal) || 0))

  const selfName = isObject(raw.selfName) ? raw.selfName : {}
  state.selfName = normalizeNameBlock(selfName, base.selfName, CAPS.selfNameHistory)
  state.titleName = normalizeNameBlock(raw.titleName, base.titleName, CAPS.titleNameHistory)

  const memory = isObject(raw.memory) ? raw.memory : {}
  const memoryCaps = {
    facts: CAPS.facts,
    preferences: CAPS.preferences,
    events: CAPS.events,
    openTopics: CAPS.openTopics,
  }
  state.memory = {}
  for (const kind of MEMORY_KINDS) {
    const list = Array.isArray(memory[kind]) ? memory[kind] : []
    state.memory[kind] = list
      .map((item) => normalizeEntry(item, kind, now))
      .filter(Boolean)
      .slice(-memoryCaps[kind])
  }

  state.longMemory = (Array.isArray(raw.longMemory) ? raw.longMemory : [])
    .map((item) => normalizeLong(item, now))
    .filter(Boolean)
    .slice(-CAPS.longMemory)

  // 一次性迁移：v5 及以前的承诺存在 relationship.commitments 下。
  const legacyCommitments = isObject(raw.relationship) && Array.isArray(raw.relationship.commitments)
    ? raw.relationship.commitments
    : []
  const commitmentSource = Array.isArray(raw.commitments) ? raw.commitments : legacyCommitments
  state.commitments = commitmentSource
    .map((item) => normalizeCommitment(item, now))
    .filter(Boolean)
    .slice(-CAPS.commitments)

  const audit = isObject(raw.audit) ? raw.audit : {}
  state.audit = { lastSeq: Math.max(0, Number(audit.lastSeq) || 0) }

  // 编号：读盘后给还没号的条目补号（老状态、以及这一轮新写进来的）。
  // 发号器只增不回收，所以已发出的号不会因为条目被删而让给别人。
  state.memorySeq = Math.max(0, Math.floor(Number(raw.memorySeq) || 0))
  assignMemoryIds(state, now)

  // 清掉旧字段：它们已经不在初始状态里，但 `{ ...base, ...raw }` 会把它们带过来。
  delete state.traits
  delete state.traitsArchive
  delete state.mood
  delete state.relationship
  delete state.values
  delete state.valueBatch
  delete state.pendingProposals
  delete state.titleCandidates
  delete state.goal

  return state
}

const COMMITMENT_STATUS = ['open', 'done', 'lapsed']

function normalizeCommitment(raw, now) {
  if (typeof raw === 'string') {
    const text = raw.trim().slice(0, 120)
    return text ? { text, at: now, session: 0, status: 'open' } : null
  }
  if (!isObject(raw)) return null
  const text = String(raw.text ?? '').trim().slice(0, 120)
  if (!text) return null
  return {
    text,
    at: Number(raw.at) || now,
    session: Math.max(0, Number(raw.session) || 0),
    status: COMMITMENT_STATUS.includes(raw.status) ? raw.status : 'open',
    doneAt: Number(raw.doneAt) || 0,
    doneSession: Math.max(0, Number(raw.doneSession) || 0),
  }
}

export { clamp01 }
