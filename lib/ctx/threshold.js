/**
 * 三档提醒：上下文用掉多少时提醒人压一次。
 *
 * 口径出处：第六批 §4.2（2026-11-08 改定）。**按「已用」算，不按「还剩」算。**
 *
 * 为什么改口径：旧写法是「剩余 ≤ min(比例 × 窗口, 绝对值)」，绝对值那支在 1M 窗口上
 * 永远赢 —— 提醒要等到已用 98.8 万才响，而原生压缩在约 80 万就压完了，压完剩余回到
 * 20 万、档位又回 ok。**提醒永远等不到**，不是「晚一点」。
 *
 * 现在三档按已用量与窗口的比例走，并与主路触发点共用同一套锚点：
 *
 *   remind   已用 ≥ max(0.20 × W, 触发点 + 0.04 × W)
 *   urge     已用 ≥ 0.72 × W
 *   critical 已用 ≥ 0.80 × W（≈ 原生 thresholdRatio 默认值）
 *
 * `trigger` 由 `trigger.js` 算好传进来；不给就只用 20% 那支。
 * 判定从 critical 往下走，先命中先算。**本模块只算档位，绝不自动压缩。**
 *
 * 纯函数：不读盘、不读环境变量、不看时钟。缺参回 'ok' / null，不抛异常。
 */

/** 三档的已用比例。critical 对齐原生 thresholdRatio 默认 0.8。 */
export const LIMITS = Object.freeze({
  remind: Object.freeze({ ratio: 0.2 }),
  urge: Object.freeze({ ratio: 0.72 }),
  critical: Object.freeze({ ratio: 0.8 }),
})

/** 提醒点相对触发点要留的余量（比例），与 trigger.js 的 floorMargin 同源。 */
export const REMIND_MARGIN = 0.04

const TIER_RANK = Object.freeze({ ok: 0, remind: 1, urge: 2, critical: 3 })

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const isCount = (value) => isNum(value) && value >= 0

/** 还剩多少：窗口减已用。留着给命令回执用，不再参与档位判定。 */
export function remainingOf(input = {}) {
  const { tokens, window } = input !== null && typeof input === 'object' ? input : {}
  if (!isCount(tokens)) return null
  if (!isNum(window) || window <= 0) return null
  return window - tokens
}

/**
 * 三档各自的已用阈值。
 *
 * @param {object} options
 * @param {number} options.window 窗口大小
 * @param {number} [options.trigger] 主路触发点；给了就让 remind 跟着它走
 * @returns {null | {remind:number, urge:number, critical:number}}
 */
export function usedLimits({ window, trigger = null } = {}) {
  if (!isNum(window) || window <= 0) return null
  const base = Math.floor(window * LIMITS.remind.ratio)
  const followed = isNum(trigger) && trigger > 0
    ? Math.floor(trigger + window * REMIND_MARGIN)
    : 0
  // 上限：提醒点不能越过窗口的 0.8（原生阈值那一点）。地板很高的小窗口上，
  // 「触发点 + 4%」会算到窗口之外，那句提醒永远等不到 —— 夹回来才有意义。
  const ceil = Math.floor(window * LIMITS.critical.ratio)
  const remind = Math.min(Math.max(base, followed), Math.max(ceil, base))
  return {
    remind,
    urge: Math.floor(window * LIMITS.urge.ratio),
    critical: ceil,
  }
}

/**
 * 判档位。
 *
 * @param {object} input
 * @param {number} input.used 已用量
 * @param {number} input.window 窗口大小
 * @param {number} [input.trigger] 主路触发点，给了让提醒点跟它对齐
 * @returns {'ok'|'remind'|'urge'|'critical'}
 */
export function tierOf(input = {}) {
  const { used, window, trigger = null } = input !== null && typeof input === 'object' ? input : {}
  if (!isCount(used)) return 'ok'
  const limits = usedLimits({ window, trigger })
  if (limits === null) return 'ok'

  if (used >= limits.critical) return 'critical'
  if (used >= limits.urge) return 'urge'
  if (used >= limits.remind) return 'remind'

  return 'ok'
}

export function rank(tier) {
  return typeof tier === 'string' && Object.hasOwn(TIER_RANK, tier) ? TIER_RANK[tier] : 0
}

export function shouldAnnounce(prev, next) {
  return rank(next) > rank(prev)
}
