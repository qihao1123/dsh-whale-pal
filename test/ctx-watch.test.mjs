// 锁的是 projection 折叠这一层：事件怎么折、同一份压两次怎么算代、prune 不进档案、
// 以及最重要的一条——apply 里一个字节都不写盘。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  NON_TEXT,
  PROJECTION_KEY,
  STATE_VERSION,
  atOf,
  drainPlan,
  foldEvent,
  initialState,
  makeProjection,
  rangeOf,
  seqsOf,
  summarizePayload,
} from '../lib/ctx/watch.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'ctx', 'watch.js'), 'utf8');

function summaryEvent(id, payload = {}) {
  return {
    type: 'compaction/summary',
    at: '2026-11-04T05:00:00Z',
    data: {
      compactionId: id,
      summary: '这一段在讲投影与落盘',
      shadowedRange: { start: 10, end: 80 },
      shadowedTokenCount: 4200,
      provider: 'deepseek',
      model: 'flash',
      ...payload,
    },
  };
}

describe('投影：形状与接线', () => {
  it('投影键、版本、init 都照口径', () => {
    const projection = makeProjection();
    assert.equal(projection.key, PROJECTION_KEY);
    assert.equal(projection.key, 'whaleContext');
    assert.equal(projection.stateVersion, STATE_VERSION);
    assert.equal(projection.stateVersion, 2);
    assert.deepEqual(projection.init(), initialState());
  });

  it('apply 就是 foldEvent 本身，中间不许再包一层', () => {
    assert.equal(makeProjection().apply, foldEvent);
  });

  it('这一层不碰盘：源码里没有 node:fs', () => {
    assert.equal(source.includes("'node:fs'"), false);
    assert.equal(source.includes('"node:fs"'), false);
  });
});

describe('投影：折叠', () => {
  it('一次压缩排进一条，范围用破折号连起来', () => {
    const state = foldEvent(initialState(), summaryEvent('c-1'));
    assert.equal(state.pendingArchives.length, 1);
    assert.equal(state.pendingArchives[0].blockId, 'c-1');
    assert.equal(state.pendingArchives[0].gen, 1);
    assert.equal(state.pendingArchives[0].range, '10–80');
    assert.equal(state.pendingArchives[0].tokens, 4200);
    assert.equal(state.source, 'native');
    assert.equal(state.lastAt, '2026-11-04T05:00:00Z');
  });

  it('同一份再压一次是下一代：旧项留着，seen 记到 2', () => {
    const first = foldEvent(initialState(), summaryEvent('c-1'));
    const second = foldEvent(first, summaryEvent('c-1', { summary: '又压了一次' }));
    assert.equal(second.pendingArchives.length, 2);
    assert.equal(second.pendingArchives[0].gen, 1);
    assert.equal(second.pendingArchives[1].gen, 2);
    assert.equal(second.pendingArchives[0].text, '这一段在讲投影与落盘');
    assert.equal(second.seen['c-1'], 2);
  });

  it('prune 不是压缩：只记次数，不进档案队列', () => {
    const state = foldEvent(initialState(), {
      type: 'compaction/prune',
      data: { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], shadowedTokenCount: 300 },
    });
    assert.equal(state.pendingArchives.length, 0);
    assert.equal(state.pruned, 1);
  });

  it('同一串事件重放两次，结果逐字一样', () => {
    const events = [summaryEvent('c-1'), summaryEvent('c-2'), { type: 'compaction/prune' }, summaryEvent('c-1')];
    const once = events.reduce((state, event) => foldEvent(state, event), initialState());
    const twice = events.reduce((state, event) => foldEvent(state, event), initialState());
    assert.deepEqual(once, twice);
  });

  it('不改入参：折完原来的状态还是空的', () => {
    const before = initialState();
    foldEvent(before, summaryEvent('c-1'));
    assert.equal(before.pendingArchives.length, 0);
    assert.deepEqual(before.seen, {});
  });
});

describe('投影：摘要文本', () => {
  it('多块摘要按顺序接，非文本块记一个占位', () => {
    const parsed = summarizePayload({
      compactionId: 'c-9',
      summary: [
        { type: 'text', text: '第一段' },
        { type: 'image', text: '' },
        { type: 'text', text: '第二段' },
      ],
      shadowedRange: { start: 3, end: 9 },
      shadowedTokenCount: 12,
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.text, `第一段\n${NON_TEXT}\n第二段`);
  });

  it('载荷不是对象就报 payload-invalid，不抛', () => {
    assert.deepEqual(summarizePayload(null), { ok: false, reason: 'payload-invalid' });
    assert.deepEqual(summarizePayload('abc'), { ok: false, reason: 'payload-invalid' });
  });

  it('范围缺一头就回空串', () => {
    assert.equal(rangeOf({ start: 1 }), '');
    assert.equal(rangeOf({ start: 1, end: 2 }), '1–2');
  });
});

describe('投影：交队列', () => {
  it('drainPlan 交出去之后清队列，但 seen 要留着', () => {
    const state = foldEvent(foldEvent(initialState(), summaryEvent('c-1')), summaryEvent('c-2'));
    const drained = drainPlan(state);
    assert.equal(drained.archives.length, 2);
    assert.deepEqual(drained.nextState.pendingArchives, []);
    assert.deepEqual(drained.nextState.seen, { 'c-1': 1, 'c-2': 1 });
    const again = foldEvent(drained.nextState, summaryEvent('c-1'));
    assert.equal(again.pendingArchives[0].gen, 2);
  });
});

// 真机信封：2026-11-04 那次手动 /compact 的原样记录。
// 这一段是补的——以前的单测自己造了个带 `at` 的信封，宿主根本不产出那种形状，
// 于是「at 恒为空串 → 卡片被判不合法」这个 bug 在 716 条测试里一条都没照出来。
const realEvent = JSON.parse(readFileSync(join(here, 'fixtures', 'compaction-summary-2026-11-04.json'), 'utf8'));

describe('投影：真机信封', () => {
  it('信封里是 time，没有 at', () => {
    assert.equal(realEvent.at, undefined);
    assert.equal(typeof realEvent.time, 'number');
    assert.equal(atOf(realEvent), new Date(realEvent.time).toISOString());
  });

  it('折叠真机事件：范围、tokens、时间、seqs 都对得上', () => {
    const state = foldEvent(initialState(), realEvent);
    const item = state.pendingArchives[0];
    assert.equal(state.pendingArchives.length, 1);
    assert.equal(item.range, '15–824');
    assert.equal(item.tokens, 90722);
    assert.equal(item.at, new Date(realEvent.time).toISOString());
    assert.equal(item.text.length, 9082);
    assert.equal(item.seqs.length, 184);
    assert.equal(item.seqs[0], 15);
    assert.equal(item.seqs[183], 824);
    assert.equal(state.lastAt, item.at);
  });

  it('seqs 只留整数，缺字段回空数组', () => {
    assert.deepEqual(seqsOf({ shadowedSeqs: [1, 'x', 2.7, null, 3] }), [1, 2, 3]);
    assert.deepEqual(seqsOf({}), []);
    assert.deepEqual(seqsOf(null), []);
  });

  it('atOf：有 at 用 at，没 at 用 time，都没有回空串', () => {
    assert.equal(atOf({ at: '2026-01-01T00:00:00Z', time: 1 }), '2026-01-01T00:00:00Z');
    assert.equal(atOf({ at: '', time: 1793754352296 }), new Date(1793754352296).toISOString());
    assert.equal(atOf({}), '');
    assert.equal(atOf(null), '');
  });
});
