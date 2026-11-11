import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { pickSource } from '../lib/ctx/source.js'

describe('pickSource 三态选择', () => {
  it('pressure 齐全时走 native，projectedTokens 覆盖窗口差值', () => {
    const picked = pickSource({
      pressure: { pressureTokens: 100000, projectedTokens: 120000, contextWindow: 200000 },
    })

    assert.deepEqual(picked, { kind: 'native', tokens: 120000, window: 200000, exact: true }, 'native 应优先读 projectedTokens')
  })

  it('没有 projectedTokens 时 native 交出的就是已用的压力值', () => {
    const picked = pickSource({ pressure: { pressureTokens: 150000, contextWindow: 200000 } })

    assert.deepEqual(picked, { kind: 'native', tokens: 150000, window: 200000, exact: true }, '已用多少就报多少，剩多少交给 threshold 减')
  })

  it('pressure 缺窗口时不抢 native，交给 occupied', () => {
    const picked = pickSource({
      pressure: { pressureTokens: 100000 },
      envelope: { stats: { contextTokens: 90000 } },
    })

    assert.deepEqual(picked, { kind: 'occupied', tokens: 90000, window: null, exact: true }, '缺窗口应退回 occupied')
  })

  it('occupied 读 stats.contextTokens 且窗口为 null', () => {
    const picked = pickSource({ envelope: { stats: { contextTokens: 88000 } } })

    assert.equal(picked.kind, 'occupied', '应命中 occupied')
    assert.equal(picked.tokens, 88000, 'token 应取信封读数')
    assert.equal(picked.window, null, 'occupied 没有窗口')
    assert.equal(picked.exact, true, '信封读数是精确值')
  })

  it('envelope 为 null 时 native 照样成立', () => {
    const picked = pickSource({
      pressure: { pressureTokens: 1000, contextWindow: 8000 },
      envelope: null,
    })

    assert.equal(picked.kind, 'native', 'native 不依赖信封')
    assert.equal(picked.tokens, 1000, '交出去的是已用的量')
    assert.equal(picked.window, 8000, '窗口照实传')
  })

  it('三样都缺回 none 且 tokens 与 window 全 null', () => {
    assert.deepEqual(pickSource(), { kind: 'none', tokens: null, window: null, exact: false }, '空入参应是 none')
    assert.deepEqual(pickSource({}), { kind: 'none', tokens: null, window: null, exact: false }, '空对象应是 none')
  })

  it('none 用字符除 3 四舍五入并标 exact:false', () => {
    assert.deepEqual(pickSource({ estimate: { chars: 100 } }), { kind: 'none', tokens: 33, window: null, exact: false }, '100 字符应估 33')
    assert.deepEqual(pickSource({ estimate: { chars: 10 } }), { kind: 'none', tokens: 3, window: null, exact: false }, '10/3 应四舍五入到 3')
    assert.deepEqual(pickSource({ estimate: { chars: 11 } }), { kind: 'none', tokens: 4, window: null, exact: false }, '11/3 应四舍五入到 4')
    assert.deepEqual(pickSource({ estimate: { chars: 10, per: 4 } }), { kind: 'none', tokens: 3, window: null, exact: false }, '自定义 per 应生效')
  })

  it('contextWindow 缺省时退回绝对值并标 exact:false', () => {
    const picked = pickSource({
      pressure: { pressureTokens: 1000, projectedTokens: 5000 },
      estimate: { chars: 300 },
    })

    assert.equal(picked.kind, 'none', '缺窗口时不能算 native')
    assert.equal(picked.tokens, 100, '应退回字符粗估')
    assert.equal(picked.exact, false, '粗估不精确')
  })

  it('occupied 只认正数，0 与负数都往下走', () => {
    const zero = pickSource({ envelope: { stats: { contextTokens: 0 } }, estimate: { chars: 30 } })
    const negative = pickSource({ envelope: { stats: { contextTokens: -8 } }, estimate: { chars: 30 } })

    assert.equal(zero.kind, 'none', '0 不算 occupied')
    assert.equal(negative.kind, 'none', '负数不算 occupied')
    assert.equal(zero.tokens, 10, '应落到 estimate')
  })

  it('形状不对一律静默降级，不抛异常', () => {
    const inputs = [
      null,
      undefined,
      42,
      'text',
      [],
      { pressure: 'bad' },
      { pressure: null, envelope: 'bad', estimate: 'bad' },
      { pressure: { pressureTokens: -1, contextWindow: 0 } },
      { pressure: { pressureTokens: 1, contextWindow: Number.NaN } },
      { estimate: { chars: '100' } },
      { estimate: { chars: -1 } },
      { estimate: { chars: 10, per: 0 } },
    ]

    for (const input of inputs) {
      assert.doesNotThrow(() => pickSource(input), `入参 ${String(input)} 不应抛`)
      const picked = pickSource(input)
      assert.equal(picked.kind, 'none', '坏形状应降级为 none')
      assert.equal(picked.window, null, '降级后窗口为 null')
    }
  })

  it('estimate 的 per 非法时按默认 3 算', () => {
    const picked = pickSource({ estimate: { chars: 30, per: -2 } })

    assert.equal(picked.tokens, 10, 'per 非法应回默认 3')
    assert.equal(picked.exact, false, '粗估不精确')
  })
})
