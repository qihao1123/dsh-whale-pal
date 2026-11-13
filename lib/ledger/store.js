/**
 * 台账落盘层：五本账的读写、audit.jsonl 的只读扫描、lapse 游标。
 *
 * 口径出处：`融合计划-v2.md` §11.6（五本账都在库内 `台账/`，都是普通人能读的 md）、
 * §7 第 3 条（写前有 .bak、写完逐字读回、读回不一致自动回滚）与第 5 条（只追加，不改历史行）、
 * §13（库路径只能由调用方传进来，**不探测、不预填**）。
 *
 * 为什么全模块只有这一个文件 import `node:fs`：跟 `lib/ctx/store.js` 同一条硬线——
 * 判断在纯模块里，碰盘只在这一层，扫一遍 import 就能验（`test/ledger-store.test.mjs` 锁着）。
 * 库路径写空的、库不在的，一律回 `{ok:false, reason}`，**不替人建库**。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeWithBackup } from '../atomic.js';
import { appendRow, bookOf, fillRow, findByKey, rowsOf, setStatus, skeleton, BOOKS } from './books.js';

export const LEDGER_DIR = '台账';

/** lapse 游标等运行态：落插件数据目录，不落库——它不属于用户的知识。 */
export const LEDGER_STATE_FILE = 'ledger-state.json';

export function ledgerRoot(vaultPath) {
  return join(String(vaultPath ?? ''), LEDGER_DIR);
}

export function bookPath(vaultPath, file) {
  return join(ledgerRoot(vaultPath), String(file ?? ''));
}

export function ledgerStatePath(dataDir) {
  return join(String(dataDir ?? ''), LEDGER_STATE_FILE);
}

/** 读一份文本；读不到回 null，不当异常传下去。 */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 库能不能用。空路径与库不存在分开报，调用方才知道是没设还是设错了。 */
export function vaultProblem(vaultPath) {
  const root = String(vaultPath ?? '').trim();
  if (root === '') return 'vault-required';
  if (existsSync(root) === false) return 'vault-missing';
  return null;
}

/**
 * 写一次：借 lib/atomic.js 那条链路（备份 → tmp → rename → 读回 → 读回不符自动回滚）。
 * 台账在用户的库里，`.bak-*` 留着还能走 `whale_pal_rollback` 退回去，比裸写安全。
 */
function writeTextBacked(file, text) {
  const done = writeWithBackup(file, text);
  if (done.ok !== true) {
    return { ok: false, reason: done.error ?? 'write-failed', backup: done.backup ?? null, rolledBack: done.rolledBack === true };
  }
  return { ok: true, wrote: true, backup: done.backup ?? null, rolledBack: false };
}

/** 建一本账（文件在就不动）。库不在、没设库都拒绝——绝不顺着路径把库建出来。 */
export function ensureBook(vaultPath, name) {
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem };
  const book = bookOf(name);
  if (!book) return { ok: false, reason: 'unknown-book' };

  const file = bookPath(vaultPath, book.file);
  try {
    mkdirSync(ledgerRoot(vaultPath), { recursive: true });
  } catch (error) {
    return { ok: false, reason: 'mkdir-failed', detail: String(error?.message ?? error) };
  }
  if (existsSync(file)) return { ok: true, file, created: false };

  const made = writeTextBacked(file, skeleton(book));
  if (made.ok !== true) return { ok: false, reason: made.reason, file };
  return { ok: true, file, created: true };
}

/**
 * 追加一行。
 *
 * 幂等在这里收口：同一键已经在账上就**一个字节都不写**（连 .bak 都不产生）——
 * 「台账重跑不重复写」这条判据量的就是这个。写完还要按行解析读回一遍，
 * 字面写出去不等于盘上真的多了那一行。
 */
export function appendToBook({ vaultPath = '', book: name = '', cells = [] } = {}) {
  const ready = ensureBook(vaultPath, name);
  if (ready.ok !== true) return ready;
  const target = bookOf(name);
  const before = readText(ready.file) ?? '';
  const planned = appendRow({ book: target, text: before, cells });
  if (planned.ok !== true) return { ok: false, reason: planned.reason, file: ready.file };
  if (planned.wrote !== true) return { ok: true, file: ready.file, key: planned.key, wrote: false, skipped: true };

  const done = writeTextBacked(ready.file, planned.text);
  if (done.ok !== true) return { ok: false, reason: done.reason, file: ready.file, key: planned.key, rolledBack: done.rolledBack };

  const after = readText(ready.file) ?? '';
  const found = findByKey(target, after, planned.key);
  if (!found) return { ok: false, reason: 'read-back-missing', file: ready.file, key: planned.key };
  return {
    ok: true,
    file: ready.file,
    key: planned.key,
    wrote: true,
    skipped: false,
    rows: rowsOf(target, after).length,
    backup: done.backup,
  };
}

/** 补齐「待补」格 / 推一格状态。改的是同一行，只允许替换占位符或未推进的状态。 */
export function patchBook({ vaultPath = '', book: name = '', key = '', patch = {}, status = '' } = {}) {
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem };
  const target = bookOf(name);
  if (!target) return { ok: false, reason: 'unknown-book' };

  const file = bookPath(vaultPath, target.file);
  const before = readText(file);
  if (before === null) return { ok: false, reason: 'book-missing', file };

  const planned =
    status === ''
      ? fillRow({ book: target, text: before, key, patch })
      : setStatus({ book: target, text: before, key, status });
  if (planned.ok !== true) return { ok: false, reason: planned.reason, file, key, filled: planned.filled ?? [], skipped: planned.skipped ?? [] };

  // 状态本来就对（幂等）或者没有可补的格时 planned.text 与 before 相同：不写盘。
  const next = planned.text ?? before;
  if (next === before) return { ok: true, file, key, wrote: false, changed: false, filled: planned.filled ?? [], status: planned.status ?? '' };

  const done = writeTextBacked(file, next);
  if (done.ok !== true) return { ok: false, reason: done.reason, file, key, rolledBack: done.rolledBack };

  const after = readText(file) ?? '';
  const found = findByKey(target, after, key);
  if (!found) return { ok: false, reason: 'read-back-missing', file, key };
  return {
    ok: true,
    file,
    key,
    wrote: true,
    changed: planned.changed !== false,
    filled: planned.filled ?? [],
    status: planned.status ?? '',
    backup: done.backup,
  };
}

/**
 * 读一本账。**读不建文件**：没写过就是空，一个目录都不该因此多出来。
 * 返回 `{ok, file, text, rows}`；库没设好时 `ok:false`，别的读法（比如 preview）自己兜。
 */
export function rowsInBook({ vaultPath = '', book: name = '' } = {}) {
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem, rows: [], text: '' };
  const target = bookOf(name);
  if (!target) return { ok: false, reason: 'unknown-book', rows: [], text: '' };
  const file = bookPath(vaultPath, target.file);
  const text = readText(file) ?? '';
  return { ok: true, file, text, rows: rowsOf(target, text), exists: existsSync(file) };
}

/** 五本账各有多少行。给 `/status` 与 `info()` 用的一格读数。 */
export function ledgerCounts(vaultPath) {
  const problem = vaultProblem(vaultPath);
  if (problem) return { ok: false, reason: problem, books: {}, rows: 0 };
  const books = {};
  let total = 0;
  for (const book of BOOKS) {
    const read = rowsInBook({ vaultPath, book: book.name });
    books[book.name] = read.rows.length;
    total += read.rows.length;
  }
  return { ok: true, books, rows: total, root: ledgerRoot(vaultPath) };
}

/**
 * 读 audit.jsonl 的全部记录（只读）。
 *
 * 坏行（写一半、手改坏）单独计数，不因为一行坏掉就整份不认——
 * 人格内核那边也在写同一份文件，插件绝不能因为它而写或改。
 *
 * 同时读 `audit.jsonl.1`：内核的审计会轮转（超过 4 MB 就把旧内容挪进 `.1`）。
 * 只看当前文件的话，轮转那一刻「已经写了、还没被扫到」的 lapsed 事件就跟着旧档
 * 一起离开了视野，游标又比当前文件的新序号小，永远不会触发从 0 重扫 ——
 * 那几条会静默丢掉。两份拼起来读，轮转就只是挪了个文件。
 */
export function readAuditRecords(file) {
  const current = readText(file);
  const older = readText(`${file}.1`);
  if (current === null && older === null) return { ok: true, records: [], broken: 0, missing: true };
  const records = [];
  let broken = 0;
  // 旧档在前、当前在后：顺序和写入顺序一致，读的人一眼能对上。
  for (const text of [older, current]) {
    if (text === null) continue;
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        broken += 1;
      }
    }
  }
  return { ok: true, records, broken, missing: false };
}

export function defaultLedgerState() {
  return { version: 1, lapseSeq: 0, lastScanDay: '', updatedAt: '' };
}

/** 读游标。文件不在 / 读不动都回默认值——游标坏掉最多重扫一遍，账上有键去重，不会重复写。 */
export function readLedgerState(file) {
  const text = readText(file);
  if (text === null) return defaultLedgerState();
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return defaultLedgerState();
  }
  if (!raw || typeof raw !== 'object') return defaultLedgerState();
  const seq = Number(raw.lapseSeq);
  return {
    version: 1,
    lapseSeq: Number.isFinite(seq) && seq >= 0 ? Math.trunc(seq) : 0,
    lastScanDay: typeof raw.lastScanDay === 'string' ? raw.lastScanDay : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

export function writeLedgerState(file, state) {
  const body = JSON.stringify(
    {
      version: 1,
      lapseSeq: Number(state?.lapseSeq) || 0,
      lastScanDay: typeof state?.lastScanDay === 'string' ? state.lastScanDay : '',
      updatedAt: typeof state?.updatedAt === 'string' ? state.updatedAt : '',
    },
    null,
    2,
  );
  return writeTextBacked(file, `${body}\n`);
}
