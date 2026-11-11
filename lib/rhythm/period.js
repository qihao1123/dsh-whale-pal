/**
 * 周期键与「这一档该不该提醒」的判法。
 *
 * 口径出处：`融合计划-v2.md` D5（插件内定时为主、计划任务兜底）、§5 的 P4 行（日/周/月）、
 * §12（这东西叫「提醒节奏」，实现与文案里都不许用原包那个专名）。
 *
 * 时钟怎么进来：本模块**不看时钟**——调用方把 epoch 毫秒和时区偏移量一起传进来，
 * 日历按「偏移后的 UTC」算。这样同一份入参在任何机器、任何时区、任何语言环境都得同一个键，
 * 测试才钉得住；真机上调 `-new Date().getTimezoneOffset()`（+08:00 就是 480）。
 *
 * 纯模块：不碰盘、不读环境变量、不看时钟。
 */

/** 三档，从短到长。顺序固定：提醒文案、测试断言都按它排。 */
export const KINDS = Object.freeze(['day', 'week', 'month']);

export const KIND_LABEL = Object.freeze({ day: '今天', week: '这一周', month: '这个月' });

export function labelOf(kind) {
  return KIND_LABEL[String(kind ?? '')] ?? '';
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** 把 epoch 挪到「当地时间也是 UTC 时间」的坐标上，后面只用 getUTC* 取日历。 */
export function shiftMs(ms, offsetMinutes = 0) {
  const value = Number(ms);
  if (Number.isFinite(value) === false) return NaN;
  const offset = Number(offsetMinutes);
  return value + (Number.isFinite(offset) ? offset : 0) * 60 * 1000;
}

function shiftedDate(ms, offsetMinutes) {
  const shifted = shiftMs(ms, offsetMinutes);
  if (Number.isFinite(shifted) === false) return null;
  const date = new Date(shifted);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** 日键 `YYYY-MM-DD`。给不出就回空串（宁可不提醒，也不瞎报一个日子）。 */
export function dayKeyOf(ms, offsetMinutes = 0) {
  const date = shiftedDate(ms, offsetMinutes);
  if (!date) return '';
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 月键 `YYYY-MM`。 */
export function monthKeyOf(ms, offsetMinutes = 0) {
  const date = shiftedDate(ms, offsetMinutes);
  if (!date) return '';
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}

/**
 * ISO 8601 周：周一算一周的头，含周四的那一周算这一年的第几周。
 * 跨年那一周（12-31 可能属于下一年 W01）就靠这个算法兜住。
 */
export function isoWeekOf(ms, offsetMinutes = 0) {
  const date = shiftedDate(ms, offsetMinutes);
  if (!date) return { year: 0, week: 0 };
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // 周一 = 0
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // 这一周的周四
  const year = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return { year, week };
}

/** 周键 `YYYY-Www`（两位补零，好比较也好读）。 */
export function isoWeekKeyOf(ms, offsetMinutes = 0) {
  const { year, week } = isoWeekOf(ms, offsetMinutes);
  if (!year || !week) return '';
  return `${year}-W${pad(week)}`;
}

/** 这一刻的三档键。`day:...` / `week:...` / `month:...` 里的键就是这三格。 */
export function keysOf(ms, offsetMinutes = 0) {
  return {
    day: dayKeyOf(ms, offsetMinutes),
    week: isoWeekKeyOf(ms, offsetMinutes),
    month: monthKeyOf(ms, offsetMinutes),
  };
}

/** 从幂等键反推是哪一档：`day:2026-11-05` → `day`。认不出来回空串。 */
export function kindFromKey(key) {
  const head = String(key ?? '').split(':')[0];
  return KINDS.includes(head) ? head : '';
}

/**
 * 这一档该不该报：键跟上次报过的键不一样就该报。
 *
 * 注意判法是「键不等」而不是「时间到了」——重启、多开会话、定时器抖动都只影响调用次数，
 * 不影响结果：同一个周期键只会被报一次。
 */
export function dueKinds({ keys, fired } = {}) {
  const current = keys ?? {};
  const done = fired ?? {};
  return KINDS.filter((kind) => current[kind] !== '' && current[kind] !== undefined && done[kind] !== current[kind]);
}

/** 跨过下一次本地零点还要多久（定时器用；给不出就回 0，让调用方退回固定间隔）。 */
export function nextDayStartMs(ms, offsetMinutes = 0) {
  const date = shiftedDate(ms, offsetMinutes);
  if (!date) return 0;
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return next - shiftMs(ms, offsetMinutes);
}
