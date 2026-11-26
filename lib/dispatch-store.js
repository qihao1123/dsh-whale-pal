/**
 * 派活的账本：哪个项目用哪条执行会话，还有哪些任务在排队等它空下来。
 *
 * 为什么单独一个文件、放在数据目录里：这两样东西跨进程活着（重启要接着投），
 * 不能只放在内存；而 `state.json` 归人格内核管，别往那里塞业务。
 *
 * 口径（跟台账那套一致）：
 *   - 只经 `writeWithBackup` 写：写前备份、写后读回、读回不一致自动回滚；
 *   - 读坏了不假装空账本——`broken: true` 带出去，调用方自己决定要不要喊；
 *   - 这里是纯状态变换，不碰宿主服务、不建目录，好测。
 */
import { existsSync, readFileSync } from 'node:fs'

import { writeWithBackup } from './atomic.js'

/** 账本格式版本。字段变了就加一，读到老版本按缺省值补。 */
export const DISPATCH_STATE_VERSION = 1

/** 投出去的历史留多少条：只用来查「这个任务投过没有」，不留账。 */
export const DISPATCH_SENT_KEEP = 50

/** 空账本。 */
export function emptyDispatchState() {
  return { version: DISPATCH_STATE_VERSION, projects: {}, queue: [], sent: [] }
}

const text = (value) => String(value ?? '').trim()

function normalizeProjectRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  const sessionId = text(raw.sessionId)
  if (sessionId === '') return null
  return {
    sessionId,
    permission: text(raw.permission),
    at: text(raw.at),
  }
}

function normalizeQueueItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = text(raw.id)
  const project = text(raw.project)
  const task = text(raw.task)
  const sessionId = text(raw.sessionId)
  if (id === '' || project === '' || task === '' || sessionId === '') return null
  return {
    id,
    project,
    task,
    sessionId,
    permission: text(raw.permission),
    taskDir: text(raw.taskDir),
    docPath: text(raw.docPath),
    at: text(raw.at),
    attempts: Number.isInteger(raw.attempts) && raw.attempts > 0 ? raw.attempts : 0,
    lastError: text(raw.lastError),
  }
}

/** 把盘上读到的东西收成形状确定的账本；坏成什么样都不抛。 */
export function normalizeDispatchState(raw) {
  const state = emptyDispatchState()
  if (!raw || typeof raw !== 'object') return state
  const projects = raw.projects && typeof raw.projects === 'object' ? raw.projects : {}
  for (const [name, value] of Object.entries(projects)) {
    const key = text(name)
    const record = normalizeProjectRecord(value)
    if (key === '' || record === null) continue
    state.projects[key] = record
  }
  state.queue = (Array.isArray(raw.queue) ? raw.queue : []).map(normalizeQueueItem).filter(Boolean)
  state.sent = (Array.isArray(raw.sent) ? raw.sent : [])
    .map(normalizeQueueItem)
    .filter(Boolean)
    .slice(-DISPATCH_SENT_KEEP)
  return state
}

/**
 * 读账本。
 *
 * 文件不存在是正常情况（第一次派活），回空账本且 `broken: false`。
 * 文件在但读不出来，回空账本 + `broken: true`：调用方至少能说一句实话，
 * 而不是把「账本坏了」显示成「一条都没派过」。
 */
export function readDispatchState(file) {
  try {
    if (text(file) === '' || !existsSync(file)) return { ...emptyDispatchState(), broken: false }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return { ...normalizeDispatchState(raw), broken: false }
  } catch {
    return { ...emptyDispatchState(), broken: true }
  }
}

/** 落盘。返回 `writeWithBackup` 那份结果，调用方看 `ok`。 */
export function saveDispatchState(file, state) {
  const clean = normalizeDispatchState(state)
  const body = `${JSON.stringify(clean, null, 2)}\n`
  return writeWithBackup(file, body)
}

/** 某个项目的执行会话记录；没有就 null。 */
export function projectRecordOf(state, project) {
  const key = text(project)
  if (key === '') return null
  return state?.projects?.[key] ?? null
}

/** 记下「这个项目用这条会话」，连上次的权限档。 */
export function setProjectRecord(state, project, { sessionId = '', permission = '', at = '' } = {}) {
  const key = text(project)
  const id = text(sessionId)
  if (key === '' || id === '') return state
  return {
    ...state,
    projects: {
      ...state.projects,
      [key]: { sessionId: id, permission: text(permission), at: text(at) || new Date().toISOString() },
    },
  }
}

/**
 * 抹掉某个项目的记录。
 *
 * 会话被删/归档之后要用：留着一条指向死会话的记录，下次派活会一直撞空。
 */
export function clearProjectRecord(state, project) {
  const key = text(project)
  if (key === '' || !Object.hasOwn(state.projects ?? {}, key)) return state
  const projects = { ...state.projects }
  delete projects[key]
  return { ...state, projects }
}

/** 池里有没有同一条：同一个编号、或同一项目同一任务（防重复入池）。 */
export function isQueued(state, { id = '', project = '', task = '' } = {}) {
  const wanted = text(id)
  const p = text(project)
  const t = text(task)
  return (state.queue ?? []).some(
    (item) => (wanted !== '' && item.id === wanted) || (p !== '' && t !== '' && item.project === p && item.task === t),
  )
}

/** 入池：同项目同任务只留一条，先到先投。 */
export function enqueueTask(state, item = {}) {
  const clean = normalizeQueueItem(item)
  if (clean === null) return state
  if (isQueued(state, clean)) return state
  return { ...state, queue: [...(state.queue ?? []), clean] }
}

/** 某个会话名下的排队任务，顺序就是入池顺序。 */
export function queuedForSession(state, sessionId) {
  const wanted = text(sessionId)
  if (wanted === '') return []
  return (state.queue ?? []).filter((item) => item.sessionId === wanted)
}

/** 全池还欠着几个。 */
export function queueLength(state) {
  return (state.queue ?? []).length
}

/**
 * 投成功：出池，进历史。
 *
 * 出池和进历史必须是同一次变换——分成两步写盘，中间崩了就会出现
 * 「池里没了、历史里也没有」的丢件。
 */
export function settleSent(state, id) {
  const wanted = text(id)
  const hit = (state.queue ?? []).find((item) => item.id === wanted)
  if (!hit) return state
  const queue = state.queue.filter((item) => item.id !== wanted)
  return { ...state, queue, sent: [...(state.sent ?? []), hit].slice(-DISPATCH_SENT_KEEP) }
}

/**
 * 投失败：记一笔再留在池里。
 *
 * 不因为一次失败就把任务丢掉——会话忙、宿主刚起来都可能失败一次；
 * 留 `lastError` 是让人看得见为什么这单还没出去。
 */
export function markAttempt(state, id, error = '') {
  const wanted = text(id)
  let changed = false
  const queue = (state.queue ?? []).map((item) => {
    if (item.id !== wanted) return item
    changed = true
    return { ...item, attempts: item.attempts + 1, lastError: text(error) }
  })
  return changed ? { ...state, queue } : state
}

/**
 * 直接投出去的任务也记一笔。
 *
 * `settleSent` 只管「池里那条投出去了」，直接投的从来没进过池，
 * 不补这一笔，历史里就查不到它投过。
 */
export function recordSent(state, item = {}) {
  const clean = normalizeQueueItem(item)
  if (clean === null) return state
  return { ...state, sent: [...(state.sent ?? []), clean].slice(-DISPATCH_SENT_KEEP) }
}

/**
 * 池里的任务没救了（执行会话被删/归档）：出池，理由记在历史里。
 *
 * `settleSent` 只记「投出去了」，这条记「投不出去」。两条分开，查账才分得清。
 */
export function dropQueued(state, id, error = '') {
  const wanted = text(id)
  const hit = (state.queue ?? []).find((item) => item.id === wanted)
  if (!hit) return state
  const dropped = { ...hit, lastError: text(error) || 'dropped' }
  return {
    ...state,
    queue: state.queue.filter((item) => item.id !== wanted),
    sent: [...(state.sent ?? []), dropped].slice(-DISPATCH_SENT_KEEP),
  }
}
