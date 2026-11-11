/**
 * 处理流程：六个阶段 + 七种进度点。
 *
 * 六阶段（融合计划 §12）：拆解、补全、自检、对照、串联、交付。
 * 七种进度点（施工前总结 §5，写法照抄，别自己改格式）：
 *   `Stage N·阶段名·已完成` / `Stage N·未确认` / `Stage N·返工中` / `Stage N·已放弃`
 *   / `六阶段已完成·待落地` / `六阶段已完成·已落地` / `Stage 4·延迟待补`
 *
 * 为什么要状态机而不是「让模型记住走到哪」：走到哪是个值，不是感觉。
 * 值落盘、可回跳、可从任意断点续跑；用户说「算了不要了」也得能落成一格状态，
 * 否则下次会被当成「在做」继续推。
 */
import { readJsonFile } from './persona/lib/state/store.js'
import { writeWithBackup } from './atomic.js'
import { ASK_AGAIN, parseConfirm } from './token.js'

export const STAGES = Object.freeze([
  { n: 1, name: '拆解' },
  { n: 2, name: '补全' },
  { n: 3, name: '自检' },
  { n: 4, name: '对照' },
  { n: 5, name: '串联' },
  { n: 6, name: '交付' },
])

export const LAST_STAGE = STAGES.length

/** 只有第 4 阶段可以「延迟待补」，这是七形态里唯一带阶段号的例外。 */
export const DEFERRABLE_STAGE = 4

export const MARKS = Object.freeze([
  'idle',
  'done',
  'unconfirmed',
  'rework',
  'abandoned',
  'deferred',
  'allPending',
  'allLanded',
])

const HISTORY_LIMIT = 200

export function stageName(n) {
  const stage = STAGES.find((item) => item.n === n)
  return stage ? stage.name : ''
}

export function createProgress(now = Date.now()) {
  return { version: 1, stage: 0, mark: 'idle', pending: 0, updatedAt: now, history: [] }
}

function withHistory(progress, action, from, to, now) {
  const history = Array.isArray(progress.history) ? progress.history : []
  const entry = { at: now, action, from: from ? `${from.stage}/${from.mark}` : null, to: `${to.stage}/${to.mark}` }
  return { ...to, history: [...history, entry].slice(-HISTORY_LIMIT) }
}

function move(progress, patch, action, now = Date.now()) {
  const from = { stage: progress.stage, mark: progress.mark }
  const to = { ...progress, ...patch, updatedAt: now }
  return { ok: true, progress: withHistory(progress, action, from, to, now) }
}

function refuse(error) {
  return { ok: false, error }
}

/** 六个阶段都确认过了。 */
export function allStagesDone(progress) {
  return progress.stage === LAST_STAGE && progress.mark === 'done'
}

/** 下一个该做的阶段号；全做完回 0。 */
export function nextStageNumber(progress) {
  if (progress.mark === 'allPending' || progress.mark === 'allLanded') return 0
  if (progress.mark === 'done') return progress.stage < LAST_STAGE ? progress.stage + 1 : 0
  return progress.stage || 1
}

/** 进度点文本；没开工回空串（不渲染一行空话）。 */
export function formatMarker(progress) {
  if (!progress || progress.mark === 'idle') return ''
  if (progress.mark === 'allPending') return '六阶段已完成·待落地'
  if (progress.mark === 'allLanded') return '六阶段已完成·已落地'
  const stage = progress.stage
  if (progress.mark === 'done') return `Stage ${stage}·${stageName(stage)}·已完成`
  if (progress.mark === 'deferred') return `Stage ${DEFERRABLE_STAGE}·延迟待补`
  const label = { unconfirmed: '未确认', rework: '返工中', abandoned: '已放弃' }[progress.mark]
  return label ? `Stage ${stage}·${label}` : ''
}

/** 开工：从下一阶段起手，状态是「未确认」，等用户按。 */
/**
 * 开新一轮。
 *
 * 六阶段是「一件事」的走法，不是一生只做一件事：上一件事落地之后要能做下一件。
 * 只有真落地了才允许重开——「待落地」那格还欠着交付，重开就等于把欠账抹掉，
 * 所以那种情况先拒，让人自己决定是先落地还是先说明为什么不算数。
 */
export function restart(progress, now = Date.now()) {
  if (progress.mark === 'allPending') return refuse('not-landed')
  if (progress.mark !== 'allLanded') return refuse('not-finished')
  const next = createProgress(now)
  next.history = [...progress.history, { at: now, action: 'restart', from: progress.stage, to: 0 }].slice(-HISTORY_LIMIT)
  next.updatedAt = now
  return { ok: true, progress: next }
}

export function begin(progress, now = Date.now()) {
  if (progress.mark === 'allLanded') return refuse('landed')
  if (progress.mark === 'unconfirmed') return refuse('already-open')
  const n = nextStageNumber(progress)
  if (!n) return refuse('all-done')
  return move(progress, { stage: n, mark: 'unconfirmed', pending: n }, 'begin', now)
}

/**
 * 用户按了确认。口令不合规一律不前进，并且回问同一句——
 * 不替人按，也不解释为什么不行（解释会被读成「再试一次就能过」）。
 */
export function confirm(progress, raw, now = Date.now()) {
  const parsed = parseConfirm(raw, { pending: progress.pending })
  if (!parsed.ok) return { ok: false, error: parsed.reason, ask: ASK_AGAIN }
  return move(progress, { mark: 'done', pending: 0 }, 'confirm', now)
}

/** 返工：这一阶段要重做。 */
export function rework(progress, now = Date.now()) {
  if (!progress.stage) return refuse('nothing-started')
  return move(progress, { mark: 'rework', pending: progress.stage }, 'rework', now)
}

/** 放弃：用户说「算了不要了」。留痕，不装作没发生。 */
export function abandon(progress, now = Date.now()) {
  if (!progress.stage) return refuse('nothing-started')
  return move(progress, { mark: 'abandoned', pending: 0 }, 'abandon', now)
}

/** 延迟待补：只有第 4 阶段允许。 */
export function defer(progress, now = Date.now()) {
  if (progress.stage !== DEFERRABLE_STAGE) return refuse('not-deferrable')
  return move(progress, { mark: 'deferred', pending: 0 }, 'defer', now)
}

/** 定向回跳：从任意位置退回第 n 阶段重做。 */
export function jumpBack(progress, n, now = Date.now()) {
  if (!Number.isInteger(n) || n < 1 || n > LAST_STAGE) return refuse('bad-stage')
  return move(progress, { stage: n, mark: 'rework', pending: n }, 'jump-back', now)
}

/** 六阶段都确认完 → 待落地。 */
export function finish(progress, now = Date.now()) {
  if (!allStagesDone(progress)) return refuse('not-all-done')
  return move(progress, { mark: 'allPending', pending: 0 }, 'finish', now)
}

/** 落地：事情真的办完了。 */
export function land(progress, now = Date.now()) {
  if (progress.mark !== 'allPending') return refuse('not-pending-land')
  return move(progress, { mark: 'allLanded' }, 'land', now)
}

/** 读盘。文件不存在就是没开工，不算错。 */
export function readProgress(file) {
  const raw = readJsonFile(file, null)
  if (!raw || typeof raw !== 'object') return createProgress()
  const stage = Number(raw.stage)
  const mark = MARKS.includes(raw.mark) ? raw.mark : 'idle'
  return {
    version: 1,
    stage: Number.isInteger(stage) && stage >= 0 && stage <= LAST_STAGE ? stage : 0,
    mark,
    pending: Number.isInteger(Number(raw.pending)) ? Number(raw.pending) : 0,
    updatedAt: Number(raw.updatedAt) || 0,
    history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_LIMIT) : [],
  }
}

export function saveProgress(file, progress) {
  // 自己写的文件也走同一个原子写链路：备份 → tmp → rename → 读回。
  // 保留份数用 atomic 的默认值（10 份，用户 2026-11-03 定）。
  writeWithBackup(file, JSON.stringify(progress, null, 2))
  return progress
}

/**
 * 给系统提示用的一段话。没开工就不占位（不渲染空段），
 * 开工了只报「现在在哪、等什么」，不催也不劝。
 */
export function progressText(progress) {
  const marker = formatMarker(progress)
  if (!marker) return ''
  const lines = [`【处理流程】${marker}`]
  if (progress.mark === 'unconfirmed') {
    lines.push(`等你按：${ASK_AGAIN}`)
    lines.push('「对」「好」「嗯」不算确认，沉默也不算；没按之前不许往下做。')
  }
  if (progress.mark === 'rework') lines.push('这一阶段在返工，做完再等确认。')
  if (progress.mark === 'abandoned') lines.push('这一轮放弃了，别自己捡回来。')
  if (progress.mark === 'deferred') lines.push('第 4 阶段延迟待补，别当成做完了。')
  if (progress.mark === 'allPending') lines.push('六个阶段都确认过了，等落地。')
  return lines.join('\n')
}
