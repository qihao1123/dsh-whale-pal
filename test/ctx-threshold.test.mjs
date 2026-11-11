import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { LIMITS, REMIND_MARGIN, rank, remainingOf, shouldAnnounce, tierOf, usedLimits } from '../lib/ctx/threshold.js'

describe('三档阈值与提醒去重', () => {
  it('LIMITS 按已用比例，三档都冻结', () => {
    assert.equal(Object.isFrozen(LIMITS), true, 'LIMITS 应冻结')
    assert.equal(LIMITS.remind.ratio, 0.2, 'remind 用掉 20%')
    assert.equal(LIMITS.urge.ratio, 0.72, 'urge 用掉 72%')
    assert.equal(LIMITS.critical.ratio, 0.8, 'critical 对齐原生 thresholdRatio 0.8')
    assert.equal(Object.isFrozen(LIMITS.critical), true, '每档也应冻结')
    assert.equal(REMIND_MARGIN, 0.04, '提醒相对触发点留 4%')
  })

  it('remainingOf 仍用窗口减已用（只给命令回执看，不参与判档）', () => {
    assert.equal(remainingOf({ tokens: 120000, window: 200000 }), 80000)
    assert.equal(remainingOf({ tokens: 0, window: 1000 }), 1000)
    assert.equal(remainingOf({ tokens: 10 }), null)
    assert.equal(remainingOf({ window: 1000 }), null)
    assert.equal(remainingOf({ tokens: 1, window: 0 }), null)
    assert.equal(remainingOf(), null)
  })

  it('usedLimits 给三档的已用阈值', () => {
    const l = usedLimits({ window: 100000 })
    assert.deepEqual(l, { remind: 20000, urge: 72000, critical: 80000 })
    assert.equal(usedLimits({ window: 0 }), null)
    assert.equal(usedLimits(), null)
  })

  it('给了触发点时，提醒点跟着它走（不早于触发点）', () => {
    // 窗口 100 万、触发点 16 万：0.2×W = 20 万，触发点 + 0.04×W = 20 万，取大的还是 20 万
    const a = usedLimits({ window: 1000000, trigger: 160000 })
    assert.equal(a.remind, 200000)
    // 小窗口触发点被地板抬到 5 万：0.2×W 只有 2 万，必须跟着触发点走
    const b = usedLimits({ window: 250000, trigger: 50000 })
    assert.equal(b.remind, 60000, '触发点 5 万 + 4% × 25 万 = 6 万')
    assert.ok(b.remind > b.remind - 1)
  })

  it('20% 边界：正好到线是 remind，差 1 是 ok', () => {
    assert.equal(tierOf({ used: 20000, window: 100000 }), 'remind')
    assert.equal(tierOf({ used: 19999, window: 100000 }), 'ok')
    assert.equal(tierOf({ used: 20001, window: 100000 }), 'remind')
  })

  it('72% 边界：正好到线是 urge，差 1 退回 remind', () => {
    assert.equal(tierOf({ used: 72000, window: 100000 }), 'urge')
    assert.equal(tierOf({ used: 71999, window: 100000 }), 'remind')
  })

  it('80% 边界：正好到线是 critical，差 1 退回 urge', () => {
    assert.equal(tierOf({ used: 80000, window: 100000 }), 'critical')
    assert.equal(tierOf({ used: 79999, window: 100000 }), 'urge')
  })

  it('1M 窗口上三档按比例落点，不再被绝对值压住', () => {
    // 旧写法在这里要等到已用 98.8 万才提醒；现在 20 万就该说
    assert.equal(tierOf({ used: 199999, window: 1000000 }), 'ok')
    assert.equal(tierOf({ used: 200000, window: 1000000 }), 'remind')
    assert.equal(tierOf({ used: 720000, window: 1000000 }), 'urge')
    assert.equal(tierOf({ used: 800000, window: 1000000 }), 'critical')
    // 对比：旧口径下 205,000 在 1M 窗口上还是 ok（这正是要修的问题）
    assert.equal(tierOf({ used: 205000, window: 1000000 }), 'remind', '现在 20.5 万就该提醒了')
  })

  it('小窗口上同样按比例，不会太晚', () => {
    assert.equal(tierOf({ used: 6000, window: 32000 }), 'ok')
    assert.equal(tierOf({ used: 6400, window: 32000 }), 'remind')
    assert.equal(tierOf({ used: 23040, window: 32000 }), 'urge')
    assert.equal(tierOf({ used: 25600, window: 32000 }), 'critical')
  })

  it('shouldAnnounce 只在档位变紧时为 true', () => {
    const tiers = ['ok', 'remind', 'urge', 'critical']

    for (const prev of tiers) {
      for (const next of tiers) {
        const expected = rank(next) > rank(prev)
        assert.equal(
          shouldAnnounce(prev, next),
          expected,
          `${prev} 到 ${next} 应${expected ? '' : '不'}提醒`,
        )
      }
    }
  })

  it('回血后同档不重复提醒，跌破更低档照常提醒', () => {
    assert.equal(shouldAnnounce('urge', 'ok'), false, '回血不提醒')
    assert.equal(shouldAnnounce('urge', 'remind'), false, '变松不提醒')
    assert.equal(shouldAnnounce('urge', 'critical'), true, '更紧应提醒')
    assert.equal(shouldAnnounce('critical', 'critical'), false, '同档不重复')
    assert.equal(shouldAnnounce('ok', 'remind'), true, '首次进入应提醒')
  })

  it('rank 给出 0 到 3，未知档位归 0', () => {
    assert.equal(rank('ok'), 0)
    assert.equal(rank('remind'), 1)
    assert.equal(rank('urge'), 2)
    assert.equal(rank('critical'), 3)
    assert.equal(rank('unknown'), 0)
    assert.equal(rank(null), 0)
    assert.equal(rank('toString'), 0, '原型键不应命中')
  })

  it('tierOf 缺参或窗口非法时回 ok', () => {
    assert.equal(tierOf(), 'ok', '空入参回 ok')
    assert.equal(tierOf({ used: 100 }), 'ok', '缺窗口回 ok')
    assert.equal(tierOf({ window: 100000 }), 'ok', '缺已用回 ok')
    assert.equal(tierOf({ used: 100, window: 0 }), 'ok', '窗口为 0 回 ok')
    assert.equal(tierOf({ used: -1, window: 100000 }), 'ok', '负已用回 ok')
    assert.equal(tierOf(null), 'ok', 'null 回 ok')
  })
})
