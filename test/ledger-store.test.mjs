/**
 * 台账落盘层与 audit 扫描：只读不建、幂等不重写、游标与轮转、坏行不拖垮。
 * 口径出处：`融合计划-v2.md` §7 第 3/5 条、§13（库路径由调用方给，不探测不预填）、§3.2。
 *
 * 一律用 mkdtempSync 的临时目录：真库 `D:\AI 空间\记忆空间` 一个字节都不许动。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { BOOKS, appendRow, keyOfRow, rowsOf } from '../lib/ledger/books.js';
import { eventCells } from '../lib/ledger/event.js';
import { handoffCells, handoffKey, lapsedItems, scanLapsed } from '../lib/ledger/lapse.js';
import {
  appendToBook,
  bookPath,
  defaultLedgerState,
  ensureBook,
  ledgerCounts,
  ledgerRoot,
  ledgerStatePath,
  patchBook,
  readAuditRecords,
  readLedgerState,
  rowsInBook,
  vaultProblem,
  writeLedgerState,
} from '../lib/ledger/store.js';

function makeVault() {
  return mkdtempSync(join(tmpdir(), 'whale-ledger-'));
}

function lapsedRecord(seq, text, at = '2026-11-04T04:40:59.078Z') {
  return {
    seq,
    at,
    type: 'update',
    detail: {
      turn: seq,
      changes: [
        { kind: 'memory:facts', op: 'added', to: '不相干的变更' },
        { kind: 'commitment', op: 'lapsed', to: text },
        { kind: 'mood:pleasure', from: 0.05, to: 0.04 },
      ],
    },
  };
}

describe('台账 · 只许这一层碰盘', () => {
  it('lib/ledger 与 lib/rhythm 里只有两个 store.js import node:fs', () => {
    const root = process.cwd();
    const offenders = [];
    for (const dir of ['lib/ledger', 'lib/rhythm']) {
      for (const name of readdirSync(join(root, dir))) {
        if (name.endsWith('.js') === false) continue;
        if (name === 'store.js') continue;
        const body = readFileSync(join(root, dir, name), 'utf8');
        if (/from 'node:fs'/u.test(body)) offenders.push(`${dir}/${name}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('纯模块不看时钟、不读环境变量', () => {
    const root = process.cwd();
    const offenders = [];
    for (const file of [
      'lib/ledger/table.js',
      'lib/ledger/books.js',
      'lib/ledger/event.js',
      'lib/ledger/lapse.js',
      'lib/rhythm/period.js',
      'lib/rhythm/plan.js',
    ]) {
      const body = readFileSync(join(root, file), 'utf8');
      if (/Date\.now\(|process\.env/u.test(body)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  it('代码里不出现真库路径，也不出现原包那套词（§12）', () => {
    const root = process.cwd();
    const banned = ['记忆空间', '萃', '软晚安', '母体', '自举'];
    const offenders = [];
    for (const dir of ['lib/ledger', 'lib/rhythm']) {
      for (const name of readdirSync(join(root, dir))) {
        if (name.endsWith('.js') === false) continue;
        const body = readFileSync(join(root, dir, name), 'utf8');
        for (const word of banned) if (body.includes(word)) offenders.push(`${dir}/${name}:${word}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('台账 · 库路径的规矩（§13）', () => {
  it('空路径与库不存在分开报，而且都不建目录', () => {
    assert.equal(vaultProblem(''), 'vault-required');
    assert.equal(vaultProblem('   '), 'vault-required');
    const base = makeVault();
    const missing = join(base, '并没有这个库');
    assert.equal(vaultProblem(missing), 'vault-missing');
    const done = appendToBook({ vaultPath: missing, book: '事件', cells: eventCells({ at: '2026-11-05', type: '任务', what: 'x' }) });
    assert.equal(done.ok, false);
    assert.equal(done.reason, 'vault-missing');
    assert.equal(existsSync(missing), false, '不许替人把库建出来');
    assert.equal(appendToBook({ vaultPath: '', book: '事件', cells: [] }).reason, 'vault-required');
    rmSync(base, { recursive: true, force: true });
  });

  it('读一本不存在的账：空行、不建文件', () => {
    const vault = makeVault();
    const read = rowsInBook({ vaultPath: vault, book: '事件' });
    assert.equal(read.ok, true);
    assert.deepEqual(read.rows, []);
    assert.equal(existsSync(bookPath(vault, '事件.md')), false);
    assert.equal(existsSync(ledgerRoot(vault)), false);
    rmSync(vault, { recursive: true, force: true });
  });

  it('认不出来的账名字一律拒', () => {
    const vault = makeVault();
    assert.equal(ensureBook(vault, '第九本').reason, 'unknown-book');
    assert.equal(rowsInBook({ vaultPath: vault, book: '第九本' }).reason, 'unknown-book');
    rmSync(vault, { recursive: true, force: true });
  });
});

describe('台账 · 重跑不重复写', () => {
  it('同一行写两次：文件字节不变，也不多一个 .bak', () => {
    const vault = makeVault();
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: '归档三份笔记' });
    const first = appendToBook({ vaultPath: vault, book: '事件', cells });
    assert.equal(first.wrote, true);
    const file = bookPath(vault, '事件.md');
    const before = readFileSync(file, 'utf8');
    const backupsBefore = readdirSync(ledgerRoot(vault)).filter((name) => name.includes('.bak-')).length;

    const again = appendToBook({ vaultPath: vault, book: '事件', cells });
    assert.equal(again.ok, true);
    assert.equal(again.wrote, false);
    assert.equal(again.skipped, true);
    assert.equal(readFileSync(file, 'utf8'), before, '跳过的追加一个字节都不该写');
    const backupsAfter = readdirSync(ledgerRoot(vault)).filter((name) => name.includes('.bak-')).length;
    assert.equal(backupsAfter, backupsBefore, '空转不该产生备份');
    rmSync(vault, { recursive: true, force: true });
  });

  it('重跑一次整批：第二次全都跳过，盘上还是一条', () => {
    const vault = makeVault();
    const batch = [
      eventCells({ at: '2026-11-05T03:20', type: '任务', what: 'A' }),
      eventCells({ at: '2026-11-05T03:21', type: '纠正', what: 'B' }),
    ];
    for (const cells of batch) assert.equal(appendToBook({ vaultPath: vault, book: '事件', cells }).wrote, true);
    for (const cells of batch) assert.equal(appendToBook({ vaultPath: vault, book: '事件', cells }).wrote, false);
    assert.equal(rowsInBook({ vaultPath: vault, book: '事件' }).rows.length, 2);
    rmSync(vault, { recursive: true, force: true });
  });

  it('补齐写回同一行，只换「待补」那一格', () => {
    const vault = makeVault();
    const cells = eventCells({ at: '2026-11-05T03:20', type: '任务', what: 'C' });
    appendToBook({ vaultPath: vault, book: '事件', cells });
    const key = keyOfRow('事件', cells);
    const done = patchBook({ vaultPath: vault, book: '事件', key, patch: { 教训: '先问一句' } });
    assert.equal(done.ok, true);
    assert.deepEqual(done.filled, ['教训']);
    const row = rowsInBook({ vaultPath: vault, book: '事件' }).rows[0].cells;
    assert.equal(row[5], '先问一句');
    assert.equal(row[3], '待补');
    // 再补同一格：拒，而且不写盘。
    const again = patchBook({ vaultPath: vault, book: '事件', key, patch: { 教训: '再改' } });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'no-placeholder');
    rmSync(vault, { recursive: true, force: true });
  });

  it('五本账的读数与文件都在台账/下面', () => {
    const vault = makeVault();
    appendToBook({ vaultPath: vault, book: '偏离', cells: { 场景: '归档', 偏离: '按标签猜', 原因: '', 改法: '' } });
    appendToBook({ vaultPath: vault, book: '异议', cells: { 时间: '2026-11-05', 议题: 'x', 我的看法: 'a', 你的看法: 'b' } });
    const counts = ledgerCounts(vault);
    assert.equal(counts.ok, true);
    assert.deepEqual(counts.books, { 事件: 0, 偏离: 1, 异议: 1, 待交接: 0, 待提醒: 0 });
    assert.equal(counts.root, ledgerRoot(vault));
    assert.deepEqual(
      readdirSync(ledgerRoot(vault)).filter((name) => name.endsWith('.md')).sort(),
      ['偏离.md', '异议.md'],
    );
    assert.equal(BOOKS.length, 5);
    rmSync(vault, { recursive: true, force: true });
  });
});

describe('台账 · audit 扫描与游标', () => {
  it('读 audit：坏行单独计数，不当整份坏掉', () => {
    const dir = makeVault();
    const file = join(dir, 'audit.jsonl');
    writeFileSync(file, `${JSON.stringify(lapsedRecord(3, 'A'))}\n这不是 JSON\n\n${JSON.stringify(lapsedRecord(4, 'B'))}\n`, 'utf8');
    const read = readAuditRecords(file);
    assert.equal(read.ok, true);
    assert.equal(read.records.length, 2);
    assert.equal(read.broken, 1);
    const scan = scanLapsed({ records: read.records, afterSeq: 0 });
    assert.deepEqual(
      scan.items.map((item) => item.text),
      ['A', 'B'],
    );
    assert.equal(scan.maxSeq, 4);
    // 只认新增：游标推到 3 就只剩 4 那条。
    assert.deepEqual(
      scanLapsed({ records: read.records, afterSeq: 3 }).items.map((item) => item.key),
      [handoffKey({ seq: 4, i: 1 })],
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('审计轮转后旧档一起读：lapsed 不会跟着 .1 一起消失', () => {
    const dir = makeVault();
    const file = join(dir, 'audit.jsonl');
    // 轮转之后的盘面：旧内容在 .1，当前文件从新序号开始。
    writeFileSync(
      `${file}.1`,
      `${JSON.stringify(lapsedRecord(7, '轮转前A'))}\n${JSON.stringify(lapsedRecord(8, '轮转前B'))}\n`,
      'utf8',
    );
    writeFileSync(file, `${JSON.stringify(lapsedRecord(9, '轮转后'))}\n`, 'utf8');

    const read = readAuditRecords(file);
    assert.equal(read.missing, false);
    assert.equal(read.broken, 0);
    assert.deepEqual(read.records.map((record) => record.seq), [7, 8, 9]);
    // 游标停在 7：8、9 是新增，7 已经处理过，不该重复接。
    assert.deepEqual(
      scanLapsed({ records: read.records, afterSeq: 7 }).items.map((item) => item.text),
      ['轮转前B', '轮转后'],
    );

    // 只有旧档也算读到了：不能因为主文件还没建就当成「没有 audit」。
    rmSync(file);
    const onlyOld = readAuditRecords(file);
    assert.equal(onlyOld.missing, false);
    assert.deepEqual(onlyOld.records.map((record) => record.seq), [7, 8]);

    rmSync(dir, { recursive: true, force: true });
  });

  it('首次扫描有地板：游标 0 时只接最近 firstFloor 条，历史 lapsed 不灌进来', () => {
    // 真机事故复现：几十条历史 lapsed，游标 0，以前会把它们全灌进待交接。
    const records = [lapsedRecord(10, '很旧的'), lapsedRecord(200, '中期的'), lapsedRecord(322, '最近的')];
    const noFloor = scanLapsed({ records, afterSeq: 0 });
    assert.equal(noFloor.items.length, 3);
    assert.equal(noFloor.floored, false);

    // 地板 200 → 下界 122，只接 200 与 322。
    const floored = scanLapsed({ records, afterSeq: 0, firstFloor: 200 });
    assert.equal(floored.floored, true);
    assert.equal(floored.from, 122);
    assert.deepEqual(
      floored.items.map((item) => item.text),
      ['中期的', '最近的'],
    );
    assert.equal(floored.maxSeq, 322);

    // 历史比地板短时不抬：没有「历史」可挡。
    const short = scanLapsed({ records, afterSeq: 0, firstFloor: 9999 });
    assert.equal(short.floored, false);
    assert.equal(short.items.length, 3);

    // 有游标时地板不生效：正常增量不受影响。
    const incremental = scanLapsed({ records, afterSeq: 200, firstFloor: 200 });
    assert.equal(incremental.floored, false);
    assert.deepEqual(
      incremental.items.map((item) => item.text),
      ['最近的'],
    );
  });

  it('audit 不存在不算错', () => {
    const read = readAuditRecords(join(tmpdir(), 'whale-ledger-没有这个文件.jsonl'));
    assert.equal(read.ok, true);
    assert.equal(read.missing, true);
    assert.deepEqual(read.records, []);
  });

  it('轮转后从 0 重扫（账上有键去重，重扫不会重复写）', () => {
    const scan = scanLapsed({ records: [lapsedRecord(1, 'A'), lapsedRecord(2, 'B')], afterSeq: 99 });
    assert.equal(scan.reset, true);
    assert.equal(scan.from, 0);
    assert.equal(scan.items.length, 2);
    // 没轮转就不重扫。
    assert.equal(scanLapsed({ records: [lapsedRecord(99, 'A')], afterSeq: 5 }).reset, false);
  });

  it('lapsed 只从 changes 里认，别的变更不算', () => {
    const record = lapsedRecord(7, '记着 guiji 1M 窗口未结');
    const items = lapsedItems(record);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      seq: 7,
      i: 1,
      at: '2026-11-04T04:40:59.078Z',
      text: '记着 guiji 1M 窗口未结',
      key: 'lapse:7#1',
    });
    assert.deepEqual(lapsedItems({ seq: 8, detail: { changes: [{ kind: 'commitment', op: 'done', to: 'x' }] } }), []);
    assert.deepEqual(lapsedItems({ seq: 9 }), []);
    assert.deepEqual(lapsedItems({ seq: 10, detail: { changes: [{ kind: 'commitment', op: 'lapsed', to: '  ' }] } }), [], '没正文的不接');
  });

  it('交接行：时间抄 audit 的 at、状态默认待处理', () => {
    const item = lapsedItems(lapsedRecord(12, '把文档里那条错命令改掉'))[0];
    assert.deepEqual(handoffCells({ item }), ['2026-11-04T04:40:59.078Z', 'lapse:12#1', '把文档里那条错命令改掉', '待处理']);
  });

  it('游标落了盘能读回来，坏文件回默认值', () => {
    const dir = makeVault();
    const file = ledgerStatePath(dir);
    assert.deepEqual(readLedgerState(file), defaultLedgerState());
    writeLedgerState(file, { lapseSeq: 247, lastScanDay: '2026-11-05', updatedAt: '2026-11-05T03:00:00.000Z' });
    assert.deepEqual(readLedgerState(file), { version: 1, lapseSeq: 247, lastScanDay: '2026-11-05', updatedAt: '2026-11-05T03:00:00.000Z' });
    writeFileSync(file, '不是 JSON', 'utf8');
    assert.deepEqual(readLedgerState(file), defaultLedgerState());
    rmSync(dir, { recursive: true, force: true });
  });

  it('写出去的行读回来还是那一行（写后读回同一个口径）', () => {
    const vault = makeVault();
    const cells = ['2026-11-05T03:20', '任务', '归档 | 三份', '待补', '待补', '待补'];
    const done = appendToBook({ vaultPath: vault, book: '事件', cells });
    assert.equal(done.ok, true);
    const read = rowsInBook({ vaultPath: vault, book: '事件' });
    assert.deepEqual(read.rows[0].cells, cells);
    assert.match(readFileSync(bookPath(vault, '事件.md'), 'utf8'), /归档 \\\| 三份/u);
    rmSync(vault, { recursive: true, force: true });
  });
});
