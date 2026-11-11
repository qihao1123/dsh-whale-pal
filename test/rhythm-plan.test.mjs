/**
 * 一次节律该做什么（纯函数）：文案、兜底行、让位规则。
 * 口径出处：`融合计划-v2.md` D5（没在跑就落一行，下次启动补报一次、不补第二次）、§13.6（说事实、不催）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fallbackCells, fullKey, injectText, reminderText, reportText, reportedCells, tickPlan, valueOf } from '../lib/rhythm/plan.js';

const KEYS = { day: '2026-11-05', week: '2026-W45', month: '2026-11' };

describe('节律 · 文案', () => {
  it('自己算的那一次只说两个真读数', () => {
    assert.equal(reminderText({ kind: 'day', key: 'day:2026-11-05', counts: { handoffs: 2, fills: 3 } }), '今天 2026-11-05：待交接 2 条、事件里待补 3 行');
    assert.equal(reminderText({ kind: 'week', key: 'week:2026-W45', counts: { handoffs: 1, fills: 0 } }), '这一周 2026-W45：待交接 1 条');
    assert.equal(reminderText({ kind: 'month', key: 'month:2026-11', counts: { handoffs: 0, fills: 0 } }), '这个月 2026-11：没有欠着的事');
  });

  it('兜底那条路的话只说「当时没在跑」，不编读数', () => {
    const cells = fallbackCells({ kind: 'day', value: '2026-11-05', at: '2026-11-05T07:00:00+08:00' });
    assert.deepEqual(cells, ['2026-11-05T07:00:00+08:00', 'day:2026-11-05', '今天 2026-11-05 该提醒一次（当时 DSH 没在跑）', '待报']);
    assert.equal(reminderText({ kind: 'day', key: 'day:2026-11-05' }), '今天 2026-11-05：当时 DSH 没在跑，先记一行');
  });

  it('补报的话把兜底那行原文端出来', () => {
    assert.equal(reportText('今天 2026-11-05 该提醒一次（当时 DSH 没在跑）'), '补报：今天 2026-11-05 该提醒一次（当时 DSH 没在跑）');
    assert.match(reportText(''), /^补报一次/);
  });

  it('键的拼法与拆法', () => {
    assert.equal(fullKey('day', '2026-11-05'), 'day:2026-11-05');
    assert.equal(valueOf('day:2026-11-05'), '2026-11-05');
    assert.equal(valueOf('week:2026-W45'), '2026-W45');
    assert.equal(valueOf('没有了'), '');
  });

  it('投进会话的每一行都带插件前缀', () => {
    assert.equal(injectText(['一句', '', '两句']), '[whale-pal] 一句\n[whale-pal] 两句');
    assert.equal(injectText([]), '');
  });
});

describe('节律 · 让位与去重', () => {
  it('报过的档不再报', () => {
    const plan = tickPlan({ keys: KEYS, fired: { ...KEYS }, counts: {} });
    assert.deepEqual(plan.fire, []);
    assert.deepEqual(plan.report, []);
    assert.deepEqual(plan.covered, []);
  });

  it('只有日的键变了，就只报日那一档', () => {
    const plan = tickPlan({ keys: KEYS, fired: { day: '2026-11-04', week: '2026-W45', month: '2026-11' }, counts: { handoffs: 0, fills: 2 } });
    assert.deepEqual(plan.fire.map((one) => one.key), ['day:2026-11-05']);
    assert.equal(plan.fire[0].text, '今天 2026-11-05：事件里待补 2 行');
    assert.equal(plan.fire[0].value, '2026-11-05');
  });

  it('兜底已经落了一行：补报那一次，自己不再报同一个键（提醒只出现一次）', () => {
    const pending = [{ index: 0, key: 'day:2026-11-05', what: '今天 2026-11-05 该提醒一次（当时 DSH 没在跑）' }];
    const plan = tickPlan({ keys: KEYS, fired: { week: '2026-W45', month: '2026-11' }, pending, counts: { handoffs: 1, fills: 0 } });
    assert.deepEqual(plan.report.map((one) => one.key), ['day:2026-11-05']);
    assert.equal(plan.report[0].text, '补报：今天 2026-11-05 该提醒一次（当时 DSH 没在跑）');
    assert.equal(plan.report[0].kind, 'day');
    assert.deepEqual(plan.fire, [], '同一个键不许既补报又自己报');
  });

  it('待提醒里已经有一行（补报过、状态已报）：只记账，不重复说', () => {
    const plan = tickPlan({ keys: KEYS, fired: { week: '2026-W45', month: '2026-11' }, coveredKeys: ['day:2026-11-05'], counts: {} });
    assert.deepEqual(plan.fire, []);
    assert.deepEqual(plan.report, []);
    assert.deepEqual(plan.covered, [{ kind: 'day', key: 'day:2026-11-05', value: '2026-11-05', reason: 'already-logged' }]);
  });

  it('重复的待报行只补报一次', () => {
    const pending = [
      { index: 0, key: 'day:2026-11-05', what: '第一次记的' },
      { index: 1, key: 'day:2026-11-05', what: '重复记的' },
    ];
    const plan = tickPlan({ keys: {}, fired: {}, pending });
    assert.equal(plan.report.length, 1);
    assert.equal(plan.report[0].text, '补报：第一次记的');
  });

  it('已报那一行留给人的长相：状态写「已报」', () => {
    const cells = reportedCells({ key: 'day:2026-11-05', text: '今天 2026-11-05：没有欠着的事', at: '2026-11-05T09:00:00+08:00' });
    assert.deepEqual(cells, ['2026-11-05T09:00:00+08:00', 'day:2026-11-05', '今天 2026-11-05：没有欠着的事', '已报']);
  });
});
