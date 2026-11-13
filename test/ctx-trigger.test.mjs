// 压缩触发点与主路执行器。
//
// 这套数是「按已用算、不写死 token」的第一道实现：窗口与地板都在运行期取，
// 测试里用桩把不同窗口喂进去，确认它没有偷偷把 1M 当常量。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_FLOOR_MARGIN,
  DEFAULT_RATIO,
  DEFAULT_REMIND_RATIO,
  NATIVE_THRESHOLD_RATIO,
  shouldRemind,
  shouldTrigger,
  triggerPoints,
} from '../lib/ctx/trigger.js';
import { MAX_CONSECUTIVE_FAILURES, ineffectiveText, makeCompactor } from '../lib/ctx/compact.js';

const W1M = 1_000_000;

describe('触发点：按已用算，窗口与地板都是运行期值', () => {
  it('1M 窗口、没有地板值时只走比例支', () => {
    const p = triggerPoints({ contextWindow: W1M });
    assert.equal(p.trigger, Math.floor(W1M * DEFAULT_RATIO));
    assert.equal(p.trigger, 160_000);
    assert.equal(p.remind, 200_000);
    assert.equal(p.floor, null);
    assert.equal(p.disabled, null);
  });

  it('地板把触发点抬起来：小窗口上比例支会被地板支超过', () => {
    // 地板 4 万、窗口 25 万：比例支 4 万，地板支 4 万 + 1 万 = 5 万
    const p = triggerPoints({ contextWindow: 250_000, floor: 40_000 });
    assert.equal(Math.floor(250_000 * DEFAULT_RATIO), 40_000);
    assert.equal(p.trigger, 50_000);
    assert.ok(p.trigger > Math.floor(250_000 * DEFAULT_RATIO), '地板支必须赢');
  });

  it('大窗口上比例支赢，地板支不起作用', () => {
    const p = triggerPoints({ contextWindow: W1M, floor: 40_000 });
    assert.equal(p.trigger, 160_000, '1M 上仍是 16%');
    assert.equal(Math.floor(40_000 + W1M * DEFAULT_FLOOR_MARGIN), 80_000);
    assert.equal(p.trigger, 160_000, '比例支 16 万 > 地板支 8 万');
  });

  it('提醒点跟着触发点走，永远不早于触发点', () => {
    for (const w of [100_000, 250_000, 500_000, W1M, 2_000_000]) {
      for (const floor of [null, 20_000, 40_000]) {
        const p = triggerPoints({ contextWindow: w, floor });
        assert.ok(p.remind >= p.trigger, `窗口 ${w} 地板 ${floor}：提醒 ${p.remind} 不该早于触发 ${p.trigger}`);
      }
    }
  });

  it('提醒点永远落在窗口内：地板很高的小窗口也不会算到窗口外', () => {
    // 32K 窗口、地板 3 万：触发点被地板抬到 31,280，若提醒点照「触发点 + 4%」算
    // 就是 32,560 —— 比窗口还大，那句提醒永远等不到。
    for (const w of [16_000, 32_000, 64_000, 128_000, 262_144, 500_000, W1M, 2_000_000]) {
      for (const floor of [null, 5_000, 20_000, 40_000, 80_000]) {
        const p = triggerPoints({ contextWindow: w, floor });
        assert.ok(p.remind <= w, `窗口 ${w} 地板 ${floor}：提醒点 ${p.remind} 越界`);
        assert.ok(p.remind >= p.trigger || p.disabled !== null,
          `窗口 ${w} 地板 ${floor}：未停用时提醒点不该早于触发点`);
      }
    }
  });

  it('小窗口自动退出：触发点够到原生 0.8 就停用，只留提醒', () => {
    // 32K 窗口、地板 3 万：地板支 3 万 + 1.28K = 31.28K，原生阈值 25.6K
    const p = triggerPoints({ contextWindow: 32_000, floor: 30_000 });
    assert.equal(p.nativeAt, Math.floor(32_000 * NATIVE_THRESHOLD_RATIO));
    assert.ok(p.disabled !== null, '32K 上必须停用自动压缩');
    assert.match(p.disabled, /原生阈值|地板/);
  });

  it('地板已经不低于触发点也算压不下去', () => {
    // 窗口 10 万、地板 9.9 万：地板支 9.9 万 + 4K = 10.3 万 > 窗口的 80%
    const p = triggerPoints({ contextWindow: 100_000, floor: 99_000 });
    assert.ok(p.disabled !== null);
  });

  it('窗口取不到就不给结论，不猜', () => {
    for (const bad of [undefined, null, 0, -1, NaN, '1000000']) {
      assert.equal(triggerPoints({ contextWindow: bad }), null, `${String(bad)} 应返回 null`);
    }
  });

  it('系数可以覆盖，默认值就是 16% / 20% / 4%', () => {
    const p = triggerPoints({ contextWindow: W1M, ratio: 0.1, remindRatio: 0.3, floorMargin: 0.01 });
    assert.equal(p.trigger, 100_000);
    assert.equal(p.remind, 300_000);
    assert.equal(DEFAULT_RATIO, 0.16);
    assert.equal(DEFAULT_REMIND_RATIO, 0.2);
    assert.equal(DEFAULT_FLOOR_MARGIN, 0.04);
  });

  it('系数写坏了回默认值：0 不能变成「每轮都压」，超 0.8 不能变成「永不压」', () => {
    // 这几个系数现在可以从 config.json 来，坏值不该悄悄改变行为。
    for (const bad of [0, -0.1, 0.8, 1, 2, '0.1', null, undefined, NaN, Infinity]) {
      const p = triggerPoints({ contextWindow: W1M, ratio: bad, floorMargin: bad });
      assert.equal(p.trigger, Math.floor(W1M * DEFAULT_RATIO), `ratio=${String(bad)} 应回默认`);
      assert.equal(p.remind, Math.floor(W1M * DEFAULT_REMIND_RATIO), `floorMargin=${String(bad)} 应回默认`);
      assert.equal(p.disabled, null, `ratio=${String(bad)} 不该让压缩停用`);
    }
    // 边界内的值照收：0.05 是 5%，不是坏值。
    assert.equal(triggerPoints({ contextWindow: W1M, ratio: 0.05 }).trigger, 50_000);
    // 地板支上的 10%：地板 20 万 + 50 万的 10% = 25 万，赢过比例支 8 万。
    assert.equal(triggerPoints({ contextWindow: 500_000, floor: 200_000, floorMargin: 0.1 }).trigger, 250_000);
  });
});

describe('到点判定：读数缺失一律不触发', () => {
  const points = triggerPoints({ contextWindow: W1M });

  it('刚好到点算到点，差一个 token 不算', () => {
    assert.equal(shouldTrigger({ used: points.trigger, points }), true);
    assert.equal(shouldTrigger({ used: points.trigger - 1, points }), false);
  });

  it('读数缺失或不是数字不触发', () => {
    for (const bad of [undefined, null, NaN, -1, '200000']) {
      assert.equal(shouldTrigger({ used: bad, points }), false, `${String(bad)} 不该触发`);
    }
    assert.equal(shouldTrigger({ used: 999_999, points: null }), false);
  });

  it('停用状态下即使超了触发点也不触发', () => {
    const dead = triggerPoints({ contextWindow: 32_000, floor: 30_000 });
    assert.ok(dead.disabled !== null);
    assert.equal(shouldTrigger({ used: 31_000, points: dead }), false);
  });

  it('提醒线独立于触发线：过了提醒线才提醒', () => {
    assert.equal(shouldRemind({ used: points.remind - 1, points }), false);
    assert.equal(shouldRemind({ used: points.remind, points }), true);
  });
});

// ---- 执行器：用桩喂宿主服务 ----

function makeAgent(overrides = {}) {
  return {
    session: { id: 'session-t', ...overrides.session },
    ...overrides,
  };
}

function makeMeter(readings) {
  // readings 是队列，每次 measure 取下一个；取完就停在最后一个
  let i = 0;
  return {
    measure: () => {
      const value = readings[Math.min(i, readings.length - 1)];
      i += 1;
      return value;
    },
    get calls() { return i; },
  };
}

describe('主路执行器：到点就压，失败不阻断', () => {
  it('没到点什么都不做', () => {
    const acted = [];
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { acted.push('compact'); return {}; } }),
      getMeter: () => makeMeter([{ totalTokens: 50_000, contextWindow: W1M }]),
      observe: () => {},
    });
    const out = c.run({ agent: makeAgent(), code: 's1', turn: 1 });
    assert.equal(out.acted, 'skipped');
    assert.equal(acted.length, 0);
  });

  it('到点就调 compactNow，压完把地板记下来', () => {
    const calls = [];
    const meter = makeMeter([
      { totalTokens: 200_000, contextWindow: W1M }, // 第一次量：超了
      { totalTokens: 40_000, contextWindow: W1M },  // 压完再量：地板
    ]);
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { calls.push('now'); return { ok: true }; } }),
      getMeter: () => meter,
    });
    const out = c.run({ agent: makeAgent(), code: 's2', turn: 5 });
    assert.equal(out.acted, 'compacted');
    assert.equal(calls.length, 1);
    assert.equal(c.stateOf('s2').floor, 40_000, '压完实测值要当地板');
  });

  it('系数从配置现取：改了下一轮就按新的算，读不出来回默认', () => {
    const calls = [];
    let ratio = 0.16;
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { calls.push('now'); return {}; } }),
      getMeter: () => makeMeter([{ totalTokens: 100_000, contextWindow: W1M }]),
      ratio: () => ratio,
    });
    const before = c.run({ agent: makeAgent(), code: 's-coef', turn: 1 });
    assert.equal(before.acted, 'skipped', '16% 下 10 万还没到 16 万');
    assert.equal(before.trigger, 160_000);

    ratio = 0.05;
    const after = c.run({ agent: makeAgent(), code: 's-coef', turn: 2 });
    assert.equal(after.trigger, 50_000, '改成 5% 后触发点该跟着降');
    assert.equal(after.acted, 'compacted');
    assert.equal(calls.length, 1);

    // 取系数时抛错：当没配，用默认值，不许把压缩整条路径带塌。
    const c2 = makeCompactor({
      getCompaction: () => ({ compactNow: () => ({}) }),
      getMeter: () => makeMeter([{ totalTokens: 100_000, contextWindow: W1M }]),
      ratio: () => { throw new Error('配置读不到'); },
    });
    const fallback = c2.run({ agent: makeAgent(), code: 's-coef2', turn: 1 });
    assert.equal(fallback.trigger, 160_000);
    assert.equal(fallback.acted, 'skipped');
  });

  it('先修剪，削够就不摘要', () => {
    const calls = [];
    const meter = makeMeter([
      { totalTokens: 200_000, contextWindow: W1M }, // 修剪前：超了
      { totalTokens: 100_000, contextWindow: W1M }, // 修剪后：降下来了
    ]);
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { calls.push('now'); return {}; } }),
      getMeter: () => meter,
      getPruner: () => ({ pruneSession: () => { calls.push('prune'); } }),
    });
    const out = c.run({ agent: makeAgent(), code: 's3', turn: 1 });
    assert.equal(out.acted, 'pruned');
    assert.deepEqual(calls, ['prune'], '削够就不该调 compactNow');
  });

  it('修剪不够才摘要', () => {
    const calls = [];
    const meter = makeMeter([
      { totalTokens: 200_000, contextWindow: W1M },
      { totalTokens: 190_000, contextWindow: W1M }, // 修剪只削掉一点
      { totalTokens: 40_000, contextWindow: W1M },  // 压完
    ]);
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { calls.push('now'); return {}; } }),
      getMeter: () => meter,
      getPruner: () => ({ pruneSession: () => { calls.push('prune'); } }),
    });
    const out = c.run({ agent: makeAgent(), code: 's4', turn: 1 });
    assert.equal(out.acted, 'compacted');
    assert.deepEqual(calls, ['prune', 'now']);
  });

  it('compactNow 抛错只记 warning，不抛出去', () => {
    const warnings = [];
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { throw new Error('宿主炸了'); } }),
      getMeter: () => makeMeter([{ totalTokens: 200_000, contextWindow: W1M }]),
      warn: (line) => warnings.push(line),
    });
    const out = c.run({ agent: makeAgent(), code: 's5', turn: 1 });
    assert.equal(out.acted, 'skipped');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /压缩没成/);
  });

  it('连续失败到上限就停用，之后不再尝试', () => {
    const warnings = [];
    let tries = 0;
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { tries += 1; throw new Error('nope'); } }),
      getMeter: () => makeMeter([{ totalTokens: 200_000, contextWindow: W1M }]),
      warn: (line) => warnings.push(line),
    });
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      c.run({ agent: makeAgent(), code: 's6', turn: i });
    }
    assert.equal(tries, MAX_CONSECUTIVE_FAILURES);
    // 另一个会话有自己的状态，会照常再试一次并失败
    const other = c.run({ agent: makeAgent(), code: 's7', turn: 99 });
    assert.equal(other.acted, 'skipped');
    assert.equal(tries, MAX_CONSECUTIVE_FAILURES + 1);
    // 同一个会话应已停用，不再尝试
    const same = c.run({ agent: makeAgent(), code: 's6', turn: 100 });
    assert.equal(same.acted, 'disabled');
    assert.equal(tries, MAX_CONSECUTIVE_FAILURES + 1, '停用后不该再调 compactNow');
    assert.ok(warnings.some((l) => /停用/.test(l)));
  });

  it('防抖：复检通过之后，刚压过的 N 轮内仍不再压', () => {
    let calls = 0;
    const meter = makeMeter([
      { totalTokens: 200_000, contextWindow: W1M }, // 到点
      { totalTokens: 40_000, contextWindow: W1M },  // 压完
      { totalTokens: 100_000, contextWindow: W1M }, // 下一轮：复检通过
      { totalTokens: 200_000, contextWindow: W1M }, // 再下一轮：又超了，但在防抖期内
    ]);
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { calls += 1; return {}; } }),
      getMeter: () => meter,
      cooldownTurns: 3,
    });
    const first = c.run({ agent: makeAgent(), code: 's8', turn: 10 });
    assert.equal(first.acted, 'compacted');
    assert.equal(calls, 1);
    const verify = c.run({ agent: makeAgent(), code: 's8', turn: 11 });
    assert.equal(verify.acted, 'skipped', '复检通过后照常收尾');
    assert.equal(c.stateOf('s8').disabled, null, '复检通过不该停用');
    const out = c.run({ agent: makeAgent(), code: 's8', turn: 12 });
    assert.equal(out.acted, 'skipped');
    assert.match(out.reason ?? '', /防抖/);
    assert.equal(calls, 1, '防抖期内不该再压');
  });

  // ---- 复检：压完下一轮仍超限就换会话（2026-11-09 人类定）
  //
  // 判据不是「压完读数多少」（那一刻的数不可靠），而是「下一轮收尾时还在线上吗」。
  it('压完下一轮仍超触发点：不再压，报 switch 并停用自动压缩', () => {
    let calls = 0;
    const observed = [];
    const meter = makeMeter([
      { totalTokens: 200_000, contextWindow: W1M }, // 到点
      { totalTokens: 40_000, contextWindow: W1M },  // 压完（地板）
      { totalTokens: 210_000, contextWindow: W1M }, // 下一轮收尾：仍超
    ]);
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { calls += 1; return {}; } }),
      getMeter: () => meter,
      observe: (line) => observed.push(line),
    });
    assert.equal(c.run({ agent: makeAgent(), code: 'v1', turn: 10 }).acted, 'compacted');

    const verdict = c.run({ agent: makeAgent(), code: 'v1', turn: 11 });
    assert.equal(verdict.acted, 'switch');
    assert.equal(verdict.used, 210_000);
    assert.equal(verdict.trigger, 160_000);
    assert.equal(calls, 1, '判成没用就不许再压第二次');

    const state = c.stateOf('v1');
    assert.ok(state.disabled !== null, '要停用，否则每轮都会想再压');
    assert.equal(state.verifyPending, false);
    assert.equal(state.usedAtCompact, 40_000, '压完那一刻的读数要留档');
    assert.deepEqual(state.ineffective, { used: 210_000, trigger: 160_000, atCompact: 40_000 });
    assert.ok(observed.some((line) => /仍超触发点/.test(line)));

    // 之后不再压，也不再重复判定
    const later = c.run({ agent: makeAgent(), code: 'v1', turn: 12 });
    assert.equal(later.acted, 'disabled');
    assert.equal(calls, 1);
  });

  it('压完下一轮降下来了：复检通过，功能照常可用', () => {
    let calls = 0;
    const meter = makeMeter([
      { totalTokens: 200_000, contextWindow: W1M },
      { totalTokens: 40_000, contextWindow: W1M },
      { totalTokens: 50_000, contextWindow: W1M },
      { totalTokens: 200_000, contextWindow: W1M }, // 再往后又超了
      { totalTokens: 40_000, contextWindow: W1M },
    ]);
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { calls += 1; return {}; } }),
      getMeter: () => meter,
      cooldownTurns: 0,
    });
    assert.equal(c.run({ agent: makeAgent(), code: 'v2', turn: 1 }).acted, 'compacted');
    const verify = c.run({ agent: makeAgent(), code: 'v2', turn: 2 });
    assert.equal(verify.acted, 'skipped');
    assert.equal(c.stateOf('v2').disabled, null, '复检通过不该停用');

    // 复检只判一次：后面再超限仍然照压
    const again = c.run({ agent: makeAgent(), code: 'v2', turn: 3 });
    assert.equal(again.acted, 'compacted');
    assert.equal(calls, 2);
    assert.equal(c.stateOf('v2').verifyPending, true, '第二次压完也要挂复检');
  });

  it('压成了要记进诊断账：同步收尾只记一条，并打上「已记账」标记', () => {
    // 回归：早先只有外层在 `run()` 返回时记一条「acted（reason）」，
    // 异步主路当场只能说「已接手」，结果那一条谁也补不上，recent 停在半句话上。
    const reported = [];
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => ({}) }),
      getMeter: () => makeMeter([
        { totalTokens: 200_000, contextWindow: W1M },
        { totalTokens: 40_000, contextWindow: W1M },
      ]),
      report: (line) => reported.push(line),
    });
    const out = c.run({ agent: makeAgent(), code: 'r1', turn: 1 });
    assert.equal(out.acted, 'compacted');
    assert.equal(out.reported, true, '已记账要标出来，外层才不重复记');
    assert.deepEqual(reported, ['compacted（200000 → 40000）']);
  });

  it('主路异步：当场不记账，/compact 回来才补一条结果', async () => {
    const reported = [];
    const c = makeCompactor({
      getExecutor: () => () => Promise.resolve({ ok: true, kind: 'success', text: 'Compacted 12 items' }),
      getMeter: () => makeMeter([
        { totalTokens: 200_000, contextWindow: W1M },
        { totalTokens: 40_000, contextWindow: W1M },
      ]),
      report: (line) => reported.push(line),
    });
    const out = c.run({ agent: makeAgent(), code: 'r2', turn: 1 });
    assert.equal(out.acted, 'started');
    assert.equal(out.reported, false, '当场还没结果，不许假称记过');
    assert.deepEqual(reported, [], '这一拍不该有结论');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(reported, ['compacted（200000 → 40000）'], '结果回来要补上，带上压前压后');
    assert.equal(c.stateOf('r2').compactions, 1);
  });

  it('压不成也记进账：失败是「过程」里最该看见的那一条', async () => {
    const reported = [];
    const c = makeCompactor({
      getExecutor: () => () => Promise.resolve({ ok: false, kind: 'busy', text: 'agent 正忙' }),
      getMeter: () => makeMeter([{ totalTokens: 200_000, contextWindow: W1M }]),
      notify: () => {},
      report: (line) => reported.push(line),
    });
    c.run({ agent: makeAgent(), code: 'r3', turn: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(reported, ['failed（agent 正忙）']);
  });

  it('提醒按「局面」算：外面压过一次就重新武装，不是一整个会话只说一次', () => {
    // 回归：原先是「一个会话只说一次」。人手动压完一次之后，同一会话里
    // 主路再失效就再也不会提醒 —— 提醒的边界应该是失效的局面，不是会话。
    const injected = [];
    const meter = makeMeter([
      { totalTokens: 200_000, contextWindow: W1M },
      { totalTokens: 200_000, contextWindow: W1M }, // 还超着，同一局面
      { totalTokens: 40_000, contextWindow: W1M },  // 人手动压过了
      { totalTokens: 200_000, contextWindow: W1M }, // 又爬上来了
    ]);
    const c = makeCompactor({
      getExecutor: () => () => ({ ok: false, kind: 'busy', text: 'agent 正忙' }),
      getMeter: () => meter,
      notify: (line) => injected.push(line),
    });
    c.run({ agent: makeAgent(), code: 'r5', turn: 1 });
    assert.equal(injected.length, 1, '失效要说一句');
    c.run({ agent: makeAgent(), code: 'r5', turn: 2 });
    assert.equal(injected.length, 1, '同一个局面不重复念');
    c.run({ agent: makeAgent(), code: 'r5', turn: 3 });
    assert.equal(c.stateOf('r5').failureNotified, false, '读数掉到触发点之下就该翻篇');
    c.run({ agent: makeAgent(), code: 'r5', turn: 4 });
    assert.equal(injected.length, 2, '翻篇之后再失效，还得能提醒');
  });

  it('rearm 幂等，且只动「已提醒」这一格', () => {
    const injected = [];
    const c = makeCompactor({
      getExecutor: () => () => ({ ok: false, kind: 'busy', text: 'agent 正忙' }),
      getMeter: () => makeMeter([{ totalTokens: 200_000, contextWindow: W1M }]),
      notify: (line) => injected.push(line),
    });
    c.run({ agent: makeAgent(), code: 'r6', turn: 1 });
    const before = c.stateOf('r6');
    assert.equal(before.failureNotified, true);
    assert.equal(c.rearm('r6', '手动压了'), true);
    assert.equal(c.stateOf('r6').failureNotified, false);
    assert.equal(c.rearm('r6', '再压一次'), false, '没记过提醒就没必要再清');
    const after = c.stateOf('r6');
    assert.equal(after.disabled, before.disabled);
    assert.equal(after.floor, before.floor);
    assert.equal(after.compactions, before.compactions);
  });

  it('复检通过也记账：不然 recent 上只剩一个「skipped」，看不出为什么没压', () => {
    const reported = [];
    // 注意：meter 要在外面建好再给出去 —— `getMeter` 每轮都会调一次，
    // 在里面新建就等于每轮都从第一条读数重新开始。
    const meter = makeMeter([
      { totalTokens: 200_000, contextWindow: W1M },
      { totalTokens: 40_000, contextWindow: W1M },
      { totalTokens: 50_000, contextWindow: W1M },
    ]);
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => ({}) }),
      getMeter: () => meter,
      cooldownTurns: 0,
      report: (line) => reported.push(line),
    });
    c.run({ agent: makeAgent(), code: 'r4', turn: 1 });
    reported.length = 0; // 只看复检那一轮
    assert.equal(c.run({ agent: makeAgent(), code: 'r4', turn: 2 }).acted, 'skipped');
    assert.equal(reported.length, 1);
    assert.match(reported[0], /^verify-ok/);
    assert.match(reported[0], /40000/);
    assert.match(reported[0], /50000/);
    assert.match(reported[0], /160000/);
  });

  it('压缩失败不挂复检：没压成就没有「压完还超」这回事', () => {
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => { throw new Error('nope'); } }),
      getMeter: () => makeMeter([{ totalTokens: 200_000, contextWindow: W1M }]),
      warn: () => {},
    });
    const out = c.run({ agent: makeAgent(), code: 'v3', turn: 1 });
    assert.equal(out.acted, 'skipped');
    const state = c.stateOf('v3');
    assert.equal(state.verifyPending, false);
    assert.equal(state.usedAtCompact, null);
  });

  it('换会话那句话带上两个数，且说清「不会再压」', () => {
    const line = ineffectiveText({ used: 210_000, trigger: 160_000 });
    assert.match(line, /210000/);
    assert.match(line, /160000/);
    assert.match(line, /不会再压/);
    assert.match(line, /新会话/);
    // 缺数也不许说空话
    const degraded = ineffectiveText({});
    assert.match(degraded, /新会话/);
    assert.doesNotMatch(degraded, /undefined|null|NaN/);
  });

  it('服务不在时只报 unavailable，不记 warning', () => {
    const warnings = [];
    const c = makeCompactor({
      getCompaction: () => null,
      getMeter: () => null,
      warn: (line) => warnings.push(line),
    });
    const out = c.run({ agent: makeAgent(), code: 's9', turn: 1 });
    assert.equal(out.acted, 'unavailable');
    assert.equal(warnings.length, 0, '服务缺失是常态，不该刷 warning');
  });

  it('读数里没有 totalTokens 时不猜', () => {
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => ({}) }),
      getMeter: () => makeMeter([{ contextWindow: W1M }]),
    });
    const out = c.run({ agent: makeAgent(), code: 's10', turn: 1 });
    assert.equal(out.acted, 'unavailable');
    assert.match(out.reason ?? '', /totalTokens/);
  });

  it('读不到窗口就不下结论', () => {
    const c = makeCompactor({
      getCompaction: () => ({ compactNow: () => ({}) }),
      getMeter: () => makeMeter([{ totalTokens: 999_999 }]),
    });
    const out = c.run({ agent: makeAgent(), code: 's11', turn: 1 });
    assert.equal(out.acted, 'unavailable');
    assert.match(out.reason ?? '', /窗口/);
  });
});
