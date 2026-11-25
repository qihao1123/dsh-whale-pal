/**
 * 台账接线面：按需扫 audit 写交接条、重扫不重复写、标结、补齐、读数、没库不抛。
 * 口径出处：`融合计划-v2.md` §3.2（lapse 变成交接条，人确认后才结）、§19.2（挂不上不阻断启动）、§13。
 *
 * 2026-11-21：节律那半边砍了（定时器、待提醒账、两份状态文件），这里只测留下的按需扫描。
 * 一律 mkdtemp：真库 `D:\AI 空间\记忆空间` 一个字节都不许动。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  appendEvent,
  auditFileOf,
  createLedger,
  handoffList,
  ledgerInfo,
  pendingFillList,
  scanLapseOnce,
  settleHandoff,
  vaultOf,
} from '../lib/ledger/host-bridge.js';
import { rowsInBook } from '../lib/ledger/store.js';

function makeVault() {
  return mkdtempSync(join(tmpdir(), 'whale-ledger-surface-'));
}

function makeApi({ vault = '', dataDir = '', state = null } = {}) {
  const config = vault === '' ? {} : { knowledge: { vaultPath: vault } };
  return {
    paths: { root: dataDir, audit: join(dataDir, 'audit.jsonl') },
    getConfig: () => config,
    getState: () => state,
  };
}

function lapsedLine(seq, text, at = '2026-11-04T04:40:59.078Z') {
  return `${JSON.stringify({ seq, at, type: 'update', detail: { turn: seq, changes: [{ kind: 'commitment', op: 'lapsed', to: text }] } })}\n`;
}

describe('台账接线 · 按需扫过期承诺', () => {
  it('扫一遍写进待交接；再扫一遍只跳过，不重复写', () => {
    const vault = makeVault();
    const dir = makeVault();
    const api = makeApi({ vault, dataDir: dir });
    writeFileSync(auditFileOf(api), lapsedLine(3, '记着 guiji 1M 窗口未结') + lapsedLine(4, '把文档里那条错命令改掉'), 'utf8');

    const first = scanLapseOnce({ api, at: '2026-11-05T09:00:00+08:00' });
    assert.equal(first.ok, true);
    assert.equal(first.written.length, 2);
    assert.equal(first.skipped.length, 0);
    assert.deepEqual(first.failed, []);
    assert.deepEqual(
      first.added.map((one) => one.what),
      ['记着 guiji 1M 窗口未结', '把文档里那条错命令改掉'],
    );

    const again = scanLapseOnce({ api, at: '2026-11-05T09:05:00+08:00' });
    assert.equal(again.written.length, 0);
    assert.equal(again.skipped.length, 2);
    assert.deepEqual(again.added, []);
    assert.equal(again.seen, 2, '没有游标：每次都从 0 扫，靠账上的键去重');

    const rows = rowsInBook({ vaultPath: vault, book: '待交接' }).rows;
    assert.equal(rows.length, 2, '重扫不会多出一行');
    assert.deepEqual(rows.map((row) => row.cells[3]), ['待处理', '待处理']);
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('写不动的整批：每条失败都报出来，不假装写成了', () => {
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
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('人确认后标结；手动忽略也认；已结的行不再被改', () => {
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

  it('清单只列最近的几条，同时把总数报出来', () => {
    const vault = makeVault();
    const dir = makeVault();
    const api = makeApi({ vault, dataDir: dir });
    writeFileSync(auditFileOf(api), lapsedLine(1, '第一件') + lapsedLine(2, '第二件') + lapsedLine(3, '第三件'), 'utf8');
    scanLapseOnce({ api });

    const seen = handoffList({ api, limit: 2 });
    assert.equal(seen.rows.length, 2);
    assert.equal(seen.matched, 3);
    assert.equal(seen.limited, true);
    assert.deepEqual(
      seen.rows.map((row) => row.key),
      ['lapse:2#0', 'lapse:3#0'],
      '列最近的，不列最早的',
    );
    assert.equal(handoffList({ api }).rows.length, 3, '不传 limit 就全给');
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('未结的三类也进待交接，键里带类别', () => {
    const vault = makeVault();
    const api = makeApi({
      vault,
      dataDir: makeVault(),
      state: {
        memory: {
          openTopics: [
            { text: '那个问题我提了他还没回', at: Date.parse('2026-11-04T03:00:00Z') },
            { text: '已结的', at: Date.parse('2026-11-04T03:00:00Z'), resolved: true },
          ],
        },
      },
    });

    const done = scanLapseOnce({ api });
    assert.equal(done.openAdded.length, 1, '结掉的没资格进来');
    assert.match(done.openAdded[0].what, /［我提了他没回］/u);
    assert.equal(rowsInBook({ vaultPath: vault, book: '待交接' }).rows.length, 1);
    rmSync(vault, { recursive: true, force: true });
  });

  it('没设库的时候：扫描回 vault-required，读数回 ready:false，都不抛', () => {
    const api = makeApi({ vault: '', dataDir: makeVault() });
    assert.equal(vaultOf(api), '');
    assert.equal(vaultOf({ getConfig: () => ({ knowledge: {} }) }), '');
    assert.equal(scanLapseOnce({ api }).reason, 'vault-required');
    assert.equal(handoffList({ api }).ok, false);
    const info = ledgerInfo({ api });
    assert.equal(info.ok, true);
    assert.equal(info.ready, false);
    assert.equal(info.reason, 'vault-required');
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

    const filled = createLedger({ api }).fillEvent({ key: tomorrow.rows[0].key, patch: { 教训: '归属不明时先问一句' } });
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

describe('台账接线 · 读数与写入口', () => {
  it('读数：四本账行数、待交接条数、待补行数', () => {
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
    assert.equal(info.root, join(vault, '台账'));
    assert.equal(info.rhythm, undefined, '节律那几格不再有');
    rmSync(vault, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('不给时区就按本机算：null / 空串 / 不传 都得等于显式给本机偏移', () => {
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

  it('createLedger 不挂任何东西：没有 dispose、不碰 ctx，写入口照样能用', () => {
    const vault = makeVault();
    const api = makeApi({ vault, dataDir: makeVault() });
    const ledger = createLedger({ api });
    assert.equal(typeof ledger.dispose, 'undefined', '定时器与会话钩子都砍了，没有要卸的东西');
    assert.deepEqual(Object.keys(ledger).sort(), [
      'appendDeviation',
      'appendDissent',
      'appendEvent',
      'fillEvent',
      'handoffs',
      'info',
      'pendingFills',
      'scan',
      'settleHandoff',
    ]);
    const done = ledger.appendEvent({ at: '2026-11-05T03:20', type: '任务', what: '照样能写' });
    assert.equal(done.ok, true);
    assert.equal(existsSync(join(vault, '台账', '事件.md')), true);
    rmSync(vault, { recursive: true, force: true });
  });
});
