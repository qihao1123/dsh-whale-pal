import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COUNT_WEIGHT,
  GENERAL_CAP,
  addMemory,
  fadeMemory,
  noteAppearance,
  reevaluateElevations,
  scoreEntry,
} from '../lib/memory.js'
import { findConflictingRule, readHardcodedRules, rulesFromText } from '../lib/hardrules.js'
import { createInitialState } from '../lib/state/schema.js'
import { applyAssessment } from '../lib/updater.js'
import { projectScene, SCENE_OWNER, SCENE_WORK_GENERAL } from '../lib/scene.js'
import { DEFAULTS, normalize } from '../lib/config.js'

const config = normalize(DEFAULTS)
const NOW = 1_760_000_000_000

const alpha = { dir: 'D:/work/alpha', name: 'alpha' }
const beta = { dir: 'D:/work/beta', name: 'beta' }

function baseEntry(text, scene, extra = {}) {
  return {
    id: '',
    idIssuedAt: NOW,
    scene,
    originScene: scene,
    elevatedBy: '',
    weight: 1,
    seenIn: [{ id: scene, count: 1, lastSession: 1 }],
    text,
    at: NOW,
    session: 1,
    lastSeenAt: NOW,
    lastSeenSession: 1,
    salience: 0.6,
    hits: 1,
    resolved: false,
    promoted: false,
    promotedAt: 0,
    ref: null,
    evictedAt: 0,
    evictedReason: '',
    ...extra,
  }
}

test('规则一：明确说过的升到上一层（项目 → 项目通用），不是无脑进主人层', () => {
  const state = createInitialState(config, NOW)
  const { state: next, changes } = applyAssessment(state, { rememberNow: ['以后都用 pnpm'] }, {
    now: NOW,
    turn: 1,
    project: alpha,
  })
  assert.equal(next.longMemory.length, 1)
  assert.equal(next.longMemory[0].scene, SCENE_WORK_GENERAL)
  assert.equal(next.longMemory[0].elevatedBy, 'explicit')
  assert.equal(next.longMemory[0].originScene, projectScene('alpha'))
  assert.ok(changes.some((item) => item.op === 'pinned' && item.why.includes('上一层')))
})

test('规则一：这类不衰减，容量满了也不拿它顶位置', () => {
  const list = [
    baseEntry('以后都用 pnpm', SCENE_WORK_GENERAL, { elevatedBy: 'explicit', salience: 0.9 }),
    baseEntry('普通的一条', SCENE_WORK_GENERAL, { salience: 0.5 }),
  ]
  fadeMemory(list, { session: 10, rate: 0.5, cap: 100 })
  assert.equal(list[0].salience, 0.9, '明确说过的那条不该被衰减')
  assert.ok(list[1].salience < 0.5, '普通记忆照常衰减')
  // 容量顶满时，被淘汰的也只能是普通那条。
  addMemory(list, '又一条新的', { kind: 'facts', cap: 1, scene: SCENE_WORK_GENERAL, session: 10 })
  assert.ok(list.some((item) => item.text === '以后都用 pnpm'))
})

test('规则二：偏好进主人层，事实留在场景层', () => {
  const state = createInitialState(config, NOW)
  const first = applyAssessment(state, { memory: { preferences: ['用户喜欢深色主题'] } }, { now: NOW, turn: 1, project: alpha })
  assert.equal(first.state.memory.preferences[0].scene, SCENE_OWNER)
  const second = applyAssessment(first.state, { memory: { facts: ['这个项目用 tabs'] } }, { now: NOW, turn: 2, project: alpha })
  assert.equal(second.state.memory.facts[0].scene, projectScene('alpha'))
})

test('规则二：偏要点名了项目，就留在项目层', () => {
  const state = createInitialState(config, NOW)
  const applied = applyAssessment(state, { memory: { preferences: ['这个项目喜欢用 tabs'] } }, {
    now: NOW,
    turn: 1,
    project: alpha,
  })
  assert.equal(applied.state.memory.preferences[0].scene, projectScene('alpha'))
  // 点名路径也算。
  const byDir = applyAssessment(state, { memory: { preferences: ['D:/work/alpha 里用 tabs 更顺'] } }, {
    now: NOW,
    turn: 1,
    project: alpha,
  })
  assert.equal(byDir.state.memory.preferences[0].scene, projectScene('alpha'))
})

test('规则三：一字不差的同一条在两个项目出现，升到项目通用层，权重打七折', () => {
  const state = createInitialState(config, NOW)
  const first = applyAssessment(state, { memory: { facts: ['这个模块要重构'] } }, { now: NOW, turn: 1, project: alpha })
  const second = applyAssessment(first.state, { memory: { facts: ['这个模块要重构'] } }, { now: NOW, turn: 2, project: beta })
  const facts = second.state.memory.facts
  assert.equal(facts.length, 1, '同一件事不该留两份')
  assert.equal(facts[0].scene, SCENE_WORK_GENERAL)
  assert.equal(facts[0].elevatedBy, 'count')
  assert.equal(facts[0].weight, COUNT_WEIGHT)
  assert.deepEqual(facts[0].seenIn.map((item) => item.id).sort(), [projectScene('alpha'), projectScene('beta')].sort())
  assert.ok(second.changes.some((item) => item.op === 'elevated'))
})

test('打七折是看得见的：同层同样新旧的两条，计数上来的排在后面', () => {
  const solid = baseEntry('明确进来的', SCENE_WORK_GENERAL, { weight: 1 })
  const counted = baseEntry('计数上来的', SCENE_WORK_GENERAL, { weight: COUNT_WEIGHT })
  assert.ok(scoreEntry(counted, 1) < scoreEntry(solid, 1))
})

test('降级：别的场景不再提起了，降回出现最多的那个场景，编号不变', () => {
  const state = createInitialState(config, NOW)
  state.memory.facts.push(baseEntry('这个模块要重构', SCENE_WORK_GENERAL, {
    id: 'M-042',
    elevatedBy: 'count',
    weight: COUNT_WEIGHT,
    originScene: projectScene('alpha'),
    seenIn: [
      { id: projectScene('alpha'), count: 3, lastSession: 5 },
      { id: projectScene('beta'), count: 1, lastSession: 5 },
    ],
  }))
  const changes = reevaluateElevations(state, { session: 100, now: NOW, staleSessions: 60 })
  assert.equal(changes.length, 1)
  const entry = state.memory.facts[0]
  assert.equal(entry.scene, projectScene('alpha'))
  assert.equal(entry.id, 'M-042')
  assert.equal(entry.elevatedBy, '')
  assert.equal(entry.weight, 1)
  assert.ok(entry.demotedAt > 0)
})

test('降级：另一个场景最近还在提起，就先不动它', () => {
  const state = createInitialState(config, NOW)
  state.memory.facts.push(baseEntry('这个模块要重构', SCENE_WORK_GENERAL, {
    elevatedBy: 'count',
    weight: COUNT_WEIGHT,
    seenIn: [
      { id: projectScene('alpha'), count: 3, lastSession: 5 },
      { id: projectScene('beta'), count: 1, lastSession: 95 },
    ],
  }))
  const changes = reevaluateElevations(state, { session: 100, now: NOW, staleSessions: 60 })
  assert.deepEqual(changes, [])
  assert.equal(state.memory.facts[0].scene, SCENE_WORK_GENERAL)
})

test('规则四：项目通用层满 50，不静默丢一条，而是提个请求', () => {
  const state = createInitialState(config, NOW)
  for (let i = 0; i < GENERAL_CAP; i += 1) {
    state.memory.facts.push(baseEntry(`通用层第 ${i} 条规则`, SCENE_WORK_GENERAL, { id: `M-${100 + i}` }))
  }
  const first = applyAssessment(state, { memory: { facts: ['新冒出来的通用做法'] } }, { now: NOW, turn: 1, project: alpha })
  const second = applyAssessment(first.state, { memory: { facts: ['新冒出来的通用做法'] } }, { now: NOW, turn: 2, project: beta })
  assert.equal(second.state.sceneRequests.length, 1)
  assert.equal(second.state.sceneRequests[0].scene, SCENE_WORK_GENERAL)
  assert.ok(second.changes.some((item) => item.op === 'requested'))
  // 没人被静默丢掉：那条还在原来的场景里，通用层还是 50 条。
  assert.equal(second.state.memory.facts.filter((item) => item.scene === SCENE_WORK_GENERAL).length, GENERAL_CAP)
  assert.equal(second.state.memory.facts.some((item) => item.text === '新冒出来的通用做法'), true)
})

test('规则五：跟写死规则直接矛盾的记忆，不入库，并留下为什么丢', () => {
  const state = createInitialState(config, NOW)
  const { state: next, changes } = applyAssessment(state, { memory: { facts: ['接受被叫主人'] } }, {
    now: NOW,
    turn: 1,
    rules: ['不接受被叫主人'],
  })
  assert.equal(next.memory.facts.length, 0)
  const blocked = changes.find((item) => item.op === 'blocked')
  assert.ok(blocked)
  assert.ok(blocked.why.includes('不接受被叫主人'))
})

test('规则五：同样的意思（否定词一样）不算冲突，照常记', () => {
  const state = createInitialState(config, NOW)
  const { state: next } = applyAssessment(state, { memory: { facts: ['不接受被叫主人'] } }, {
    now: NOW,
    turn: 1,
    rules: ['不接受被叫主人'],
  })
  assert.equal(next.memory.facts.length, 1)
})

test('写死的规则从 AGENTS.md 里读：只认列表项，不认说明段落', () => {
  const rules = rulesFromText('# 宪法\n\n这是一段说明，不是规则。\n\n- 不许顺着说\n- 不确定就标不确定\n1. 开工前先对齐\n')
  assert.deepEqual(rules, ['不许顺着说', '不确定就标不确定', '开工前先对齐'])
  assert.deepEqual(findConflictingRule('确定就标不确定', ['不确定就标不确定'])?.rule, '不确定就标不确定')
  assert.equal(findConflictingRule('用户喜欢深色主题', ['不确定就标不确定']), null)
  assert.equal(readHardcodedRules({ extraBoundaries: '不接受被叫主人' }).includes('不接受被叫主人'), true)
})

test('计数只认一字不差：措辞像的不是同一件事', () => {
  const list = []
  addMemory(list, '这个模块要重构', { kind: 'facts', scene: projectScene('alpha'), session: 1 })
  addMemory(list, '这个模块要重构了', { kind: 'facts', scene: projectScene('beta'), session: 2 })
  assert.equal(list.length, 2)
  assert.equal(list.every((item) => item.scene.startsWith('project:')), true)
})

test('noteAppearance 记次数与最后一轮，同场景重复只加次数', () => {
  const entry = baseEntry('甲', projectScene('alpha'))
  noteAppearance(entry, projectScene('alpha'), 5, NOW)
  noteAppearance(entry, projectScene('beta'), 7, NOW)
  noteAppearance(entry, projectScene('beta'), 9, NOW)
  const alphaRow = entry.seenIn.find((item) => item.id === projectScene('alpha'))
  const betaRow = entry.seenIn.find((item) => item.id === projectScene('beta'))
  assert.equal(alphaRow.count, 2)
  assert.equal(betaRow.count, 2)
  assert.equal(betaRow.lastSession, 9)
  assert.equal(entry.seenIn[0].count >= entry.seenIn[1].count, true, '按次数排序，降级挑最多的那个场景')
})
