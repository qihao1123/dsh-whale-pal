/**
 * 批次号：自增、定名、回滚。
 *
 * 口径出处：`融合计划-v2.md` §16.5；批次是「一次压缩事件落的一批卡片」的编号，
 * 见 `docs/P35-串联.md` 第二节第 10 行。
 *   - 编号补零三位，过 999 自然变四位（`B1000`），与档案编号同一套规则；
 *   - 序号由调用方给（`seq`），本文件不数、不取时钟——`now` 可传，但不读；
 *   - `rollbackBatch` 只摘本批，别批原样留；入参数组不改，返回新数组。
 *
 * 纯函数：不读盘、不读环境变量、不看时钟。
 */

/** 补零位数（过 999 时 padStart 不裁，自然变四位）。 */
export const BATCH_WIDTH = 3

/** 一批的号：`B` + 补零序号。 */
const BATCH_SHAPE = /^B(\d+)$/u

/** 序号 → 号。 */
function formatBatch(number) {
  return `B${String(number).padStart(BATCH_WIDTH, '0')}`
}

/**
 * 下一批的号：取现有批次里的最大序号加一。
 *
 * @param {string[]} existing 已有批次号，乱序、含脏值都不影响
 * @returns {string} 空数组回 `B001`
 */
export function nextBatch(existing) {
  const list = Array.isArray(existing) ? existing : []
  let max = 0
  for (const item of list) {
    const hit = BATCH_SHAPE.exec(String(item ?? '').trim())
    if (!hit) continue
    const number = Number(hit[1])
    if (Number.isFinite(number) && number > max) max = number
  }
  return formatBatch(max + 1)
}

/**
 * 给一批定名。
 *
 * @param {{ now?: unknown, seq?: number }} input `seq` 是序号，由调用方数好传进来；
 *   `now` 收下但不读（时间不从本文件取），传不传结果一样。
 * @returns {string|null} `seq` 不是正整数时回 `null`，不抛
 */
export function batchId({ seq } = {}) {
  const number = Math.trunc(Number(seq))
  if (!Number.isFinite(number) || number < 1) return null
  return formatBatch(number)
}

/**
 * 按批次归堆：同一批的卡片放一起，批次号升序；没有批次号的（脏卡）归到最后。
 *
 * @param {Array} cards 卡片数组，原样读，不改入参
 * @returns {Array<{ batch: string, cards: Array }>}
 */
export function groupByBatch(cards) {
  const list = Array.isArray(cards) ? cards : []
  const buckets = new Map()
  for (const card of list) {
    const key = typeof card?.batch === 'string' ? card.batch.trim() : ''
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(card)
  }
  const named = [...buckets.entries()]
    .filter(([key]) => key !== '')
    .sort(([left], [right]) => compareBatch(left, right))
  const blank = buckets.get('')
  return [
    ...named.map(([batch, rows]) => ({ batch, cards: rows })),
    ...(blank ? [{ batch: '', cards: blank }] : []),
  ]
}

/** 批次号比大小：先按数字，再按字面（保证排序稳定）。 */
function compareBatch(left, right) {
  const a = BATCH_SHAPE.exec(left)
  const b = BATCH_SHAPE.exec(right)
  if (a && b) return Number(a[1]) - Number(b[1])
  return String(left).localeCompare(String(right))
}

/**
 * 摘出一批的卡片，别批留着；顺序照原数组。
 *
 * @param {{ cards?: Array, batch?: string }} input
 * @returns {Array} 命中的卡片本身（不是副本）
 */
export function cardsOfBatch({ cards, batch } = {}) {
  const target = typeof batch === 'string' ? batch.trim() : ''
  if (target === '') return []
  return (Array.isArray(cards) ? cards : []).filter((card) => card?.batch === target)
}

/**
 * 撤一批：命中的摘出来，别批留着。
 *
 * @param {{ cards?: Array, batch?: string }} input
 * @returns {{ ok: boolean, removed?: string[], kept?: Array, reason?: string }}
 *   `removed` 是本批的 `blockId`（缺则退回 `id`），`kept` 是其余卡片本身；
 *   两者都是新数组，入参不动。
 */
export function rollbackBatch({ cards, batch } = {}) {
  if (!Array.isArray(cards)) return { ok: false, reason: 'not-array' }
  const target = typeof batch === 'string' ? batch.trim() : ''
  if (target === '') return { ok: false, reason: 'no-batch' }

  const removed = []
  const kept = []
  for (const card of cards) {
    if (card?.batch === target) {
      removed.push(String(card?.blockId ?? card?.id ?? ''))
      continue
    }
    kept.push(card)
  }
  return { ok: true, removed, kept }
}
