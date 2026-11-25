/**
 * 台账的宿主接线：按需扫 audit、四本账的读写口。
 *
 * 口径出处：`融合计划-v2.md` §3.2（lapse 变成交接条，人格内核侧不动）、
 * §11.6（四本账）、§12（只用功能名）、§19.2（任一步挂不上都不阻断启动）。
 *
 * 2026-11-21 起，节律那半边整体砍掉：日/周/月提醒、六小时定时器、启动扫描、
 * `turn/end` 投递、第五本「待提醒」账、以及两份状态文件（`rhythm-state.json` /
 * `ledger-state.json`）全部删除。留下的只有「扫描」这个逻辑本身，改成**按需**：
 * 人/模型说一声才扫一次，扫出来的当场列出来，不设游标、不在没人看的时候往库里堆流水。
 *
 * 判断在纯模块里（`lib/ledger/*.js`），落盘只在 `lib/ledger/store.js`；
 * 这一层只管「把 api 和读写口接起来」，不注册工具、不注册命令、不占系统提示段。
 * 人格内核侧一个字节都不动：这里只读 `audit.jsonl` 与 `api.paths`。
 */
import { HANDOFF_DONE, HANDOFF_IGNORED, HANDOFF_OPEN, rowsOf, rowsWithStatus } from './books.js';
import { appendToBook, ledgerCounts, patchBook, readAuditRecords, rowsInBook, vaultProblem } from './store.js';
import { eventCells, pendingFills } from './event.js';
import { handoffCells, openHandoffCells, scanLapsed } from './lapse.js';

/**
 * 扫描的地板：只认「最大序号往前这么多条」里的 lapsed。
 *
 * 为什么要有它：2026-11-05 真机第一次扫描把 `audit.jsonl` 里 34 条**历史** lapsed
 * 一次性全灌进了 `台账/待交接.md`，待交接从 0 条涨到 55 行，全是几个月前的旧承诺。
 * 那不是「提醒」，那是把旧账重印一遍。有了地板，只接最近的，
 * 更早的算历史、不补账；账上按幂等键去重，反复扫也不会重复写。
 */
export const FIRST_SCAN_FLOOR = 200;

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
 * 而 0 能通过 `isFinite`，于是「没传」会被当成「传了 UTC」，事件账里「今天」的判断整体偏一个时区。
 */
function offsetOr(value) {
  if (value === null || value === undefined || value === '') return -new Date().getTimezoneOffset();
  return Number.isFinite(Number(value)) ? Number(value) : -new Date().getTimezoneOffset();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD`（按给定偏移算的当地日期）。给不出就回空串。 */
function dayKeyOf(ms, offsetMinutes = 0) {
  const value = Number(ms);
  if (Number.isFinite(value) === false) return '';
  const offset = Number(offsetMinutes);
  const date = new Date(value + (Number.isFinite(offset) ? offset : 0) * 60 * 1000);
  if (Number.isFinite(date.getTime()) === false) return '';
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** 库路径只从设置页那份配置里读（§13：不探测、不预填）。 */
export function vaultOf(api) {
  const config = api?.getConfig?.() ?? {};
  return text(config?.knowledge?.vaultPath);
}

/** audit.jsonl：人格内核的审计日志，本模块只读。 */
export function auditFileOf(api) {
  return text(api?.paths?.audit);
}

/**
 * 按需扫一次 audit：把 lapsed 事件写进待交接，把人格状态里未结的条目也落进去。
 *
 * 时间由调用方给（`ms` / `offsetMinutes`），所以这一条能拿假日期测；
 * 单独调用时不传就按当下的机器时钟算（这是接线层，不是纯模块）。
 * 回 `{added}` 是这次**真的新写进去**的那几条，供人/模型当场看；`skipped` 是账上已有的。
 */
export function scanLapseOnce({ api, at = '', ms = Date.now(), offsetMinutes = null } = {}) {
  const vaultPath = vaultOf(api);
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem };
  const audited = readAuditRecords(auditFileOf(api));
  const scan = scanLapsed({ records: audited.records, firstFloor: FIRST_SCAN_FLOOR });

  const written = [];
  const added = [];
  const skipped = [];
  const failed = [];
  for (const item of scan.items) {
    const done = appendToBook({ vaultPath, book: '待交接', cells: handoffCells({ item, at }) });
    if (done.ok !== true) failed.push({ key: item.key, reason: done.reason });
    else if (done.wrote === true) {
      written.push(item.key);
      added.push({ key: item.key, at: item.at, what: item.text });
    } else skipped.push(item.key);
  }

  // 未完结三类（方案 §3c）：人格状态里的未结条目也进待交接，
  // 但它和 lapse 是两种东西 —— lapse 是「答应了没做到」，未结是「还悬着」。
  // 键里带类别，所以同一件事换类会另起一行（真的变了，不算重复写）。
  const openRows = [];
  const openAdded = [];
  const notes = [];
  try {
    const state = typeof api?.getState === 'function' ? api.getState() : null;
    const topics = state?.memory?.openTopics ?? [];
    for (const item of Array.isArray(topics) ? topics : []) {
      if (item?.resolved === true || item?.promoted === true) continue;
      const cells = openHandoffCells({ item, at });
      if (!cells) continue;
      const done = appendToBook({ vaultPath, book: '待交接', cells });
      if (done.ok !== true) failed.push({ key: cells[1], reason: done.reason });
      else if (done.wrote === true) {
        openRows.push(cells[1]);
        openAdded.push({ key: cells[1], at: cells[0], what: cells[2] });
      }
    }
  } catch (error) {
    // 拿不到状态不算失败：lapse 那条路已经写好了，别把整批算崩。
    notes.push(`未完结三类没写进待交接：${String(error?.message ?? error)}`);
  }

  const stamp = text(at) === '' ? isoOf(ms) : text(at);
  return {
    ok: true,
    at: stamp,
    seen: scan.items.length,
    written,
    added,
    skipped,
    failed,
    openRows,
    openAdded,
    notes,
    floored: scan.floored,
    broken: audited.broken,
    auditMissing: audited.missing === true,
  };
}

/** 事件这本账的写入口（当场那一行；判断/结果/教训没给就落「待补」，隔天再补）。 */
export function appendEvent({ api, at = '', type = '', what = '', judgment = '', result = '', lesson = '' } = {}) {
  return appendToBook({ vaultPath: vaultOf(api), book: '事件', cells: eventCells({ at, type, what, judgment, result, lesson }) });
}

export function appendDeviation({ api, scene = '', deviation = '', reason = '', fix = '' } = {}) {
  return appendToBook({ vaultPath: vaultOf(api), book: '偏离', cells: { 场景: scene, 偏离: deviation, 原因: reason, 改法: fix } });
}

export function appendDissent({ api, at = '', topic = '', mine = '', yours = '', handling = '' } = {}) {
  return appendToBook({ vaultPath: vaultOf(api), book: '异议', cells: { 时间: at, 议题: topic, 我的看法: mine, 你的看法: yours, 处理: handling } });
}

/**
 * 待交接那本账的读法：默认只列还欠着的。
 *
 * `limit` 给了就只列最近这么多条（账是往末尾追加的），并报 `matched`/`limited`——
 * 待交接可能堆到几百行，一口气念完没有意义，先给最新的几条。
 */
export function handoffList({ api, status = HANDOFF_OPEN, limit = 0 } = {}) {
  const vaultPath = vaultOf(api);
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem, rows: [], total: 0, matched: 0, limited: false };
  const book = rowsInBook({ vaultPath, book: '待交接' });
  const picked = status === '' ? rowsOf('待交接', book.text) : rowsWithStatus('待交接', book.text, status);
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  const shown = cap > 0 && picked.length > cap ? picked.slice(-cap) : picked;
  return {
    ok: true,
    rows: shown.map((row) => ({ index: row.index, at: row.cells[0], key: row.cells[1], what: row.cells[2], status: row.cells[3] })),
    total: rowsOf('待交接', book.text).length,
    matched: picked.length,
    limited: shown.length < picked.length,
  };
}

/**
 * 人确认之后标结（或手动忽略）。
 *
 * 只改台账那一格状态，**不碰人格内核**：§3.2 那句「人格内核侧不动」按字面执行，
 * 内核里那条 lapsed 已经是终态，插件不替它写回去。
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

/** 只读一格：四本账各有多少行、还欠着什么、该补几行。 */
export function ledgerInfo({ api, ms = Date.now(), offsetMinutes = null } = {}) {
  const vaultPath = vaultOf(api);
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: true, ready: false, reason: problem, books: {}, rows: 0 };

  const counts = ledgerCounts(vaultPath);
  const handoff = rowsInBook({ vaultPath, book: '待交接' });
  const events = rowsInBook({ vaultPath, book: '事件' });
  return {
    ok: true,
    ready: true,
    root: counts.root,
    books: counts.books,
    rows: counts.rows,
    handoffs: rowsWithStatus('待交接', handoff.text, HANDOFF_OPEN).length,
    fills: pendingFills({ text: events.text, today: dayKeyOf(ms, offsetOr(offsetMinutes)), minDays: 1 }).length,
  };
}

/**
 * 给宿主那一层用的读写口（`lib/host.js` 接命令和工具时用）。
 *
 * 不挂定时器、不挂会话钩子、不碰 ctx：扫 audit 这件事只由 `scan()` 触发，
 * 谁触发谁就能立刻看到结果。返回的每一项都只是把 `api` 绑好的函数。
 */
export function createLedger({ api } = {}) {
  return {
    info: () => ledgerInfo({ api }),
    scan: (options = {}) => scanLapseOnce({ api, ...options }),
    appendEvent: (options = {}) => appendEvent({ api, ...options }),
    appendDeviation: (options = {}) => appendDeviation({ api, ...options }),
    appendDissent: (options = {}) => appendDissent({ api, ...options }),
    handoffs: (options = {}) => handoffList({ api, ...options }),
    settleHandoff: (options = {}) => settleHandoff({ api, ...options }),
    pendingFills: (options = {}) => pendingFillList({ api, ...options }),
    fillEvent: (options = {}) => fillEvent({ api, ...options }),
  };
}
