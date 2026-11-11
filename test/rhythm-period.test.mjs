/**
 * 周期键与「该不该提醒」的判法（纯函数）。
 * 口径出处：`融合计划-v2.md` D5（幂等键要能说清：日=日期、周=ISO 周、月=年月）、§5 的 P4 行。
 *
 * 时间一律用固定的毫秒 + 固定偏移量喂进来，所以这些断言在任何机器、任何时区都一样。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KINDS, dueKinds, isoWeekKeyOf, isoWeekOf, keysOf, kindFromKey, labelOf, nextDayStartMs, dayKeyOf, monthKeyOf } from '../lib/rhythm/period.js';

const at = (iso) => Date.parse(iso);
const SHANGHAI = 480; // +08:00

describe('节律 · 三档键', () => {
  it('日/周/月三档键：日=日期、周=ISO 周、月=年月', () => {
    assert.deepEqual(keysOf(at('2026-11-05T09:00:00+08:00'), SHANGHAI), { day: '2026-11-05', week: '2026-W45', month: '2026-11' });
    assert.equal(dayKeyOf(at('2026-11-05T09:00:00+08:00'), SHANGHAI), '2026-11-05');
    assert.equal(monthKeyOf(at('2026-11-05T09:00:00+08:00'), SHANGHAI), '2026-11');
    assert.equal(isoWeekKeyOf(at('2026-11-05T09:00:00+08:00'), SHANGHAI), '2026-W45');
  });

  it('日界按偏移量算：同一个 UTC 时刻，在 +08:00 是今天还是明天', () => {
    assert.equal(dayKeyOf(at('2026-11-05T15:30:00Z'), SHANGHAI), '2026-11-05');
    assert.equal(dayKeyOf(at('2026-11-05T16:30:00Z'), SHANGHAI), '2026-11-06');
    assert.equal(dayKeyOf(at('2026-11-05T16:30:00Z'), 0), '2026-11-05');
  });

  it('ISO 周跨年：12-29 已经算下一年的 W01，01-01 属于上一年最后一周', () => {
    assert.deepEqual(isoWeekOf(at('2025-12-29T00:00:00Z'), SHANGHAI), { year: 2026, week: 1 });
    assert.equal(isoWeekKeyOf(at('2025-12-29T00:00:00Z'), SHANGHAI), '2026-W01');
    assert.equal(isoWeekKeyOf(at('2026-01-01T00:00:00Z'), SHANGHAI), '2026-W01');
    // 2026 有 53 个 ISO 周（年底那几天还算在 2026-W53）。
    assert.equal(isoWeekKeyOf(at('2027-01-01T00:00:00Z'), SHANGHAI), '2026-W53');
    assert.equal(isoWeekKeyOf(at('2026-03-01T00:00:00Z'), SHANGHAI), '2026-W09');
  });

  it('时间读不出来就回空键，不猜一个日子出来', () => {
    assert.deepEqual(keysOf(NaN, SHANGHAI), { day: '', week: '', month: '' });
    assert.equal(dayKeyOf(undefined, SHANGHAI), '');
    assert.deepEqual(keysOf(at('2026-11-05T09:00:00Z'), '不是数字'), { day: '2026-11-05', week: '2026-W45', month: '2026-11' });
  });

  it('从键反推档位、拿人话标签', () => {
    assert.equal(kindFromKey('day:2026-11-05'), 'day');
    assert.equal(kindFromKey('week:2026-W45'), 'week');
    assert.equal(kindFromKey('month:2026-11'), 'month');
    assert.equal(kindFromKey('别的:1'), '');
    assert.equal(kindFromKey(''), '');
    assert.deepEqual([...KINDS], ['day', 'week', 'month']);
    assert.equal(labelOf('day'), '今天');
    assert.equal(labelOf('week'), '这一周');
    assert.equal(labelOf('month'), '这个月');
    assert.equal(labelOf('别的'), '');
  });
});

describe('节律 · 该不该提醒', () => {
  it('键没变就不报：这是「只出现一次」的那把尺', () => {
    const keys = { day: '2026-11-05', week: '2026-W45', month: '2026-11' };
    assert.deepEqual(dueKinds({ keys, fired: keys }), []);
    assert.deepEqual(dueKinds({ keys, fired: { ...keys, week: '2026-W44' } }), ['week']);
    assert.deepEqual(dueKinds({ keys, fired: {} }), ['day', 'week', 'month']);
    assert.deepEqual(dueKinds({ keys, fired: { day: '2026-11-04', week: '2026-W45', month: '2026-10' } }), ['day', 'month']);
  });

  it('键是空的不算到期（读不出日期的时候宁可不报）', () => {
    assert.deepEqual(dueKinds({ keys: { day: '', week: '', month: '' }, fired: {} }), []);
    assert.deepEqual(dueKinds({}), []);
    assert.deepEqual(dueKinds({ keys: { day: '2026-11-05' }, fired: {} }), ['day']);
  });

  it('跨过下一次本地零点还有多久（定时器用）', () => {
    assert.equal(nextDayStartMs(at('2026-11-05T09:00:00+08:00'), SHANGHAI), 15 * 3600 * 1000);
    assert.equal(nextDayStartMs(at('2026-11-05T23:59:00+08:00'), SHANGHAI), 60 * 1000);
    assert.equal(nextDayStartMs(NaN, SHANGHAI), 0);
  });
});
