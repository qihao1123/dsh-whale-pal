import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCENE_OWNER,
  SCENE_WORK_GENERAL,
  createScenes,
  groupByScene,
  groupScene,
  normalizeSceneId,
  normalizeScenes,
  parentScene,
  projectScene,
  sceneChain,
  sceneOf,
  speakerScene,
  trimToPoolCaps,
} from '../lib/scene.js'
import { addMemory, pinLong, promoteMemory, selectMemory } from '../lib/memory.js'
import { CAPS, createInitialState, normalizeState } from '../lib/state/schema.js'
import { applyAssessment } from '../lib/updater.js'
import { DEFAULTS, normalize } from '../lib/config.js'

const config = normalize(DEFAULTS)
const NOW = 1_760_000_000_000

/** 一个 v6 形状的老状态：没有 scenes，条目上没有 scene。 */
function legacyState() {
  const entry = (id, text, extra = {}) => ({
    id,
    idIssuedAt: NOW - 1000,
    text,
    at: NOW - 5000,
    session: 3,
    lastSeenAt: NOW - 5000,
    lastSeenSession: 3,
    salience: 0.6,
    hits: 2,
    resolved: false,
    promoted: false,
    promotedAt: 0,
    ref: { session: 3, turn: 2, seq: 41 },
    evictedAt: 0,
    evictedReason: '',
    ...extra,
  })
  return {
    stateVersion: 6,
    createdAt: NOW - 90_000,
    updatedAt: NOW - 1000,
    revision: 7,
    sessionOrdinal: 12,
    selfName: { current: '泡泡', history: [{ name: '泡泡', from: 0, to: null, trigger: 'initial' }] },
    titleName: { current: '老大', history: [] },
    memory: {
      facts: [
        entry('M-001', '用户在写人格插件', { salience: 0.72 }),
        entry('M-002', '用户住在杭州'),
        entry('M-003', '项目用 Node 24 跑测试', { salience: 0.5 }),
      ],
      preferences: [entry('M-004', '用户喜欢深色主题', { salience: 0.8 })],
      events: [entry('M-005', '今天把人格卡清了一遍', { hits: 1 })],
      openTopics: [entry('M-006', '群聊记忆怎么分层还没定', { hits: 1 })],
    },
    longMemory: [
      {
        id: 'M-007',
        idIssuedAt: NOW - 2000,
        text: '不接受被叫主人',
        kind: 'facts',
        at: NOW - 6000,
        session: 2,
        lastSeenAt: NOW - 6000,
        lastSeenSession: 2,
        hits: 3,
        pinned: true,
        ref: null,
        promotedAt: NOW - 6000,
        evictedAt: 0,
        evictedReason: '',
      },
    ],
    memoryTombstones: [],
    memorySeq: 7,
    commitments: [{ text: '把清单写完', at: NOW - 3000, session: 9, status: 'open', doneAt: 0, doneSession: 0 }],
    audit: { lastSeq: 88 },
  }
}

test('没有场景字段的条目一律算主人层', () => {
  assert.equal(sceneOf({}), SCENE_OWNER)
  assert.equal(sceneOf({ scene: '   ' }), SCENE_OWNER)
  assert.equal(sceneOf({ scene: 'project:alpha' }), 'project:alpha')
  // 脏值不能吞掉一条记忆：不认识也照原样当成一个池子。
  assert.equal(normalizeSceneId('  group:qq:42  '), 'group:qq:42')
  assert.equal(normalizeSceneId(undefined), SCENE_OWNER)
})

test('老状态迁移：编号一个不变、条数一条不少、全部进主人层', () => {
  const old = legacyState()
  const before = [
    ...old.memory.facts, ...old.memory.preferences, ...old.memory.events, ...old.memory.openTopics, ...old.longMemory,
  ]
  const migrated = normalizeState(old, config, NOW)
  const after = [
    ...migrated.memory.facts, ...migrated.memory.preferences, ...migrated.memory.events, ...migrated.memory.openTopics,
    ...migrated.longMemory,
  ]
  assert.equal(after.length, before.length)
  assert.deepEqual(after.map((item) => item.id), before.map((item) => item.id))
  assert.ok(after.every((item) => item.scene === SCENE_OWNER), '迁移不许猜归属，老数据全进主人层')
  // 正文逐字不变：迁移只能加字段，不能改内容。
  assert.deepEqual(after.map((item) => item.text), before.map((item) => item.text))
})

test('迁移不动行为：同一批老数据，迁移前后召回逐字一致', () => {
  const old = legacyState()
  const migrated = normalizeState(old, config, NOW)
  for (const query of ['人格插件', 'Node 版本', '', '群聊分层']) {
    const before = selectTexts(old.memory, query, 12)
    const after = selectTexts(migrated.memory, query, 12)
    assert.deepEqual(after, before, `query=${query} 的召回结果被迁移改动了`)
  }
})

/** 召回前/后各跑一次；只取文本，比较要逐字。 */
function selectFrom(memory, { query, session }) {
  return selectMemory(memory, { session, limit: 6, query })
}

function selectTexts(memory, query, session) {
  return selectFrom(memory, { query, session }).map((item) => `${item.kind}\u0000${item.text}`)
}

test('场景树：老状态补出一棵只有主人根节点的树', () => {
  const state = normalizeState(legacyState(), config, NOW)
  assert.equal(state.scenes.root.id, SCENE_OWNER)
  assert.equal(state.scenes.root.label, '主人')
  assert.deepEqual(state.scenes.projects, [])
  assert.deepEqual(state.scenes.groups, [])
  assert.deepEqual(state.scenes.external, [])
  // 全新的一局也一样是一棵空树。
  assert.deepEqual(createInitialState(config, NOW).scenes, createScenes())
})

test('场景树归一：缺名字的按项目名生成 id，重复 id 只留一个', () => {
  const scenes = normalizeScenes({
    projects: [{ name: '鲸鲸' }, { id: 'project:鲸鲸' }, { name: '' }],
    groups: [
      { platform: 'qq', groupId: '123456' },
      { id: 'group:qq:123456', platform: 'qq', groupId: '123456' },
      { platform: 'qq', groupId: '' },
    ],
    external: [{ id: 'external:1', type: 'demo', label: '外来的' }, { id: '' }],
  })
  assert.deepEqual(scenes.projects.map((item) => item.id), ['project:鲸鲸'])
  assert.deepEqual(scenes.groups.map((item) => item.id), ['group:qq:123456'])
  assert.equal(scenes.groups[0].sessionId, '')
  assert.deepEqual(scenes.external.map((item) => item.id), ['external:1'])
})

test('父子链：项目上一级是项目通用，说话人上一级是这个群', () => {
  assert.equal(parentScene(SCENE_OWNER), null)
  assert.equal(parentScene(projectScene('alpha')), SCENE_WORK_GENERAL)
  assert.equal(parentScene(SCENE_WORK_GENERAL), SCENE_OWNER)
  const group = groupScene('qq', '7788')
  assert.equal(group, 'group:qq:7788')
  assert.equal(parentScene(group), 'group:qq')
  assert.equal(parentScene('group:qq'), SCENE_OWNER)
  const who = speakerScene(group, '张三')
  assert.equal(parentScene(who), group)
  assert.deepEqual(sceneChain(who), [who, group, 'group:qq', SCENE_OWNER])
  assert.deepEqual(sceneChain(projectScene('alpha')), ['project:alpha', SCENE_WORK_GENERAL, SCENE_OWNER])
  // 外部注册的场景没有注册就不认父节点，退回主人层（不写死任何一类）。
  assert.equal(parentScene('external:1'), SCENE_OWNER)
})

test('同一个群里两个人各成一个池子，不串到一块', () => {
  const group = groupScene('qq', '7788')
  const a = speakerScene(group, '张三')
  const b = speakerScene(group, '李四')
  assert.notEqual(a, b)
  const list = [
    { text: '张三说这版配色好看', scene: a },
    { text: '李四说他喜欢暗一点', scene: b },
    { text: '张三又说了一遍配色', scene: a },
  ]
  const pools = groupByScene(list)
  assert.equal(pools.get(a).length, 2)
  assert.equal(pools.get(b).length, 1)
})

test('名额按池子算：一个池子满了不挤掉别的池子', () => {
  const list = []
  const owner = SCENE_OWNER
  const proj = projectScene('alpha')
  addMemory(list, '主人层的甲', { kind: 'facts', cap: 2, scene: owner, session: 1 })
  addMemory(list, '主人层的乙', { kind: 'facts', cap: 2, scene: owner, session: 1 })
  addMemory(list, '项目里的丙', { kind: 'facts', cap: 2, scene: proj, session: 1 })
  const result = addMemory(list, '主人层的丁', { kind: 'facts', cap: 2, scene: owner, session: 1 })
  assert.equal(result.status, 'added')
  assert.equal(list.filter((item) => sceneOf(item) === owner).length, 2)
  assert.equal(list.filter((item) => sceneOf(item) === proj).length, 1)
  assert.ok(list.some((item) => item.text === '项目里的丙'), '项目那条被主人层挤掉了')
  // 被顶掉的只能是主人层的那一条，不是项目层。
  assert.ok(result.evicted === '主人层的甲' || result.evicted === '主人层的乙', `顶掉的是 ${result.evicted}`)
})

test('老数据只有一个池子时，按池截断和整条截断逐条一致', () => {
  const list = []
  for (let i = 0; i < 12; i += 1) list.push({ text: `第 ${i} 条`, at: NOW + i })
  assert.deepEqual(trimToPoolCaps(list, 5), list.slice(-5))
  assert.deepEqual(trimToPoolCaps(list, 0), [])
  // 两个池子各留 5 条：这一条是分层的意义所在。
  const mixed = [
    ...list.map((item) => ({ ...item, scene: SCENE_OWNER })),
    ...list.map((item) => ({ ...item, scene: projectScene('alpha') })),
  ]
  const kept = trimToPoolCaps(mixed, 5)
  assert.equal(kept.length, 10)
  assert.equal(kept.filter((item) => sceneOf(item) === SCENE_OWNER).length, 5)
  assert.equal(kept.filter((item) => sceneOf(item) === projectScene('alpha')).length, 5)
})

test('写进状态时带上当前场景', () => {
  const state = createInitialState(config, NOW)
  const proj = projectScene('alpha')
  const { state: next } = applyAssessment(
    state,
    { memory: { facts: ['这个项目用 tabs'], preferences: [] } },
    { now: NOW, turn: 1, seq: 10, scene: proj },
  )
  assert.equal(next.memory.facts.length, 1)
  assert.equal(next.memory.facts[0].scene, proj)
  // 不给场景时仍然落主人层：P0 不改行为。
  const { state: plain } = applyAssessment(state, { memory: { facts: ['用户喜欢猫'] } }, { now: NOW, turn: 1 })
  assert.equal(plain.memory.facts[0].scene, SCENE_OWNER)
})

test('升进长期层时归属跟着条目走', () => {
  const state = createInitialState(config, NOW)
  const proj = projectScene('alpha')
  state.memory.facts.push({
    text: '这个项目的测试要跑全量',
    scene: proj,
    at: NOW,
    session: 1,
    lastSeenAt: NOW,
    lastSeenSession: 1,
    hits: 3,
    salience: 0.6,
    ref: null,
  })
  promoteMemory(state, { session: 2, now: NOW, cap: CAPS.longMemory })
  assert.equal(state.longMemory.length, 1)
  assert.equal(state.longMemory[0].scene, proj)
})

test('长期层的名额也按池子算：钉一条不占别的池子的名额', () => {
  const long = []
  const proj = projectScene('alpha')
  assert.ok(pinLong(long, '项目里的规矩', { cap: 1, scene: proj, session: 1 }))
  assert.ok(pinLong(long, '主人层的底线', { cap: 1, scene: SCENE_OWNER, session: 1 }))
  assert.equal(long.length, 2)
  assert.deepEqual(long.map((item) => sceneOf(item)).sort(), [SCENE_OWNER, proj].sort())
})
