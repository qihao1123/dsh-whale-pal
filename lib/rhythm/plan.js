/**
 * 一次节律该做什么：哪些周期要报、兜底落下的那一行要不要补报、文案长什么样。
 *
 * 口径出处：`融合计划-v2.md` D5——「DSH 在跑就自己算日/周/月该不该提醒；没在跑，兜底那条路
 * 只往 `台账/待提醒.md` 落一行，下次启动补报一次、不补第二次」。§13.6 的文案口径也适用：
 * 说事实、说我缺什么、不催他——所以提醒里只有「哪一天/哪一周/哪一月」和两个真实读数。
 *
 * 为什么把「已经记过一行」的键也算进来：库那边的 `待提醒.md` 是跨进程的唯一渠道。
 * 兜底那条路（计划任务）在 DSH 没跑的时候先落了一行，启动后插件自己算出来的同一个周期键
 * 必须让位——不然「补报一次」和「自己算的一次」就会变成两次提醒。
 *
 * 纯模块：不碰盘、不读环境变量、不看时钟。
 */
import { cellsOf } from '../ledger/books.js';
import { KINDS, kindFromKey, labelOf } from './period.js';

/** 周期键的完整形态：`day:2026-11-05`。台账里那一列长这样，人一眼看得出是哪一档。 */
export function fullKey(kind, value) {
  return `${String(kind ?? '').trim()}:${String(value ?? '').trim()}`;
}

/** 从完整键里取回那一档的值：`day:2026-11-05` → `2026-11-05`。 */
export function valueOf(key) {
  const parts = String(key ?? '').split(':');
  return parts.length > 1 ? parts.slice(1).join(':').trim() : '';
}

/**
 * 一句提醒的人话。
 *
 * `counts` 给了就是「自己算的那一次」，只有两个真读数（待交接条数、事件里待补行数）；
 * `counts` 为 null 就是兜底那条路落的行，只说明「当时 DSH 没在跑」。
 */
export function reminderText({ kind = '', key = '', counts = null } = {}) {
  const label = labelOf(kind);
  const value = valueOf(key);
  const head = value === '' ? label : `${label} ${value}`.trim();
  if (head === '') return '';
  if (counts === null || counts === undefined) return `${head}：当时 DSH 没在跑，先记一行`;
  const parts = [];
  if (Number(counts?.handoffs) > 0) parts.push(`待交接 ${Number(counts.handoffs)} 条`);
  if (Number(counts?.fills) > 0) parts.push(`事件里待补 ${Number(counts.fills)} 行`);
  return parts.length === 0 ? `${head}：没有欠着的事` : `${head}：${parts.join('、')}`;
}

/** 兜底那条路落的行（状态待报）。库里没人时它只能记一行，说不了读数。 */
export function fallbackCells({ kind = '', value = '', at = '' } = {}) {
  const key = fullKey(kind, value);
  const label = labelOf(kind);
  return cellsOf('待提醒', {
    时间: at,
    键: key,
    提醒什么: `${label} ${value} 该提醒一次（当时 DSH 没在跑）`.trim(),
    状态: '待报',
  });
}

/** 插件自己报过之后留的行（状态已报）：给人看的一本提醒流水。 */
export function reportedCells({ key = '', text = '', at = '' } = {}) {
  return cellsOf('待提醒', { 时间: at, 键: key, 提醒什么: text, 状态: '已报' });
}

/** 补报的话：把兜底那行原文端出来，不另编一句。 */
export function reportText(what) {
  const body = String(what ?? '').trim();
  return body === '' ? '补报一次（兜底那条路留了一行，但没写清是什么）' : `补报：${body}`;
}

/**
 * 这一次该说什么。
 *
 * 入参：
 *   - `keys` 当前三档键（`keysOf` 给的）；
 *   - `fired` 上次报过的键（插件数据目录里那份状态）；
 *   - `pending` `待提醒.md` 里状态为「待报」的行 `[{index, key, what}]`；
 *   - `coveredKeys` `待提醒.md` 里已经出现过的键（任何状态）；
 *   - `counts` 两个真读数。
 *
 * 回 `{report, fire, covered}`：
 *   - `report` 兜底留下的行，补报一次（补完标已报）；
 *   - `fire` 自己算出来该报的档；
 *   - `covered` 已经有一行记着了，只记账不重复说。
 */
export function tickPlan({ keys = {}, fired = {}, pending = [], coveredKeys = [], counts = {} } = {}) {
  const seen = new Set();
  const report = [];
  for (const row of Array.isArray(pending) ? pending : []) {
    const key = String(row?.key ?? '').trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    report.push({ key, kind: kindFromKey(key), index: row?.index ?? -1, text: reportText(row?.what) });
  }

  const coveredSet = new Set();
  for (const key of Array.isArray(coveredKeys) ? coveredKeys : []) {
    const value = String(key ?? '').trim();
    if (value !== '') coveredSet.add(value);
  }

  const fire = [];
  const covered = [];
  for (const kind of KINDS) {
    const value = String(keys?.[kind] ?? '').trim();
    if (value === '') continue;
    if (String(fired?.[kind] ?? '') === value) continue;
    const key = fullKey(kind, value);
    if (seen.has(key) || coveredSet.has(key)) {
      covered.push({ kind, key, value, reason: 'already-logged' });
      continue;
    }
    fire.push({ kind, key, value, text: reminderText({ kind, key, counts }) });
  }
  return { report, fire, covered };
}

/** 往会话里塞的形状：每行都带插件前缀，免得看不出来是谁在说话。 */
export function injectText(lines) {
  const list = (Array.isArray(lines) ? lines : []).map((line) => String(line ?? '').trim()).filter((line) => line !== '');
  return list.map((line) => `[whale-pal] ${line}`).join('\n');
}
