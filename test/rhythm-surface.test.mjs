/**
 * 节律接线面（两条验收判据的落点）：**提醒只出现一次**；**台账重跑不重复写**。
 *
 * 口径出处：`融合计划-v2.md` §5 的 P4 行（验收判据）、D5（插件内定时为主、计划任务兜底；
 * 没在跑就落一行，下次启动补报一次、不补第二次）、§3.2（lapse 每天扫新增事件）。
 *
 * 时间全部用假时钟喂进来（`clock` + `offsetMinutes`），所以断言不随时区变。
 * 一律 mkdtemp：真库 `D:\AI 空间\记忆空间` 一个字节都不许动。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fallbackReminder, registerLedger } from '../lib/ledger/host-bridge.js';
import { rowsInBook, ledgerStatePath, readLedgerState } from '../lib/ledger/store.js';
import { rhythmStatePath, readRhythmState } from '../lib/rhythm/store.js';

const SHANGHAI = 480;
const at = (iso) => Date.parse(iso);
const DAY1 = '2026-11-05T09:00:00+08:00';
const DAY2 = '2026-11-06T09:00:00+08:00';

function makeVault() {
  return mkdtempSync(join(tmpdir(), 'whale-rhythm-'));
}

function makeApi({ vault = '', dataDir = '' }) {
  const config = vault === '' ? {} : { knowledge: { vaultPath: vault } };
  return { paths: { root: dataDir, audit: join(dataDir, 'audit.jsonl') }, getConfig: () => config };
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
    fire(name, ...args) {
      const fn = handlers.get(name);
      return typeof fn === 'function' ? fn(...args) : undefined;
    },
  };
}

function makeAgent(session = { id: 'session-rhythm', eventAt: () => null }) {
  const injected = [];
  const turns = [];
  return {
    session,
    injected,
    inject(message) {
      injected.push(message);
    },
    ctx: {
      on(name, fn) {
        turns.push(fn);
        return () => {};
      },
    },
    turnEnd() {
      for (const fn of turns) fn();
    },
    text() {
      return injected.map((message) => message.content.map((block) => block.text).join('')).join('\n');
    },
  };
}

/** 建一次「宿主跑起来了」：注册 → agent/created → 一轮收尾。 */
function boot({ api, now }) {
  const ctx = makeCtx();
  const ledger = registerLedger({ ctx, api, everyMs: 0, clock: () => now.value, offsetMinutes: SHANGHAI });
  const agent = makeAgent();
  // 两步：先 agent/created 建 session→agent 映射，再发 session/event 的 turn/end。
  // `turn/end` 不是 cordis 事件，它是 session.append 写进日志的，派发出来叫 session/event。
  ctx.fire('agent/created', { agent, source: 'startup' });
  const turnEnd = () => ctx.fire('session/event', agent.session, { type: 'turn/end', seq: 0, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
  return { ctx, ledger, agent, turnEnd };
}

function reminderBook(vault) {
  return rowsInBook({ vaultPath: vault, book: '待提醒' }).rows.map((row) => row.cells);
}

describe('节律 · 提醒只出现一次', () => {
  it('同一档报过一次就不再报：多轮、多会话、重启都不重复', () => {
    const vault = makeVault();
    const dataDir = makeVault();
    const api = makeApi({ vault, dataDir });
    const now = { value: at(DAY1) };

    const first = boot({ api, now });
    assert.equal(first.ledger.warnings.length, 0);
    first.turnEnd();
    assert.equal(first.agent.injected.length, 1, '第一次收尾说一次');
    assert.equal(first.agent.text(), '[whale-pal] 今天 2026-11-05：没有欠着的事');

    // 同一轮里再说几次、另一个会话也来说一句：都不该再多。
    first.turnEnd();
    first.turnEnd();
    const other = makeAgent({ id: 'session-rhythm-other', eventAt: () => null });
    first.ctx.fire('agent/created', { agent: other, source: 'startup' });
    first.ctx.fire('session/event', other.session, { type: 'turn/end', seq: 0, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } });
    assert.equal(first.agent.injected.length, 1);
    assert.equal(other.injected.length, 0, '另一个会话不该重复说同一件事');

    // 换一天：说新的一天，一次。
    now.value = at(DAY2);
    first.turnEnd();
    assert.equal(first.agent.injected.length, 2);
    assert.equal(first.agent.text().split('\n')[1], '[whale-pal] 今天 2026-11-06：没有欠着的事');

    // 重启（重新 register）：同一天不再报。
    first.ledger.dispose();
    const restarted = boot({ api, now });
    restarted.turnEnd();
    assert.equal(restarted.agent.injected.length, 0, '重启后同一天不再报第二次');

    // 台账记了两次（每档一次），一条都不多。
    const rows = reminderBook(vault);
    assert.deepEqual(
      rows.map((row) => [row[1], row[3]]),
      [
        ['day:2026-11-05', '已报'],
        ['day:2026-11-06', '已报'],
      ],
    );
    rmSync(vault, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('第一次装的那天只报日：周/月先记成已报，免得一开口三条一起上', () => {
    const vault = makeVault();
    const dataDir = makeVault();
    const api = makeApi({ vault, dataDir });
    const now = { value: at(DAY1) };
    const booted = boot({ api, now });
    booted.turnEnd();
    assert.equal(booted.agent.injected.length, 1);

    const state = readRhythmState(rhythmStatePath(dataDir));
    assert.deepEqual(state.fired, { day: '2026-11-05', week: '2026-W45', month: '2026-11' });
    assert.equal(state.lastReport, new Date(at(DAY1)).toISOString());
    rmSync(vault, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('没有会话可投的时候不烧键：键留在原地，等下一次有人在再说', () => {
    const vault = makeVault();
    const dataDir = makeVault();
    const api = makeApi({ vault, dataDir });
    const now = { value: at(DAY1) };
    const booted = boot({ api, now });

    assert.equal(booted.ledger.announce(null), '', '没人可投就不说');
    assert.equal(booted.ledger.announce({}), '', '塞不进去的 agent 也一样');
    assert.deepEqual(readRhythmState(rhythmStatePath(dataDir)).fired.day, '', '键没被烧掉');
    assert.equal(reminderBook(vault).length, 0, '没投出去就不该在台账上留一行');

    booted.turnEnd();
    assert.equal(booted.agent.injected.length, 1, '等真有人了还是说一次');
    assert.equal(reminderBook(vault).length, 1);
    rmSync(vault, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('节律状态落插件数据目录，不落库（库里的台账只有人的账）', () => {
    const vault = makeVault();
    const dataDir = makeVault();
    const api = makeApi({ vault, dataDir });
    const now = { value: at(DAY1) };
    const booted = boot({ api, now });
    booted.turnEnd();

    assert.equal(existsSync(rhythmStatePath(dataDir)), true);
    assert.equal(existsSync(ledgerStatePath(dataDir)), true);
    const vaultFiles = readdirSync(vault);
    assert.deepEqual(vaultFiles, ['台账']);
    assert.deepEqual(
      readdirSync(join(vault, '台账')).filter((name) => name.endsWith('.md')),
      ['待提醒.md'],
    );
    rmSync(vault, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('节律 · 兜底那条路：补报一次，不补第二次', () => {
  it('DSH 没在跑时先落一行；下次启动补报一次，之后不再补', () => {
    const vault = makeVault();
    const dataDir = makeVault();
    const api = makeApi({ vault, dataDir });

    // 计划任务在关机期间落的那一行（同一个键重复触发也只落一行）。
    const queued = fallbackReminder({ api, kind: 'day', value: '2026-11-06', at: '2026-11-06T07:00:00+08:00' });
    assert.equal(queued.ok, true);
    assert.equal(queued.wrote, true);
    assert.equal(fallbackReminder({ api, kind: 'day', value: '2026-11-06' }).wrote, false, '同一个周期键只一行');
    assert.deepEqual(reminderBook(vault), [['2026-11-06T07:00:00+08:00', 'day:2026-11-06', '今天 2026-11-06 该提醒一次（当时 DSH 没在跑）', '待报']]);

    // 启动：补报那一次，而且不再自己报同一档（不然就是两次提醒）。
    const now = { value: at(DAY2) };
    const booted = boot({ api, now });
    booted.turnEnd();
    assert.equal(booted.agent.injected.length, 1);
    assert.equal(booted.agent.text(), '[whale-pal] 补报：今天 2026-11-06 该提醒一次（当时 DSH 没在跑）');

    booted.turnEnd();
    assert.equal(booted.agent.injected.length, 1, '不补第二次');
    const restarted = boot({ api, now });
    restarted.turnEnd();
    assert.equal(restarted.agent.injected.length, 0, '重启也不补第二次');

    const rows = reminderBook(vault);
    assert.equal(rows.length, 1, '这一档在台账上只有一行');
    assert.equal(rows[0][3], '已报');
    rmSync(vault, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('已经报过的周期，兜底再来一行会被键挡住（不会变成两次）', () => {
    const vault = makeVault();
    const dataDir = makeVault();
    const api = makeApi({ vault, dataDir });
    const now = { value: at(DAY1) };
    const booted = boot({ api, now });
    booted.turnEnd();
    assert.equal(booted.agent.injected.length, 1);

    const late = fallbackReminder({ api, kind: 'day', value: '2026-11-05' });
    assert.equal(late.ok, true);
    assert.equal(late.wrote, false, '这个键已经有一行了');
    assert.equal(reminderBook(vault).length, 1);
    rmSync(vault, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('读不出的周期键不收（计划任务传错参数不该在库里留一行垃圾）', () => {
    const api = makeApi({ vault: makeVault(), dataDir: makeVault() });
    assert.equal(fallbackReminder({ api, kind: '第几档', value: 'x' }).reason, 'bad-period');
    assert.equal(fallbackReminder({ api, kind: 'day', value: '' }).reason, 'bad-period');
    assert.equal(fallbackReminder({ api: makeApi({}), kind: 'day', value: '2026-11-05' }).reason, 'vault-required');
  });
});

describe('节律 · 每天扫一次导致的重复扫描', () => {
  it('同一天只扫一次，强制才重扫；重扫也不会重复写台账', () => {
    const vault = makeVault();
    const dataDir = makeVault();
    const api = makeApi({ vault, dataDir });
    writeFileSync(
      api.paths.audit,
      `${JSON.stringify({ seq: 3, at: '2026-11-04T04:40:59.078Z', type: 'update', detail: { changes: [{ kind: 'commitment', op: 'lapsed', to: '一件没结的事' }] } })}\n`,
      'utf8',
    );
    const now = { value: at(DAY1) };
    const booted = boot({ api, now });
    assert.equal(rowsInBook({ vaultPath: vault, book: '待交接' }).rows.length, 1, '启动就接上');

    const same = booted.ledger.tick();
    assert.equal(same.scanned, false, '同一天不再扫');
    const forced = booted.ledger.tick({ force: true });
    assert.equal(forced.scanned, true);
    assert.deepEqual(forced.lapse.written, [], '已经记过的那条不会再写一遍');
    assert.equal(rowsInBook({ vaultPath: vault, book: '待交接' }).rows.length, 1, '重扫不重复写');

    // 跨天：再扫，新的 lapsed 才进来。
    now.value = at(DAY2);
    writeFileSync(
      api.paths.audit,
      `${readFileSync(api.paths.audit, 'utf8')}${JSON.stringify({ seq: 4, at: '2026-11-06T01:00:00.000Z', type: 'update', detail: { changes: [{ kind: 'commitment', op: 'lapsed', to: '第二件没结的事' }] } })}\n`,
      'utf8',
    );
    const nextDay = booted.ledger.tick();
    assert.equal(nextDay.scanned, true);
    assert.deepEqual(nextDay.lapse.written, ['lapse:4#0']);
    assert.equal(rowsInBook({ vaultPath: vault, book: '待交接' }).rows.length, 2);
    assert.equal(readLedgerState(ledgerStatePath(dataDir)).lapseSeq, 4);
    assert.equal(booted.ledger.info().handoffs, 2);
    rmSync(vault, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
});
