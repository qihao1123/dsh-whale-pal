// 压缩触发点：按「已用」算，不写死 token 数。
//
// 口径（第六批 §3.3 / §4.3，2026-11-08 定）：
//   触发点 = max(c × W, 地板 + m × W)          c = 0.16，m = 0.04
//   提醒点 = max(0.20 × W, 触发点 + m × W)     # 允许晚，不许早
//
// 为什么不能只写 c × W：地板（系统提示 + 规则 + 工具定义 + 摘要）是固定量，
// 占窗口的比例随窗口变小而升高。地板 4 万时，窗口掉到 25 万地板就占 16%，
// 正好等于 c × W —— 压完回到线上，压了等于没压。加上 m × W 这一支，
// 触发点会自动跟着窗口变小而升。
//
// W 运行期取（request/context 实测 → 模型声明），地板由上一次压完实测。
// 这两个都是运行期值，不是本机常量 —— 见 AGENTS.md R17「默认通用，不默认本机」。

/** 默认系数：比例支 16%，地板支 4%。 */
export const DEFAULT_RATIO = 0.16;
/** 默认提醒比例 20%。 */
export const DEFAULT_REMIND_RATIO = 0.2;
/** 默认地板支系数 4%。 */
export const DEFAULT_FLOOR_MARGIN = 0.04;
/** 原生 thresholdRatio 默认值：触发点晚过它就没有意义（原生先压）。 */
export const NATIVE_THRESHOLD_RATIO = 0.8;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * 算触发点与提醒点。
 *
 * @param {object} options
 * @param {number} options.contextWindow 窗口大小，运行期取。非正数返回 null。
 * @param {number} [options.floor] 上一次压完实测的已用量。没测过就不传。
 * @param {number} [options.ratio] 比例支系数，默认 0.16。
 * @param {number} [options.floorMargin] 地板支系数，默认 0.04。
 * @param {number} [options.remindRatio] 提醒比例，默认 0.2。
 * @returns {null | { trigger: number, remind: number, window: number, floor: number|null, nativeAt: number, disabled: null|string }}
 *   `disabled` 非 null 时表示自动压缩该停用，只留提醒，值是原因。
 */
export function triggerPoints({
  contextWindow,
  floor = null,
  ratio = DEFAULT_RATIO,
  floorMargin = DEFAULT_FLOOR_MARGIN,
  remindRatio = DEFAULT_REMIND_RATIO,
} = {}) {
  const w = num(contextWindow);
  if (w === null || w <= 0) return null;

  const c = num(ratio) ?? DEFAULT_RATIO;
  const m = num(floorMargin) ?? DEFAULT_FLOOR_MARGIN;
  const r = num(remindRatio) ?? DEFAULT_REMIND_RATIO;
  const f = num(floor);

  const byRatio = Math.floor(w * c);
  // 没有地板值时只走比例支：第一次压完立刻测一次，之后走完整公式。
  // 第一次可能偏早，一次偏差换来自校准，比配置一个猜的常数好。
  const byFloor = f === null ? 0 : Math.floor(f + w * m);
  const trigger = Math.max(byRatio, byFloor);

  // 提醒点跟着触发点走：小窗口上触发点被地板抬高了，提醒若还按 20% 算，
  // 就会变成「还没到自动压缩点就催人手动压」。
  // 但也不能超过窗口本身 —— 地板太高时 remind 会算到窗口之外，那句提醒永远等不到。
  // 上限取窗口的 0.8（与原生阈值同一点），越过它就说明这个窗口本来就压不动。
  const remindCeil = Math.floor(w * NATIVE_THRESHOLD_RATIO);
  const remind = Math.min(
    Math.max(Math.floor(w * r), Math.floor(trigger + w * m)),
    Math.max(remindCeil, Math.floor(w * r)),
  );

  const nativeAt = Math.floor(w * NATIVE_THRESHOLD_RATIO);

  // 硬护栏：压得下去才有意义。触发点够到原生阈值时，原生会先压，
  // 我们这一档要么永远轮不到、要么压完仍在线上，变成每 3 轮压一次的抖动。
  let disabled = null;
  if (trigger >= nativeAt) disabled = `触发点 ${trigger} 已达到原生阈值 ${nativeAt}，自动压缩没有意义`;
  else if (f !== null && f >= trigger) disabled = `地板 ${f} 已不低于触发点 ${trigger}，压完仍在线上`;

  return { trigger, remind, window: w, floor: f, nativeAt, disabled };
}

/**
 * 到没到点。取不到窗口或读数时一律返回 false —— 不猜、不默认触发。
 *
 * @param {object} options
 * @param {number} options.used 已用量（tokenMeter 的 totalTokens）。
 * @param {object} options.points `triggerPoints` 的返回值。
 * @returns {boolean}
 */
export function shouldTrigger({ used, points } = {}) {
  const u = num(used);
  if (u === null || u < 0) return false;
  if (!points || typeof points !== 'object') return false;
  if (points.disabled !== null) return false;
  const t = num(points.trigger);
  if (t === null || t <= 0) return false;
  return u >= t;
}

/**
 * 该不该提醒。主路正常工作时压完就回落，提醒根本不会响；
 * 主路挂了（服务缺失 / 连续失败停用）才靠它兜一句。
 */
export function shouldRemind({ used, points } = {}) {
  const u = num(used);
  if (u === null || u < 0) return false;
  if (!points || typeof points !== 'object') return false;
  const r = num(points.remind);
  if (r === null || r <= 0) return false;
  return u >= r;
}
