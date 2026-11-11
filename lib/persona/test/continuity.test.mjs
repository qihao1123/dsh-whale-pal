import test from 'node:test'
import assert from 'node:assert/strict'

import { applyAssessment } from '../lib/updater.js'
import { createInitialState, normalizeState } from '../lib/state/schema.js'
import { renderStateSummary } from '../lib/prompt/render.js'
import { normalize, DEFAULTS } from '../lib/config.js'
import { selectMemory } from '../lib/memory.js'

const config = normalize({ ...DEFAULTS, bot_name: '六一' })

function fresh() {
  const state = createInitialState(config)
  state.sessionOrdinal = 0
  return state
}

function run(state, assessment, now = 1_000_000) {
  return applyAssessment(state, assessment, { now })
}

test('答应的事会被记下来，同一件事不会记两遍', () => {
  let state = fresh()
  state = run(state, { salience: 0.6, commitments: ['把 README 补完'] }).state
  state = run(state, { salience: 0.6, commitments: ['把README补完'] }).state
  const list = state.commitments
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'open')
})

test('做到之后变成已做到，摘要里不再提', () => {
  let state = fresh()
  state = run(state, { salience: 0.6, commitments: ['跑一遍全量测试'] }).state
  assert.match(renderStateSummary(state, config), /答应过：跑一遍全量测试/)

  state = run(state, { salience: 0.6, commitmentsDone: ['跑一遍全量测试'] }).state
  assert.equal(state.commitments[0].status, 'done')
  assert.doesNotMatch(renderStateSummary(state, config), /答应过/)
})

test('答应太久没做，会标成说到没做到，而不是一直挂着', () => {
  let state = fresh()
  state = run(state, { salience: 0.6, commitments: ['回头补一份说明'] }).state
  for (let i = 0; i < 13; i += 1) state = run(state, { salience: 0.6 }).state
  assert.equal(state.commitments[0].status, 'lapsed')
  assert.doesNotMatch(renderStateSummary(state, config), /答应过/)
})

test('没做完的事做完后进冷宫：不删，但不再进摘要', () => {
  let state = fresh()
  state = run(state, { salience: 0.7, memory: { openTopics: ['把设置页的关系卡片补上'] } }).state
  assert.match(renderStateSummary(state, config), /未完成：把设置页的关系卡片补上/)

  const before = state.memory.openTopics[0].salience
  state = run(state, { salience: 0.7, resolvedTopics: ['把设置页的关系卡片补上'] }).state
  const entry = state.memory.openTopics[0]
  assert.equal(entry.resolved, true)
  assert.ok(entry.salience < before, '做完的事该降权')
  assert.doesNotMatch(renderStateSummary(state, config), /未完成/)
  // 还在状态里，人问「上次那件事」时翻得到
  assert.equal(state.memory.openTopics.length, 1)
  const picked = selectMemory(state.memory, { session: state.sessionOrdinal, limit: 4, kinds: ['openTopics'] })
  assert.equal(picked.length, 0)
})

test('老状态里的约定（字符串或没状态）能升级上来', () => {
  const state = normalizeState(
    {
      relationship: { commitments: ['我会记得这件事', { text: '跑测试', status: 'done', session: 3 }] },
    },
    config,
  )
  assert.equal(state.commitments[0].status, 'open')
  assert.equal(state.commitments[1].status, 'done')
})
