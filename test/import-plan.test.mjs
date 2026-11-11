import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CHECK_LABELS, checkCounts, checkLines, shortMemoryOf } from '../lib/import/check.js'
import { planImport, planText, PLAN_REASONS } from '../lib/import/plan.js'

// 该不该导是三条短路，先判后写：判错就会把「已经住下」的新状态盖掉。
describe('导入计划：该不该导', () => {
  it('新根没状态、旧根有 → 该导', () => {
    assert.deepEqual(planImport({ legacy: { revision: 1 } }), { action: 'import', reason: 'import' })
  })

  it('新根已有状态 → 不导（说明导过或已经住下了）', () => {
    assert.deepEqual(planImport({ stateExists: true, legacy: { revision: 1 } }), { action: 'skip', reason: 'state-exists' })
  })

  it('导过但当时是空的也算导过（import-record 在）', () => {
    assert.deepEqual(planImport({ recordExists: true, legacy: { revision: 1 } }), { action: 'skip', reason: 'already-imported' })
  })

  it('旧根没有状态 → 不导（全新机器）', () => {
    for (const legacy of [null, undefined, 'x', 7]) {
      assert.deepEqual(planImport({ legacy }), { action: 'skip', reason: 'no-legacy-state' }, `${String(legacy)} 应算没有状态`)
    }
  })

  it('短路顺序固定：新根有状态时，别的一律不看', () => {
    assert.equal(planImport({ stateExists: true, recordExists: true, legacy: null }).reason, 'state-exists')
    assert.equal(planImport({}).reason, 'no-legacy-state')
    assert.deepEqual(planImport(), { action: 'skip', reason: 'no-legacy-state' }, '空入参不抛')
  })

  it('理由只有这四种，且每种都有句人话', () => {
    assert.deepEqual(PLAN_REASONS, ['import', 'state-exists', 'already-imported', 'no-legacy-state'])
    for (const reason of PLAN_REASONS) {
      const said = planText({ reason })
      assert.equal(typeof said, 'string')
      assert.ok(said.length > 0, `${reason} 要有一句话`)
    }
    assert.ok(planText({ reason: '说不清' }).includes('说不清'), '没见过的理由照实带出来')
  })
})

// 核对只报不修：它存在的意义是发现「导丢了」，不是把差异抹平。
describe('逐项核对', () => {
  const before = { revision: 358, facts: 174, preferences: 60, events: 43, openTopics: 30, longMemory: 40, traits: 8, commitments: 20 }
  const after = { revision: 358, facts: 174, preferences: 60, events: 43, openTopics: 30, longMemory: 40, traits: 8, commitments: 20 }

  it('逐项一致时 same 为真、diff 为空', () => {
    const checked = checkCounts(before, after)
    assert.equal(checked.same, true)
    assert.deepEqual(checked.diff, [])
    assert.equal(checked.rows.length, Object.keys(CHECK_LABELS).filter((key) => key in before || key in after).length)
  })

  it('少了一条就点出是哪个键', () => {
    const checked = checkCounts(before, { ...after, commitments: 19 })
    assert.deepEqual(checked.diff, ['commitments'])
    assert.equal(checked.same, false)
    const line = checkLines(checked).find((one) => one.startsWith('承诺'))
    assert.equal(line, '承诺：旧 20 → 新 19（新比旧少 1）')
  })

  it('多出来也照实说，不说成「差」', () => {
    const line = checkLines(checkCounts({ facts: 1 }, { facts: 4 })).find((one) => one.startsWith('短记忆·事实'))
    assert.equal(line, '短记忆·事实：旧 1 → 新 4（新比旧多 3）')
  })

  it('短记忆是四类相加，人话里给合计', () => {
    assert.equal(shortMemoryOf(before), 174 + 60 + 43 + 30)
    assert.ok(checkLines(checkCounts(before, after))[0].includes('短记忆合计：旧 307 → 新 307'))
  })

  it('缺项按 0 算，不抛；空入参也回一行人话', () => {
    const checked = checkCounts({ facts: 3 }, {})
    assert.equal(checked.rows.find((row) => row.key === 'facts').after, 0)
    assert.deepEqual(checkLines({ rows: [] }), ['逐项核对：没有可比的两份计数'])
    assert.doesNotThrow(() => checkCounts())
    assert.doesNotThrow(() => checkLines())
  })
})
