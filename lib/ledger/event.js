/**
 * 事件这本账的当场/补齐口径。
 *
 * 口径出处：`融合计划-v2.md` §11.6——
 * 「判断列抄当时的原话，不美化」「教训列写不出具体动作就写『无新增』，宁缺不凑」
 * 「不当场定论：事件列当场写；判断与教训隔到下次启动或 24 小时后补」。
 *
 * 为什么把「隔多久补」也算成纯函数：这条规则要能判、能测（「明天启动才列出来」
 * 不能靠模型自己记），所以把「今天」当参数传进来，用日期差判，不看时钟也不看时区。
 *
 * 纯模块：不碰盘、不读环境变量、不看时钟。
 */
import { PLACEHOLDER, oneLine } from './table.js';
import { EVENT_TYPES, bookOf, keyOfRow, rowsOf } from './books.js';

/** 能补的三格，顺序就是 §11.6 里那三列。 */
export const FILL_COLUMNS = Object.freeze(['当时的判断', '结果', '教训']);

const EVENT = bookOf('事件');
const FILL_INDEXES = FILL_COLUMNS.map((name) => EVENT.columns.indexOf(name));

/** 当天写进事件账的一行；没给的补齐格一律落成「待补」。 */
export function eventCells({ at = '', type = '', what = '', judgment = '', result = '', lesson = '' } = {}) {
  const given = [at, type, what, judgment, result, lesson].map(oneLine);
  return given.map((cell, i) => (cell === '' && i >= FILL_INDEXES[0] ? PLACEHOLDER : cell));
}

/** 类型白名单只认 books.js 那一份，别在两处各写一遍。 */
export function isEventType(value) {
  return EVENT_TYPES.includes(oneLine(value));
}

/** `YYYY-MM-DD` → UTC 毫秒；读不出来回 null（不抛，也不猜今天）。 */
function dayMs(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(day ?? '').trim());
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) ? ms : null;
}

/** 两个日期差几天。给不出就回 null——算不出来的时候宁可不提示，也不瞎提示。 */
export function dayGap(fromDay, toDay) {
  const left = dayMs(fromDay);
  const right = dayMs(toDay);
  if (left === null || right === null) return null;
  return Math.round((right - left) / (24 * 60 * 60 * 1000));
}

/**
 * 该补的事件行：还有「待补」格、且写下它的那天已经过去了最少 minDays 天。
 *
 * 默认 minDays=1 就是 §11.6 那句「隔到下次启动或 24 小时后」：当天写的先不催，
 * 第二天（或更晚的某次启动）才列出来等人补。今天没写事件的自然不会出现。
 */
export function pendingFills({ text = '', today = '', minDays = 1 } = {}) {
  const out = [];
  for (const row of rowsOf('事件', text)) {
    const missing = FILL_COLUMNS.filter((_, k) => row.cells[FILL_INDEXES[k]] === PLACEHOLDER);
    if (missing.length === 0) continue;
    const ageDays = dayGap(row.cells[0].slice(0, 10), today);
    if (ageDays === null || ageDays < minDays) continue;
    out.push({
      index: row.index,
      // 键跟 books.js 那一套算，别在这儿另拼一次——两处拼法一分开就会对不上。
      key: keyOfRow('事件', row.cells),
      at: row.cells[0],
      type: row.cells[1],
      what: row.cells[2],
      missing,
      ageDays,
    });
  }
  return out;
}
