import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULTS, normalize } from '../lib/config.js'
import { createInitialState, normalizeState } from '../lib/state/schema.js'
import { applyAssessment } from '../lib/updater.js'

const CONFIG = normalize({ ...DEFAULTS })
const NOW = 1_700_000_000_000

function fresh() {
  return createInitialState(CONFIG, NOW)
}

function run(state, assessment, options = {}) {
  return applyAssessment(state, assessment, { now: NOW, ...options })
}

test('记忆去重且有上限', () => {
  let state = fresh()
  state = run(state, { salience: 0.5, memory: { facts: ['住在杭州'] } }).state
  const again = run(state, { salience: 0.5, memory: { facts: ['住在杭州'] } })
  assert.equal(again.state.memory.facts.length, 1)

  for (let i = 0; i < 260; i += 1) {
    state = run(state, { salience: 0.5, memory: { facts: [`事实 ${i}`] } }).state
  }
  assert.ok(state.memory.facts.length <= 200)
})

test('答应的事会被记下来，同一件事不会记两遍', () => {
  let state = fresh()
  state = run(state, { salience: 0.6, commitments: ['把 README 补完'] }).state
  state = run(state, { salience: 0.6, commitments: ['把README补完'] }).state
  assert.equal(state.commitments.length, 1)
  assert.equal(state.commitments[0].status, 'open')
})

test('对方明确说记住的，直接钉进长期层，短层不留两份', () => {
  let state = fresh()
  state = run(state, { salience: 0.5, memory: { facts: ['用户周五要交稿'] } }).state
  assert.equal(state.longMemory.length, 0)

  const next = run(state, { salience: 0.5, rememberNow: ['用户周五要交稿'] }, { seq: 7 })
  assert.equal(next.state.longMemory.length, 1)
  assert.equal(next.state.longMemory[0].text, '用户周五要交稿')
  assert.equal(next.state.longMemory[0].pinned, true)
  assert.equal(next.state.longMemory[0].ref.seq, 7)
  // 升上去就不再留在短层，否则同一件事占两个名额。
  assert.equal(next.state.memory.facts.length, 0)
  assert.ok(next.changes.some((change) => change.kind === 'memory:long' && change.op === 'pinned'))
})

test('做到之后变成 done', () => {
  let state = fresh()
  state = run(state, { salience: 0.6, commitments: ['跑一遍全量测试'] }).state
  state = run(state, { salience: 0.6, commitmentsDone: ['跑一遍全量测试'] }).state
  assert.equal(state.commitments[0].status, 'done')
})

test('答应太久没做，会标成 lapsed，而不是一直挂着', () => {
  let state = fresh()
  state = run(state, { salience: 0.6, commitments: ['回头补一份说明'] }).state
  for (let i = 0; i < 13; i += 1) state = run(state, { salience: 0.6 }).state
  assert.equal(state.commitments[0].status, 'lapsed')
})

test('不修改传入的状态对象', () => {
  const state = fresh()
  const snapshot = JSON.stringify(state)
  run(state, { salience: 0.9, memory: { facts: ['甲'] }, commitments: ['乙'] })
  assert.equal(JSON.stringify(state), snapshot)
})

test('空评估不产生任何变化', () => {
  const { changes } = run(fresh(), null)
  assert.deepEqual(changes, [])
})

test('评估写入带来源指针：session 是这一轮序号，seq 指回那句原话', () => {
  const base = fresh()
  const next = applyAssessment(base, { salience: 0.7, memory: { facts: ['用户在 Windows 上用 Node 24'] } }, {
    now: NOW,
    turn: 7,
    seq: 4321,
  })
  const entry = next.state.memory.facts.at(-1)
  assert.deepEqual(entry.ref, { session: next.state.sessionOrdinal, turn: 7, seq: 4321 })
})

test('拿不到 seq 就不写来源：null 比一个凑数的指针诚实', () => {
  const next = applyAssessment(fresh(), { salience: 0.7, memory: { facts: ['用户养了一只猫'] } }, {
    now: NOW,
    turn: 7,
  })
  assert.equal(next.state.memory.facts.at(-1).ref, null)
})

test('旧 state 的 relationship.commitments 迁到顶层，字符串也能读', () => {
  const state = normalizeState(
    {
      relationship: { commitments: ['我会记得这件事', { text: '跑测试', status: 'done', session: 3 }] },
    },
    CONFIG,
    NOW,
  )
  assert.equal(state.commitments[0].status, 'open')
  assert.equal(state.commitments[1].status, 'done')
  assert.equal(state.relationship, undefined, '旧的关系块不该留在状态里')
})
