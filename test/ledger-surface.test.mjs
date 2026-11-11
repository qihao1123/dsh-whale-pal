/**
 * 台账接线面：audit 扫描写交接条、游标只在整批成功后推进、标结、补齐、读数、挂不上不阻断。
 * 口径出处：`融合计划-v2.md` §3.2（lapse 变成交接条，人确认后才结）、§19.2（挂不上不阻断启动）、§13。
 *
 * 一律 mkdtemp：真库 `D:\AI 空间\记忆空间` 一个字节都不许动。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  appendEvent,
  dataDirOf,
  handoffList,
  ledgerInfo,
  pendingFillList,
  previewReminders,
  registerLedger,
  scanLapseOnce,
  settleHandoff,
  vaultOf,
  auditFileOf,
} from '../lib/ledger/host-bridge.js';
import { rowsInBook, ledgerStatePath, readLedgerState } from '../lib/ledger/store.js';

function makeVault() {
  return mkdtempSync(join(tmpdir(), 'whale-ledger-surface-'));
}

function makeApi({ vault = '', dataDir = '' }) {
  const config = vault === '' ? {} : { knowledge: { vaultPath: vault } };
  return {
    paths: { root: dataDir, audit: join(dataDir, 'audit.jsonl') },
    getConfig: () => config,
  };
}

function makeCtx() {
  const handlers = new Map();
  const offs = [];
  return {
    handlers,
    offs,
    on(name, fn) {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    },
    effect(fn) {
      const cleanup = fn();
      const record = { called: false, cleanup };
      offs.push(record);
      return () => {
        if (record.called) return;
        record.called = true;
        if (typeof record.cleanup === 'function') record.cleanup();
      };
    },
    fire(name, arg) {
      const fn = handlers.get(name);
      return typeof fn === 'function' ? fn(arg) : undefined;
    },
  };
}

function lapsedLine(seq, text, at = '2026-11-04T04:40:59.078Z') {
  return `${JSON.stringify({ seq, at, type: 'update', detail: { turn: seq, changes: [{ kind: 'commitment', op: 'lapsed', to: text }] } })}\n`;
}

describe('台账接线 · lapse 交接', () => {
  it('扫出来的 lapsed 写进待交接；重扫跳过；游标推进到最大序号', () => {
    const vault = makeVault();
    const dir = makeVault();
    const api = makeApi({ vault, dataDir: dir });
    writeFileSync(auditFileOf(api), lapsedLine(3, '记着 guiji 1M 窗口未结') + lapsedLine(4, '把文档里那条错命令改掉'), 'utf8');

    const first = scanLapseOnce({ api, at: '2026-11-05T09:00:00+08:00' });
    assert.equal(first.ok, true);
    assert.equal(first.written.length, 2);
    assert.equal(first.skipped.length, 0);
    assert.deepEqual(first.failed, []);
    assert.equal(readLedgerState(ledgerStatePath(dir)).lapseSeq, 4);

    const again = scanLapseOnce({ api, at: '2026-11-05T09:05:00+08:00' });
    assert.equal(again.written.length, 0);
    assert.equal(again.seen, 0, '游标之后没有新记录，就没有可写的');

    // 文件被轮转/清空之后从 0 重扫：键去重兜住，一条都不重复写。
    writeFileSync(auditFileOf(api), lapsedLine(3, '记着 guiji 1M 窗口未结'), 'utf8');
    const rotated = scanLapseOnce({ api, at: '2026-11-05T09:10:00+08:00' });
    assert.equal(rotated.reset, true);
    assert.equal(rotated.written.length, 0);
    assert.equal(rotated.skipped.length, 1, '重扫只跳过已经记过的那一条');

    const rows = rowsInBook({ vaultPath: vault, book: '待交接' }).rows;
    assert.equal(rows.length, 2, '重扫不会多出一行');
    assert.deepEqual(rows.map((row) => row.cells[3]), ['待处理', '待处理']);
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('写不动的整批：游标原地不动，下一轮还能再扫（不是静默丢掉）', () => {
    const vault = makeVault();
    const dir = makeVault();
    // 把「台账」占成一份普通文件：mkdirSync 必然失败，appendToBook 整批写不动。
    writeFileSync(join(vault, '台账'), '占位', 'utf8');
    const api = makeApi({ vault, dataDir: dir });
    writeFileSync(auditFileOf(api), lapsedLine(3, '一条还没交出去的'), 'utf8');

    const done = scanLapseOnce({ api });
    assert.equal(done.ok, true);
    assert.equal(done.written.length, 0);
    assert.equal(done.failed.length, 1);
    assert.equal(done.failed[0].reason, 'mkdir-failed');
    assert.equal(readLedgerState(ledgerStatePath(dir)).lapseSeq, 0, '没写成就别推进游标');
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('人确认后标结；手动忽略也认；已接近的行不再被改', () => {
    const vault = makeVault();
    const dir = makeVault();
    const api = makeApi({ vault, dataDir: dir });
    writeFileSync(auditFileOf(api), lapsedLine(7, '答应过的一件事'), 'utf8');
    scanLapseOnce({ api });

    const open = handoffList({ api });
    assert.equal(open.rows.length, 1);
    assert.equal(open.rows[0].key, 'lapse:7#0');
    assert.match(open.rows[0].what, /答应过的一件事/u);

    assert.equal(settleHandoff({ api, key: 'lapse:7#0', action: 'settle' }).ok, true);
    assert.equal(handoffList({ api }).rows.length, 0, '结掉的就不再列在待办里');
    assert.equal(handoffList({ api, status: '已结' }).rows.length, 1);
    assert.equal(settleHandoff({ api, key: 'lapse:7#0', action: 'ignore' }).reason, 'not-open');
    assert.equal(settleHandoff({ api, key: '没有这条', action: 'settle' }).reason, 'row-not-found');
    assert.equal(settleHandoff({ api, key: 'lapse:7#0', action: '删掉' }).reason, 'bad-action');
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('没设库的时候：扫描回 vault-required，读数回 ready:false，都不抛', () => {
    const api = makeApi({ vault: '', dataDir: makeVault() });
    assert.equal(vaultOf(api), '');
    assert.equal(vaultOf({ getConfig: () => ({ knowledge: {} }) }), '');
    assert.equal(scanLapseOnce({ api }).reason, 'vault-required');
    const info = ledgerInfo({ api });
    assert.equal(info.ok, true);
    assert.equal(info.ready, false);
    assert.equal(info.reason, 'vault-required');
    assert.equal(previewReminders({ api }).reason, 'vault-required');
  });

  it('dataDir 取 api.paths.root，也能被显式传进来的兜住', () => {
    assert.equal(dataDirOf({ paths: { root: ' D:\\x ' } }), 'D:\\x');
    assert.equal(dataDirOf({}, ' E:\\y '), 'E:\\y');
    assert.equal(dataDirOf({}), '');
  });
});

describe('台账接线 · 事件与补齐', () => {
  it('事件当场写、隔天列出来补、补齐只换那一格', () => {
    const vault = makeVault();
    const api = makeApi({ vault, dataDir: makeVault() });
    const at = '2026-11-05T03:20';
    const done = appendEvent({ api, at, type: '任务', what: '把 3 份笔记按域归档', judgment: '按标签猜权重' });
    assert.equal(done.ok, true);

    const today = pendingFillList({ api, ms: Date.parse('2026-11-05T09:00:00+08:00'), offsetMinutes: 480 });
    assert.deepEqual(today.rows, [], '当天不催');
    const tomorrow = pendingFillList({ api, ms: Date.parse('2026-11-06T09:00:00+08:00'), offsetMinutes: 480 });
    assert.equal(tomorrow.rows.length, 1);
    assert.deepEqual(tomorrow.rows[0].missing, ['结果', '教训']);

    const filled = registerLedger({ ctx: {}, api, everyMs: 0 }).fillEvent({ key: tomorrow.rows[0].key, patch: { 教训: '归属不明时先问一句' } });
    assert.equal(filled.ok, true);
    assert.deepEqual(filled.filled, ['教训']);
    const row = rowsInBook({ vaultPath: vault, book: '事件' }).rows[0].cells;
    assert.deepEqual(row, [at, '任务', '把 3 份笔记按域归档', '按标签猜权重', '待补', '归属不明时先问一句']);
    rmSync(vault, { recursive: true, force: true });
  });

  it('事件类型收口在四样上，第五种写不进去', () => {
    const api = makeApi({ vault: makeVault(), dataDir: makeVault() });
    const done = appendEvent({ api, at: '2026-11-05T03:20', type: '感想', what: '随便记一笔' });
    assert.equal(done.ok, false);
    assert.equal(done.reason, 'bad-type');
    assert.equal(appendEvent({ api, at: '2026-11-05T03:20', type: '任务', what: '' }).reason, 'missing:发生了什么');
  });
});

describe('台账接线 · 挂载与读数', () => {
  it('读数：五本账行数、待交接条数、待补行数、节律报到哪了', () => {
    const vault = makeVault();
    const dir = makeVault();
    const api = makeApi({ vault, dataDir: dir });
    writeFileSync(auditFileOf(api), lapsedLine(9, '一件没结的'), 'utf8');
    scanLapseOnce({ api });
    appendEvent({ api, at: '2026-11-01T03:20', type: '观察', what: '隔了几天还没定' });

    const info = ledgerInfo({ api, ms: Date.parse('2026-11-05T09:00:00+08:00'), offsetMinutes: 480 });
    assert.equal(info.ready, true);
    assert.equal(info.books['待交接'], 1);
    assert.equal(info.books['事件'], 1);
    assert.equal(info.handoffs, 1);
    assert.equal(info.fills, 1);
    assert.deepEqual(info.keys, { day: '2026-11-05', week: '2026-W45', month: '2026-11' });
    assert.deepEqual(info.due, ['day', 'week', 'month']);
    assert.equal(info.root, join(vault, '台账'));
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('不给时区就按本机算：null / 空串 / 不传 都得等于显式给本机偏移', () => {
    // 真机上没人会传 offsetMinutes（registerLedger 那条线就不传），
    // 所以这条默认路径必须落在本机时区上，不能悄悄当 UTC。
    const vault = makeVault();
    const api = makeApi({ vault, dataDir: makeVault() });
    const ms = Date.parse('2026-11-05T00:30:00+08:00');
    const mine = -new Date().getTimezoneOffset();
    const base = ledgerInfo({ api, ms, offsetMinutes: mine });
    assert.deepEqual(ledgerInfo({ api, ms }), base, '不传要等于给本机偏移');
    assert.deepEqual(ledgerInfo({ api, ms, offsetMinutes: null }), base, 'null 要等于给本机偏移');
    assert.deepEqual(ledgerInfo({ api, ms, offsetMinutes: '' }), base, '空串要等于给本机偏移');
    rmSync(vault, { recursive: true, force: true });
  });

  it('挂不上定时器与会话钩子：只记 warnings，返回的写入口照样能用', () => {
    const vault = makeVault();
    const api = makeApi({ vault, dataDir: makeVault() });
    const notes = [];
    const ledger = registerLedger({ ctx: {}, api, everyMs: 1000, log: (line) => notes.push(line) });
    assert.equal(ledger.warnings.length >= 2, true);
    assert.equal(
      ledger.warnings.some((line) => line.includes('定时器')),
      true,
    );
    assert.equal(
      ledger.warnings.some((line) => line.includes('提醒')),
      true,
    );
    assert.equal(notes.length >= 1, true, '挂不上要留痕');

    const done = ledger.appendEvent({ at: '2026-11-05T03:20', type: '任务', what: '照样能写' });
    assert.equal(done.ok, true);
    assert.equal(existsSync(join(vault, '台账', '事件.md')), true);
    assert.equal(ledger.dispose(), undefined);
    rmSync(vault, { recursive: true, force: true });
  });

  it('挂上之后 dispose 能把定时器与会话钩子都卸掉', () => {
    const vault = makeVault();
    const api = makeApi({ vault, dataDir: makeVault() });
    const ctx = makeCtx();
    const ledger = registerLedger({ ctx, api, everyMs: 60_000 });
    assert.equal(ledger.warnings.length, 0);
    assert.equal(ctx.offs.length, 1, '定时器挂上了');
    assert.equal(ctx.handlers.has('agent/created'), true);
    ledger.dispose();
    assert.equal(ctx.offs.every((record) => record.called), true, '定时器清掉了');
    assert.equal(ctx.handlers.size, 0, '会话钩子摘掉了');
    ledger.dispose();
    rmSync(vault, { recursive: true, force: true });
  });

  it('启动就扫一遍（force），第二次启动不会重复写', () => {
    const vault = makeVault();
    const dir = makeVault();
    const api = makeApi({ vault, dataDir: dir });
    writeFileSync(auditFileOf(api), lapsedLine(2, '启动时该接上的那条'), 'utf8');
    const first = registerLedger({ ctx: makeCtx(), api, everyMs: 0 });
    assert.equal(rowsInBook({ vaultPath: vault, book: '待交接' }).rows.length, 1);
    first.dispose();
    const second = registerLedger({ ctx: makeCtx(), api, everyMs: 0 });
    assert.equal(rowsInBook({ vaultPath: vault, book: '待交接' }).rows.length, 1, '重跑不重复写');
    second.dispose();
    assert.match(readFileSync(join(vault, '台账', '待交接.md'), 'utf8'), /lapse:2#0/u);
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
