/**
 * 台账与提醒节奏的宿主接线。
 *
 * 口径出处：`融合计划-v2.md` §5 的 P4 行（日/周/月节律、lapse 交接、只追加台账）、
 * §3.2（lapse 变成交接条，人格内核侧不动）、D5（插件内定时为主、计划任务兜底）、
 * §11.6（五本账）、§12（只用功能名）、§19.2（任一步挂不上都不阻断启动）。
 *
 * 这一层只决定「什么时候做什么」：判断在 `lib/ledger/*.js` 与 `lib/rhythm/*.js` 的纯模块里，
 * 落盘在 `lib/ledger/store.js` 与 `lib/rhythm/store.js`。挂载风格照 `lib/ctx/host-bridge.js`：
 * keep() 收 warnings、ctx.effect 收尾、任何一项挂不上都不拖垮插件启动。
 *
 * 三条自己定下的口径（任务允许自定，理由写在这）：
 *   1. **提醒只投给会话，不投给定时器。** 定时器只管「该扫了」；说话挂在 `turn/end` 上，
 *      而且**投出去了才记账**（写 fired + 在待提醒里落一行）。没有会话的时候定时器说了也没人听见，
 *      所以它不烧键——这样「提醒只出现一次」是「真的出现过一次」，不是「被算过一次」。
 *   2. **lapse 游标只在整批都写成功时才推进。** 中途写不动（库掉线之类）就留在原地下一轮重扫；
 *      账本按幂等键去重，重扫不会重复写。
 *   3. **第一次装的那一天只报「日」。** 没有状态文件时先落一个种子：把当前 ISO 周与年月记成已报，
 *      日键留空。理由：周/月是回顾，「这一周/这个月」在装之前就开始了，不该由插件追认；
 *      日是「今天这一格」，装上当天说一句不冒犯人，也不会一开口就三条一起上。
 *
 * 人格内核侧一个字节都不动：这里只读 `audit.jsonl` 与 `api.paths`，persona 的状态一概不碰。
 */
import {
  EVENT_TYPE_HINT,
  HANDOFF_DONE,
  HANDOFF_IGNORED,
  HANDOFF_OPEN,
  REMINDER_PENDING,
  REMINDER_REPORTED,
  rowsOf,
  rowsWithStatus,
} from './books.js';
import { appendToBook, ledgerCounts, ledgerStatePath, patchBook, readAuditRecords, readLedgerState, rowsInBook, vaultProblem, writeLedgerState } from './store.js';
import { eventCells, pendingFills } from './event.js';
import { handoffCells, openHandoffCells, scanLapsed } from './lapse.js';
import { dayKeyOf, dueKinds, keysOf, kindFromKey } from '../rhythm/period.js';
import { fallbackCells, injectText, reportedCells, tickPlan, valueOf } from '../rhythm/plan.js';
import { readRhythmState, rhythmStateExists, rhythmStatePath, writeRhythmState } from '../rhythm/store.js';
import { messageFor } from '../inbox.js';

/** 定时器间隔：每 6 小时扫一次 audit；启动也扫一次——「每天扫」只会多不会少，多扫是幂等的。 */
export const TICK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * 首次扫描的地板：游标为 0 时，只认「最大序号往前这么多条」里的 lapsed。
 *
 * 为什么要有它：2026-11-05 真机第一次扫描把 `audit.jsonl` 里 34 条**历史** lapsed
 * 一次性全灌进了 `台账/待交接.md`，待交接从 0 条涨到 55 行，全是几个月前的旧承诺。
 * 那不是「提醒」，那是把旧账重印一遍。有了地板，首次扫描只接最近的，
 * 更早的算历史、不补账；之后靠游标正常增量。
 */
export const FIRST_SCAN_FLOOR = 200;

/** 三档键的名字：写 fired 的时候用它俩对齐。 */
const KINDS = Object.freeze(['day', 'week', 'month']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isoOf(ms) {
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

/**
 * 时区偏移：分钟，东为正（+08:00 = 480）。
 *
 * **不给就按本机时区算**。别把它写成一句 `Number.isFinite(Number(value))`——`Number(null)` 是 0，
 * 而 0 能通过 `isFinite`，于是「没传」会被当成「传了 UTC」，日/周/月那几个键整体偏一个时区
 * （本地凌晨那几小时会被算到前一天）。既有测试全都显式传了 480，正好盖不到这条默认路径。
 */
function offsetOr(value) {
  if (value === null || value === undefined || value === '') return -new Date().getTimezoneOffset();
  return Number.isFinite(Number(value)) ? Number(value) : -new Date().getTimezoneOffset();
}

/** 库路径只从设置页那份配置里读（§13：不探测、不预填）。 */
export function vaultOf(api) {
  const config = api?.getConfig?.() ?? {};
  return text(config?.knowledge?.vaultPath);
}

/** 插件数据目录：人格内核的 api 上就挂着 paths（state.json / audit.jsonl 都在那儿）。 */
export function dataDirOf(api, fallback = '') {
  return text(api?.paths?.root) || text(fallback);
}

/** audit.jsonl：人格内核的审计日志，本模块只读。 */
export function auditFileOf(api) {
  return text(api?.paths?.audit);
}

/** 往会话里塞一条的形状在 `lib/inbox.js`（三处共用一份）。 */

/** 两个真读数：还欠着的交接条、隔了一天还没补的事件行。 */
function countsOf({ vaultPath, today }) {
  const handoff = rowsInBook({ vaultPath, book: '待交接' });
  const events = rowsInBook({ vaultPath, book: '事件' });
  return {
    handoffs: rowsWithStatus('待交接', handoff.text, HANDOFF_OPEN).length,
    fills: pendingFills({ text: events.text, today, minDays: 1 }).length,
  };
}

/**
 * 扫一次 audit 的新增 lapsed 事件，写进待交接。
 *
 * 时间由调用方给（`ms` / `offsetMinutes`），所以这一条能拿假日期测；
 * 单独调用时不传就按当下的机器时钟算（这是接线层，不是纯模块）。
 */
export function scanLapseOnce({ api, at = '', ms = Date.now(), offsetMinutes = null } = {}) {
  const vaultPath = vaultOf(api);
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem };
  const dataDir = dataDirOf(api);
  const audited = readAuditRecords(auditFileOf(api));
  const before = readLedgerState(ledgerStatePath(dataDir));
  // 首次扫描的地板：游标为 0 时只取最近 FIRST_SCAN_FLOOR 条，不把历史 lapsed 全灌进来。
  const scan = scanLapsed({ records: audited.records, afterSeq: before.lapseSeq, firstFloor: FIRST_SCAN_FLOOR });

  const written = [];
  const skipped = [];
  const failed = [];
  for (const item of scan.items) {
    const done = appendToBook({ vaultPath, book: '待交接', cells: handoffCells({ item, at }) });
    if (done.ok !== true) failed.push({ key: item.key, reason: done.reason });
    else if (done.wrote === true) written.push(item.key);
    else skipped.push(item.key);
  }

  // 未完结三类（第四批 §3c）：人格状态里的未结条目也进待交接，
  // 但它和 lapse 是两种东西 —— lapse 是「答应了没做到」，未结是「还悬着」。
  // 键里带类别，所以同一件事换类会另起一行（真的变了，不算重复写）。
  const openRows = [];
  try {
    const state = typeof api?.getState === 'function' ? api.getState() : null;
    const topics = state?.memory?.openTopics ?? [];
    for (const item of Array.isArray(topics) ? topics : []) {
      if (item?.resolved === true || item?.promoted === true) continue;
      const cells = openHandoffCells({ item, at });
      if (!cells) continue;
      const done = appendToBook({ vaultPath, book: '待交接', cells });
      if (done.ok !== true) failed.push({ key: cells[1], reason: done.reason });
      else if (done.wrote === true) openRows.push(cells[1]);
    }
  } catch (error) {
    // 拿不到状态不算失败：lapse 那条路已经写好了，别把整批游标卡住。
    warnings.push(`未完结三类没写进待交接：${String(error?.message ?? error)}`);
  }

  const stamp = text(at) === '' ? isoOf(ms) : text(at);
  const today = dayKeyOf(ms, offsetOr(offsetMinutes));
  const saved = saveLedgerState(dataDir, before, {
    at: stamp,
    // 整批都写进去才推进游标；有一条没写成就原地等下一轮重扫（账上会按幂等键跳过已写过的）。
    lapseSeq: failed.length === 0 ? Math.max(scan.maxSeq, scan.from) : before.lapseSeq,
    lastScanDay: today,
  });
  return {
    ok: true,
    at: stamp,
    seen: scan.items.length,
    written,
    skipped,
    failed,
    openRows,
    reset: scan.reset,
    broken: audited.broken,
    auditMissing: audited.missing === true,
    state: saved,
  };
}

/** 状态没变就不写：少写一次就少一层 .bak，也少一次没必要的 mtime 变化。 */
function saveLedgerState(dataDir, before, patch) {
  const next = {
    version: 1,
    lapseSeq: patch.lapseSeq,
    lastScanDay: patch.lastScanDay,
    updatedAt: patch.at,
  };
  if (next.lapseSeq === before.lapseSeq && next.lastScanDay === before.lastScanDay) {
    return { ok: true, wrote: false };
  }
  const done = writeLedgerState(ledgerStatePath(dataDir), next);
  return done.ok === true ? { ok: true, wrote: true, backup: done.backup ?? null } : { ok: false, reason: done.reason };
}

/**
 * 放进一次「日/周/月」该说的话（纯看数：不落盘、不投递）。
 * `ms` 与 `offsetMinutes` 由调用方给，所以拿假时间就能测。
 */
export function previewReminders({ api, ms = Date.now(), offsetMinutes = null, counts = null } = {}) {
  const vaultPath = vaultOf(api);
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem, report: [], fire: [], covered: [] };
  const offset = offsetOr(offsetMinutes);
  const keys = keysOf(ms, offset);
  const state = readRhythmState(rhythmStatePath(dataDirOf(api)));
  const book = rowsInBook({ vaultPath, book: '待提醒' });
  const pending = rowsWithStatus('待提醒', book.text, REMINDER_PENDING).map((row) => ({ index: row.index, key: row.cells[1], what: row.cells[2] }));
  const plan = tickPlan({
    keys,
    fired: state.fired,
    pending,
    coveredKeys: rowsOf('待提醒', book.text).map((row) => row.cells[1]),
    counts: counts ?? countsOf({ vaultPath, today: dayKeyOf(ms, offset) }),
  });
  return { ok: true, keys, fired: state.fired, ...plan };
}

/**
 * 兜底那条路：DSH 没在跑的时候，计划任务只能往 `台账/待提醒.md` 落一行。
 *
 * 同一个周期键只落一行（键去重），所以计划任务重复触发只是白跑一次。
 * 真正的补报发生在下次启动后的第一次会话收尾（announce）：补报过就标已报，不再补第二次。
 */
export function fallbackReminder({ api, kind = '', value = '', key = '', at = '' } = {}) {
  const vaultPath = vaultOf(api);
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem };
  const which = kindFromKey(kind) === '' ? kindFromKey(key) : kindFromKey(kind);
  const period = text(value) === '' ? valueOf(key) : text(value);
  if (which === '' || period === '') return { ok: false, reason: 'bad-period' };
  const stamp = text(at) === '' ? isoOf(Date.now()) : text(at);
  return appendToBook({ vaultPath, book: '待提醒', cells: fallbackCells({ kind: which, value: period, at: stamp }) });
}

/** 事件这本账的写入口（当场那一行；判断/结果/教训没给就落「待补」，等下次启动再补）。 */
export function appendEvent({ api, at = '', type = '', what = '', judgment = '', result = '', lesson = '' } = {}) {
  return appendToBook({ vaultPath: vaultOf(api), book: '事件', cells: eventCells({ at, type, what, judgment, result, lesson }) });
}

export function appendDeviation({ api, scene = '', deviation = '', reason = '', fix = '' } = {}) {
  return appendToBook({ vaultPath: vaultOf(api), book: '偏离', cells: { 场景: scene, 偏离: deviation, 原因: reason, 改法: fix } });
}

export function appendDissent({ api, at = '', topic = '', mine = '', yours = '', handling = '' } = {}) {
  return appendToBook({ vaultPath: vaultOf(api), book: '异议', cells: { 时间: at, 议题: topic, 我的看法: mine, 你的看法: yours, 处理: handling } });
}

/** 待交接那本账的读法：默认只列还欠着的。 */
export function handoffList({ api, status = HANDOFF_OPEN } = {}) {
  const vaultPath = vaultOf(api);
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem, rows: [] };
  const book = rowsInBook({ vaultPath, book: '待交接' });
  const picked = status === '' ? rowsOf('待交接', book.text) : rowsWithStatus('待交接', book.text, status);
  return {
    ok: true,
    rows: picked.map((row) => ({ index: row.index, at: row.cells[0], key: row.cells[1], what: row.cells[2], status: row.cells[3] })),
    total: rowsOf('待交接', book.text).length,
  };
}

/**
 * 人确认之后标结（或手动忽略）。
 *
 * 只改台账那一格状态，**不碰人格内核**：§3.2 那句「人格内核侧不动」按字面执行，
 * 内核里那条 lapsed 已经是终态，插件不替它写回去。哪天要连内核一起结，那是另一件事，
 * 得单独说清楚再挂 `api.settleCommitment`。
 */
export function settleHandoff({ api, key = '', action = 'settle' } = {}) {
  const status = action === 'ignore' ? HANDOFF_IGNORED : action === 'settle' ? HANDOFF_DONE : '';
  if (status === '') return { ok: false, reason: 'bad-action' };
  return patchBook({ vaultPath: vaultOf(api), book: '待交接', key, status });
}

/** 事件里隔了一天还没定的那几行。 */
export function pendingFillList({ api, ms = Date.now(), offsetMinutes = null, minDays = 1 } = {}) {
  const vaultPath = vaultOf(api);
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem, rows: [] };
  const book = rowsInBook({ vaultPath, book: '事件' });
  return { ok: true, rows: pendingFills({ text: book.text, today: dayKeyOf(ms, offsetOr(offsetMinutes)), minDays }) };
}

/** 补齐：只替换「待补」那一格，其余字节不动（口径见 books.js 头注）。 */
export function fillEvent({ api, key = '', patch = {} } = {}) {
  return patchBook({ vaultPath: vaultOf(api), book: '事件', key, patch });
}

/** 只读一格：几本账各有多少行、还欠着什么、节律报到哪了。 */
export function ledgerInfo({ api, ms = Date.now(), offsetMinutes = null } = {}) {
  const vaultPath = vaultOf(api);
  const offset = offsetOr(offsetMinutes);
  const keys = keysOf(ms, offset);
  const rhythm = readRhythmState(rhythmStatePath(dataDirOf(api)));
  const base = { rhythm: { fired: rhythm.fired, lastReport: rhythm.lastReport }, keys };
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: true, ready: false, reason: problem, books: {}, rows: 0, ...base };

  const counts = ledgerCounts(vaultPath);
  const handoff = rowsInBook({ vaultPath, book: '待交接' });
  const reminders = rowsInBook({ vaultPath, book: '待提醒' });
  const events = rowsInBook({ vaultPath, book: '事件' });
  return {
    ok: true,
    ready: true,
    root: counts.root,
    books: counts.books,
    rows: counts.rows,
    handoffs: rowsWithStatus('待交接', handoff.text, HANDOFF_OPEN).length,
    reminders: {
      pending: rowsWithStatus('待提醒', reminders.text, REMINDER_PENDING).length,
      reported: rowsWithStatus('待提醒', reminders.text, REMINDER_REPORTED).length,
    },
    fills: pendingFills({ text: events.text, today: dayKeyOf(ms, offset), minDays: 1 }).length,
    due: dueKinds({ keys, fired: rhythm.fired }),
    ...base,
  };
}

/** 待提醒那本账目前的状态（只读，给人看流水用）。 */
export function reminderRows({ api } = {}) {
  const vaultPath = vaultOf(api);
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem, rows: [] };
  const book = rowsInBook({ vaultPath, book: '待提醒' });
  return {
    ok: true,
    rows: rowsOf('待提醒', book.text).map((row) => ({ index: row.index, at: row.cells[0], key: row.cells[1], what: row.cells[2], status: row.cells[3] })),
  };
}

/**
 * 宿主接线：一个定时器（每天扫 audit）+ 一个会话钩子（该提醒时投一次）。
 *
 * 这里不注册工具、不注册命令、也不占系统提示段——那几样由 Lead 接线；
 * 返回的 handle 就是给那条线用的写入口与读数口。
 */
export function registerLedger({ ctx, api, log = () => {}, dataDir: dataDirOption = '', everyMs = TICK_EVERY_MS, clock = null, offsetMinutes = null } = {}) {
  const warnings = [];
  const disposed = [];
  const keep = (label, fn) => {
    try {
      const off = fn();
      if (typeof off === 'function') disposed.push(off);
    } catch (error) {
      const detail = `${label}：${String(error?.message ?? error)}`;
      warnings.push(detail);
      log(`[dsh-whale-pal] 台账有一项没挂上，${detail}`);
    }
  };
  const service = (key) => {
    try {
      return ctx?.[key] ?? null;
    } catch {
      return null;
    }
  };

  const readClock = typeof clock === 'function' ? clock : () => Date.now();
  const offsetOf = () => offsetOr(offsetMinutes);
  const dirOf = () => dataDirOf(api, dataDirOption);

  /** 记下哪一档报到哪个键了。`report` 为 true 时顺带把「上次真报出去」也更新掉。 */
  const rememberFired = (fired, at, { report = true } = {}) => {
    const file = rhythmStatePath(dirOf());
    const before = readRhythmState(file);
    const sameFired = KINDS.every((kind) => (before.fired[kind] ?? '') === (fired[kind] ?? ''));
    if (sameFired && report !== true) return { ok: true, wrote: false };
    const done = writeRhythmState(file, {
      fired,
      lastReport: report === true ? at : before.lastReport,
      updatedAt: at,
    });
    return done.ok === true ? { ok: true, wrote: true } : { ok: false, reason: done.reason };
  };

  /**
   * 「每天扫一次」：跨了一天就扫（幂等），定时器与启动都走这一条。
   * 没跨天也不是强制的时候什么都不做——省掉一次没必要的读盘与写盘。
   */
  const tick = ({ at = '', force = false } = {}) => {
    const ms = readClock();
    const today = dayKeyOf(ms, offsetOf());
    const stamp = text(at) === '' ? isoOf(ms) : text(at);
    const state = readLedgerState(ledgerStatePath(dirOf()));
    if (force !== true && state.lastScanDay === today) return { ok: true, at: stamp, scanned: false };
    const lapse = scanLapseOnce({ api, at: stamp, ms, offsetMinutes: offsetOf() });
    if (lapse.ok !== true) return { ok: false, at: stamp, scanned: false, reason: lapse.reason, lapse };
    if (Array.isArray(lapse.failed) && lapse.failed.length > 0) {
      warnings.push(`lapse 有 ${lapse.failed.length} 条没写进待交接：${lapse.failed.map((one) => one.reason).join('、')}`);
    }
    return { ok: true, at: stamp, scanned: true, lapse };
  };

  /**
   * 该说话的时候说一次。
   *
   * 只投给会话：投出去了才记账（补报的标已报、自己算的落一行已报、fired 写盘）。
   * 没有 agent.inject 就一个字节都不动——那一格留给下一次有人在的时候。
   */
  const announce = (agent, { at = '' } = {}) => {
    const vaultPath = vaultOf(api);
    if (vaultProblem(vaultPath) !== null) return '';
    const ms = readClock();
    const offset = offsetOf();
    const stamp = text(at) === '' ? isoOf(ms) : text(at);
    const today = dayKeyOf(ms, offset);

    const state = readRhythmState(rhythmStatePath(dirOf()));
    const keys = keysOf(ms, offset);
    const due = dueKinds({ keys, fired: state.fired });
    const book = rowsInBook({ vaultPath, book: '待提醒' });
    const pending = rowsWithStatus('待提醒', book.text, REMINDER_PENDING).map((row) => ({ index: row.index, key: row.cells[1], what: row.cells[2] }));
    if (due.length === 0 && pending.length === 0) return '';

    const plan = tickPlan({
      keys,
      fired: state.fired,
      pending,
      coveredKeys: rowsOf('待提醒', book.text).map((row) => row.cells[1]),
      counts: countsOf({ vaultPath, today }),
    });
    const nextFired = { ...state.fired };
    for (const one of [...plan.fire, ...plan.covered]) nextFired[one.kind] = one.value;
    const lines = [...plan.report.map((one) => one.text), ...plan.fire.map((one) => one.text)];

    // 被兜底那行覆盖住的周期：只记账，不重复说。没什么可说的时候也别把 fired 白写一遍。
    if (lines.length === 0) {
      if (plan.covered.length > 0) rememberFired(nextFired, stamp, { report: false });
      return '';
    }
    if (typeof agent?.inject !== 'function') return '';

    const body = injectText(lines);
    try {
      agent.inject(messageFor(body));
    } catch (error) {
      warnings.push(`提醒没塞进去：${String(error?.message ?? error)}`);
      return '';
    }

    // 投出去了才写账：先把兜底那几行标已报，再给自己算的那几档各落一行已报，最后写 fired。
    // 顺序有意：万一 fired 写盘失败，待提醒里那几行已经在了，下一轮按「已经有行」让位，不会再报一次。
    const said = new Set();
    for (const one of plan.report) {
      if (said.has(one.key)) continue;
      said.add(one.key);
      const done = patchBook({ vaultPath, book: '待提醒', key: one.key, status: REMINDER_REPORTED });
      if (done.ok !== true) warnings.push(`补报的那行没标上已报（${one.key}）：${done.reason}`);
    }
    for (const one of plan.fire) {
      const done = appendToBook({ vaultPath, book: '待提醒', cells: reportedCells({ key: one.key, text: one.text, at: stamp }) });
      if (done.ok !== true) warnings.push(`提醒流水没落成（${one.key}）：${done.reason}`);
    }
    const remembered = rememberFired(nextFired, stamp, { report: true });
    if (remembered.ok !== true) warnings.push(`fired 没写进数据目录：${remembered.reason}`);
    return body;
  };

  // ---- 第一次装：先落种子（周/月记成已报，日留空），免得一开口就是三条。
  try {
    const file = rhythmStatePath(dirOf());
    if (dirOf() !== '' && rhythmStateExists(file) === false) {
      const keys = keysOf(readClock(), offsetOf());
      rememberFired({ day: '', week: keys.week, month: keys.month }, isoOf(readClock()), { report: false });
    }
  } catch (error) {
    warnings.push(`节律种子没落成：${String(error?.message ?? error)}`);
  }

  // ---- 启动先扫一遍：上次没跑完的那批 lapsed 事件，开机就接上。
  try {
    tick({ force: true });
  } catch (error) {
    warnings.push(`启动那次扫描没跑成：${String(error?.message ?? error)}`);
  }

  // ---- 定时器：DSH 一直开着的时候也每天扫一次。
  if (Number(everyMs) > 0) {
    keep('定时器没挂上', () => {
      const effect = service('effect');
      if (typeof effect !== 'function') throw new Error('宿主没给 ctx.effect');
      return effect(() => {
        const timer = setInterval(() => {
          try {
            tick();
          } catch (error) {
            warnings.push(`定时扫描没跑成：${String(error?.message ?? error)}`);
          }
        }, Number(everyMs));
        // 定时器不该拖着进程不让退出。
        if (typeof timer?.unref === 'function') timer.unref();
        return () => clearInterval(timer);
      }, 'dsh-whale-pal: ledger tick');
    });
  }

  // ---- 会话钩子：一轮收尾时正好说这一句（跟 ctx 那一路同一个挂点）。
  //
  // 挂点是 **`session/event`**，不是 `turn/end`：`turn/end` 是 `session.append()`
  // 写进日志的事件，不经过 cordis 派发 —— 它只调 `commit()`，而 commit 派发的是
  // `session/event`。早先写 `per.on('turn/end', …)`，那个名字永远不会响。
  // 宿主签名：`'session/event'(session: Session, event: SessionEvent): void`
  const on = service('on');
  const agentsBySession = new WeakMap();
  if (typeof on === 'function') {
    // 先建 session → agent 映射：`session/event` 只给 (session, event)，拿不到 agent。
    keep('agent 映射没挂上', () =>
      on('agent/created', (payload) => {
        const agent = payload?.agent ?? payload;
        const session = agent?.session;
        if (session && typeof session === 'object') agentsBySession.set(session, agent);
      }),
    );
    keep('提醒没挂上', () =>
      on('session/event', (session, event) => {
        if (event?.type !== 'turn/end') return;
        const agent = session && typeof session === 'object' ? agentsBySession.get(session) : null;
        if (!agent) return;
        try {
          announce(agent);
        } catch (error) {
          warnings.push(`提醒没算成：${String(error?.message ?? error)}`);
        }
      }),
    );
  } else {
    warnings.push('提醒没挂上：宿主没给 ctx.on，只能等 /whale 那条线自己去问');
  }

  return {
    warnings,
    tick,
    announce,
    info: () => ledgerInfo({ api, ms: readClock(), offsetMinutes: offsetOf() }),
    preview: () => previewReminders({ api, ms: readClock(), offsetMinutes: offsetOf() }),
    fallback: (options = {}) => fallbackReminder({ api, ...options }),
    appendEvent: (options = {}) => appendEvent({ api, ...options }),
    appendDeviation: (options = {}) => appendDeviation({ api, ...options }),
    appendDissent: (options = {}) => appendDissent({ api, ...options }),
    handoffs: (options = {}) => handoffList({ api, ...options }),
    settleHandoff: (options = {}) => settleHandoff({ api, ...options }),
    pendingFills: (options = {}) => pendingFillList({ api, ms: readClock(), offsetMinutes: offsetOf(), ...options }),
    fillEvent: (options = {}) => fillEvent({ api, ...options }),
    reminderRows: () => reminderRows({ api }),
    scanLapse: (options = {}) => scanLapseOnce({ api, ms: readClock(), offsetMinutes: offsetOf(), ...options }),
    dispose: () => {
      for (const off of disposed.splice(0)) {
        try {
          if (typeof off === 'function') off();
        } catch {
          /* 卸载时抛错不值得再记一条 */
        }
      }
    },
  };
}
