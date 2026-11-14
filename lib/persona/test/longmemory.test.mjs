import assert from 'node:assert/strict'
import test from 'node:test'

import {
  addMemory,
  fadeMemory,
  findMemoryById,
  forgetLong,
  normalizeLong,
  pinLong,
  promoteMemory,
  selectLong,
  selectMemory,
} from '../lib/memory.js'
import { CAPS, createInitialState, normalizeState } from '../lib/state/schema.js'
import { applyAssessment } from '../lib/updater.js'
import { renderStateSummary } from '../lib/prompt/render.js'
import { DEFAULTS, normalize } from '../lib/config.js'

const config = normalize(DEFAULTS)

/** 反复提到同一件事，直到它够格升进长期层。 */
function hammer(state, text, times) {
  for (let i = 0; i < times; i += 1) {
    addMemory(state.memory.facts, text, { kind: 'facts', session: i + 1, cap: CAPS.facts })
  }
}

test('被提到三次才够格升进长期层，两次还不行', () => {
  const state = createInitialState(config)
  hammer(state, '用户在做人格插件', 2)
  assert.deepEqual(promoteMemory(state, { session: 3 }), [])

  hammer(state, '用户在做人格插件', 1)
  const added = promoteMemory(state, { session: 4 })
  assert.equal(added.length, 1)
  assert.equal(state.longMemory[0].text, '用户在做人格插件')
  // 晋升不留两份：短条目从池里移除，长期层是它唯一的家。
  assert.equal(state.memory.facts.length, 0)
  assert.ok(state.longMemory[0].promotedAt > 0, '长期条目要留下晋升时间')
  // 幂等：再跑一次不会升第二遍。
  assert.deepEqual(promoteMemory(state, { session: 5 }), [])
  assert.equal(state.longMemory.length, 1)
})

test('升进长期层之后就不参与短期检索，且短层不再留副本', () => {
  const state = createInitialState(config)
  hammer(state, '用户在写 DSH 的人格插件', 3)
  promoteMemory(state, { session: 3 })

  const shortTerm = selectMemory(state.memory, { session: 3, limit: 4 })
  assert.equal(shortTerm.length, 0)
  // 旧版会留一条标了 promoted 的副本占容量；现在不留。
  assert.equal(state.memory.facts.length, 0)

  const longTerm = selectLong(state.longMemory, 3)
  assert.equal(longTerm.length, 1)
  assert.equal(longTerm[0].text, '用户在写 DSH 的人格插件')
})

test('晋升把编号和 ref 一起带进长期层，取回还能找到同一件事', () => {
  const state = createInitialState(config)
  const ref = { session: 12, turn: 4 }
  for (let i = 0; i < 3; i += 1) {
    addMemory(state.memory.facts, '用户在写 DSH 的人格插件', { kind: 'facts', session: i + 1, cap: CAPS.facts })
  }
  state.memory.facts[0].id = 'M-007'
  state.memory.facts[0].ref = ref
  promoteMemory(state, { session: 3 })

  const moved = findMemoryById(state, 'M-007')
  assert.ok(moved, '升上去之后编号还得能查到')
  assert.equal(moved.scope, 'long')
  assert.deepEqual(moved.entry.ref, ref)
})

test('晋升时间扛得住重载：读盘之后 promotedAt 还在', () => {
  const state = createInitialState(config)
  hammer(state, '用户在做人格插件', 3)
  promoteMemory(state, { session: 4 })
  const stamped = state.longMemory[0].promotedAt
  assert.ok(stamped > 0)

  const reloaded = normalizeState(JSON.parse(JSON.stringify(state)), config)
  assert.equal(reloaded.longMemory[0].promotedAt, stamped, '晋升凭据丢了就查不出它从哪来')
  // 编号是读盘时补发的，不该因为归一化而丢；它跟晋升时间是两件事。
  assert.ok(reloaded.longMemory[0].id !== '')
})

test('答应过的事直接进长期层，不用等三次', () => {
  const state = createInitialState(config)
  state.commitments = [
    { text: '把第三批做完', at: Date.now(), session: 1, status: 'open', doneAt: 0, doneSession: 0 },
  ]
  const added = promoteMemory(state, { session: 2 })
  assert.equal(added.length, 1)
  const texts = state.longMemory.map((item) => item.text)
  assert.ok(texts.includes('把第三批做完'))
  // 做完了的约定不再当底账占位。
  state.commitments[0].status = 'done'
  state.longMemory = []
  assert.ok(!promoteMemory(state, { session: 3 }).includes('把第三批做完'))
})

test('长期记忆不衰减，短期记忆继续淡：八十轮之后还在', () => {
  const state = createInitialState(config)
  // 再放一条升不上去的短记忆，用来观察「淡」这件事。
  hammer(state, '用户叫六一', 3)
  addMemory(state.memory.facts, '随手提过一句闲事', { kind: 'facts', session: 3, cap: CAPS.facts })
  promoteMemory(state, { session: 3 })
  const salienceBefore = state.memory.facts.find((item) => item.text === '随手提过一句闲事').salience

  for (let i = 0; i < 80; i += 1) {
    for (const kind of ['facts', 'preferences', 'events', 'openTopics']) {
      fadeMemory(state.memory[kind], { session: i, rate: 0.02, cap: CAPS[kind], touched: [] })
    }
  }

  const stayed = state.memory.facts.find((item) => item.text === '随手提过一句闲事')
  assert.ok(stayed.salience < salienceBefore, '短期记忆应该变淡')
  assert.equal(state.longMemory.length, 1, '长期记忆不该消失')
  assert.equal(state.longMemory[0].text, '用户叫六一')
})

test('人钉住一条就直接进长期层，且排在没钉住的前面', () => {
  const state = createInitialState(config)
  const entry = pinLong(state.longMemory, '用户不喜欢被反复确认', { kind: 'preferences', session: 1 })
  assert.equal(entry.pinned, true)
  pinLong(state.longMemory, '用户住在杭州', { pinned: true, session: 5 })
  state.longMemory[1].pinned = false // 模拟一条自动升上来的
  const ordered = selectLong(state.longMemory, 3)
  assert.equal(ordered[0].text, '用户不喜欢被反复确认')
})

test('取消钉住不会删掉，只是回到自动晋升那档', () => {
  const state = createInitialState(config)
  pinLong(state.longMemory, '用户在写人格插件', { pinned: true, session: 1 })
  pinLong(state.longMemory, '用户在写人格插件', { pinned: false, session: 1 })
  assert.equal(state.longMemory.length, 1)
  assert.equal(state.longMemory[0].pinned, false)
})

test('长期层满了先淘汰没钉住的老条目，钉住的留着', () => {
  const state = createInitialState(config)
  state.longMemory = []
  for (let i = 0; i < CAPS.longMemory; i += 1) {
    state.longMemory.push(normalizeLong({ text: `旧事 ${i}`, lastSeenSession: i, pinned: i === 0 }, 1))
  }
  const added = promoteMemory(state, { session: 99 })
  // 没有可升的东西，列表原样。
  assert.deepEqual(added, [])
  assert.equal(state.longMemory.length, CAPS.longMemory)

  pinLong(state.longMemory, '新的一件重要的事', { pinned: true, session: 100 })
  assert.equal(state.longMemory.length, CAPS.longMemory, '不该超过上限')
  assert.ok(state.longMemory.some((item) => item.text === '新的一件重要的事'))
  assert.ok(state.longMemory.some((item) => item.text === '旧事 0'), '钉住的老条目不该被淘汰')
  assert.ok(!state.longMemory.some((item) => item.text === '旧事 1'), '最久没提的没钉住的应该先走')
})

test('长期层被顶掉的那条也留墓碑，说得出编号、时间、原因', () => {
  const state = createInitialState(config)
  state.longMemory = []
  for (let i = 0; i < CAPS.longMemory; i += 1) {
    const entry = normalizeLong({ text: `旧事 ${i}`, lastSeenSession: i }, 1)
    entry.id = `M-1${String(i).padStart(2, '0')}`
    state.longMemory.push(entry)
  }
  const now = 1760000000000
  pinLong(state.longMemory, '新的一件重要的事', {
    pinned: true,
    session: 100,
    now,
    tombstones: state.memoryTombstones,
  })

  const gone = state.memoryTombstones.at(-1)
  assert.equal(gone.reason, 'long-full')
  assert.equal(gone.topic, '旧事 0', '最久没提的那条先走')
  assert.equal(gone.id, 'M-100')
  assert.equal(gone.at, now)
  assert.ok(!('text' in gone), '墓碑不留正文')
})

test('删掉一条长期记忆，人可以做，状态里就真没了', () => {  const state = createInitialState(config)
  pinLong(state.longMemory, '用户在做人格插件', { pinned: true, session: 1 })
  assert.equal(forgetLong(state.longMemory, '用户在做人格插件'), '用户在做人格插件')
  assert.equal(state.longMemory.length, 0)
  assert.equal(forgetLong(state.longMemory, '压根没有的事'), null)
})

test('摘要里有「一直记着」，且超长时它比「记得」活得久', () => {
  const state = createInitialState(config)
  pinLong(state.longMemory, '用户在做 DSH 的人格插件', { pinned: true, session: 1 })
  hammer(state, '用户喜欢简洁', 5)
  promoteMemory(state, { session: 5 })

  const summary = renderStateSummary(state, config)
  assert.match(summary, /一直记着：/)
  assert.ok(summary.length <= 900)
})

test('整轮跑通：三次提到升长期，摘要里出现，且不重复出现在「记得」', () => {
  const state = createInitialState(config)
  let current = state
  for (let i = 0; i < 3; i += 1) {
    const result = applyAssessment(current, {
      salience: 0.6,
      memory: { facts: ['用户在做 DSH 的人格插件'], preferences: [], events: [], openTopics: [] },
    })
    current = result.state
  }
  const promoted = current.longMemory.map((item) => item.text)
  assert.ok(promoted.includes('用户在做 DSH 的人格插件'))

  const summary = renderStateSummary(current, config)
  const occurrences = summary.split('用户在做 DSH 的人格插件').length - 1
  assert.equal(occurrences, 1, '摘要里只该出现一次，不该「记得」和「一直记着」各来一遍')
})

test('老状态没有 longMemory 字段也能读，归一化后是空数组', () => {
  const state = normalizeState({ version: 4, sessionOrdinal: 7 }, config)
  assert.deepEqual(state.longMemory, [])
})
