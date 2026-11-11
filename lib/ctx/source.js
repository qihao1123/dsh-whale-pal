/**
 * 上下文来源选择器：native / occupied / none 三态。
 *
 * 口径出处：`融合计划-v2.md` §16.2。字段形状按 `docs/P35-补全.md` 第二节落地：
 * - native：宿主内置投影 `contextPressure` 同时给出 `pressureTokens` 与
 *   `contextWindow`。这里交出去的 `tokens` 一律是「**已经用掉多少**」：
 *   有 `projectedTokens` 就用它（宿主给的预计占用），没有就用 `pressureTokens`；
 *   「还剩多少」由 `threshold.remainingOf` 用窗口减出来，两边别各算一遍。
 * - occupied：bili 信封的 `stats.contextTokens` 为正数（本机未取证，只做接口）。
 * - none：用「消息字符 ÷ 3」自估，`exact:false`，窗口为 null。
 *
 * 纯函数：不读盘、不读环境变量、不看时钟。任何形状不对的入参都静默降级，
 * 本模块不抛异常。
 */

const DEFAULT_PER = 3

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)
const isCount = (value) => isNum(value) && value >= 0
const objectOrNull = (value) => (value !== null && typeof value === 'object' ? value : null)

export function pickSource(input = {}) {
  const { pressure, envelope, estimate } =
    input !== null && typeof input === 'object' ? input : {}

  const pressureState = objectOrNull(pressure)
  const pressureTokens = pressureState?.pressureTokens
  const projectedTokens = pressureState?.projectedTokens
  const contextWindow = pressureState?.contextWindow

  if (isCount(pressureTokens) && isNum(contextWindow) && contextWindow > 0) {
    const tokens = isCount(projectedTokens) ? projectedTokens : pressureTokens
    return { kind: 'native', tokens, window: contextWindow, exact: true }
  }

  const stats = objectOrNull(envelope)?.stats
  const contextTokens = objectOrNull(stats)?.contextTokens

  if (isNum(contextTokens) && contextTokens > 0) {
    return { kind: 'occupied', tokens: contextTokens, window: null, exact: true }
  }

  const estimateState = objectOrNull(estimate)
  const chars = estimateState?.chars

  if (isCount(chars)) {
    const per = isNum(estimateState?.per) && estimateState.per > 0 ? estimateState.per : DEFAULT_PER
    return { kind: 'none', tokens: Math.round(chars / per), window: null, exact: false }
  }

  return { kind: 'none', tokens: null, window: null, exact: false }
}
