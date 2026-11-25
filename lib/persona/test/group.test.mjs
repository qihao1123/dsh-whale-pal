import assert from 'node:assert/strict'
import test from 'node:test'
import { sep } from 'node:path'

import {
  checkGroupSessions,
  findGroupRecord,
  groupDirOf,
  groupMessageOf,
  groupSceneOf,
  groupSpeakerScene,
  normalizeIncomingGroup,
  upsertGroupRecord,
} from '../lib/group.js'
import { createScenes, groupScene, parentScene, sceneOf } from '../lib/scene.js'
import { createInitialState, normalizeState } from '../lib/state/schema.js'
import { applyAssessment } from '../lib/updater.js'
import { selectMemory } from '../lib/memory.js'
import { DEFAULTS, normalize } from '../lib/config.js'

const config = normalize(DEFAULTS)
const NOW = 1_760_000_000_000

function incoming(extra = {}) {
  return {
    platform: 'qq',
    groupId: '778899',
    groupName: '鲸鲸交流群',
    speakerId: '10086',
    speakerName: '张三',
    text: '这个配色我觉得挺好',
    ...extra,
  }
}

test('入口三样缺一不可：群、说话人、内容', () => {
  assert.deepEqual(normalizeIncomingGroup({ text: '你好' }), { ok: false, error: 'missing-group' })
  assert.deepEqual(normalizeIncomingGroup({ platform: 'qq', groupId: '1', text: '你好' }), { ok: false, error: 'missing-speaker' })
  assert.deepEqual(normalizeIncomingGroup({ platform: 'qq', groupId: '1', speaker: '张三' }), { ok: false, error: 'empty-text' })
  const ok = normalizeIncomingGroup(incoming())
  assert.equal(ok.ok, true)
  assert.equal(ok.groupId, '778899')
  assert.equal(ok.speakerName, '张三')
})

test('造出来的消息：说话人只挂在来源里，事件那一层一个多余字段都没有', () => {
  const message = groupMessageOf(normalizeIncomingGroup(incoming()))
  assert.deepEqual(Object.keys(message).sort(), ['content', 'id', 'role', 'source'])
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].text, '这个配色我觉得挺好')
  // 来源必须是 user：换成插件来源会被当成插件通知，模型不把它当对话。
  assert.equal(message.source.kind, 'user')
  assert.equal(message.source.group.id, '778899')
  assert.equal(message.source.group.scene, groupScene('qq', '778899'))
  assert.equal(message.source.speaker.name, '张三')
})

test('群记录：第一次建，第二次复用并记住新来的人', () => {
  const scenes = createScenes()
  const first = upsertGroupRecord(scenes, normalizeIncomingGroup(incoming()), NOW)
  assert.equal(first.created, true)
  assert.equal(first.group.id, groupScene('qq', '778899'))
  assert.deepEqual(first.group.members.map((item) => item.name), ['张三'])
  assert.equal(first.group.sessionId, '')
  const second = upsertGroupRecord(scenes, normalizeIncomingGroup(incoming({ speakerId: '10010', speakerName: '李四' })), NOW)
  assert.equal(second.created, false)
  assert.equal(second.group, first.group)
  assert.deepEqual(second.group.members.map((item) => item.name), ['张三', '李四'])
  assert.equal(findGroupRecord(scenes, 'qq', '778899'), first.group)
  // 群号不同就是另一个群，不合并。
  assert.equal(findGroupRecord(scenes, 'qq', '999'), null)
})

test('两个人在同一个群各成一个池子，谁也不串到谁那儿', () => {
  const zhangsan = groupSpeakerScene({ platform: 'qq', groupId: '1', id: groupScene('qq', '1') }, '10086')
  const lisi = groupSpeakerScene({ platform: 'qq', groupId: '1', id: groupScene('qq', '1') }, '10010')
  assert.notEqual(zhangsan, lisi)
  assert.equal(parentScene(zhangsan), groupScene('qq', '1'))
  assert.equal(parentScene(lisi), groupScene('qq', '1'))

  const state = createInitialState(config, NOW)
  const first = applyAssessment(state, { memory: { facts: ['张三说他喜欢深色'] } }, {
    now: NOW,
    turn: 1,
    scene: zhangsan,
  })
  const second = applyAssessment(first.state, { memory: { facts: ['李四说他喜欢亮一点'] } }, {
    now: NOW,
    turn: 2,
    scene: lisi,
  })
  const facts = second.state.memory.facts
  assert.equal(facts.length, 2)
  assert.deepEqual(facts.map((item) => sceneOf(item)), [zhangsan, lisi])
  // 在张三的池子里，看不到李四那条。
  const zhangPools = selectMemory(second.state.memory, { session: 2, limit: 4, scene: zhangsan })
  assert.deepEqual(zhangPools.map((item) => item.text), ['张三说他喜欢深色'])
})

test('同一个群的两个人说了措辞很像的话，也不互相顶掉', () => {
  const group = groupScene('qq', '1')
  const zhangsan = groupSpeakerScene({ id: group }, '10086')
  const lisi = groupSpeakerScene({ id: group }, '10010')
  const state = createInitialState(config, NOW)
  const first = applyAssessment(state, { memory: { facts: ['这个群公告太长了'] } }, { now: NOW, turn: 1, scene: zhangsan })
  const second = applyAssessment(first.state, { memory: { facts: ['这个群公告太长了吧'] } }, { now: NOW, turn: 2, scene: lisi })
  assert.equal(second.state.memory.facts.length, 2)
})

test('重启之后群记录还在：会话编号、成员、群名都保留', () => {
  const scenes = createScenes()
  const record = upsertGroupRecord(scenes, normalizeIncomingGroup(incoming()), NOW).group
  record.sessionId = 'session-group-1'
  const state = createInitialState(config, NOW)
  state.scenes = scenes
  const reloaded = normalizeState(JSON.parse(JSON.stringify(state)), config, NOW)
  const group = reloaded.scenes.groups[0]
  assert.equal(group.id, groupScene('qq', '778899'))
  assert.equal(group.sessionId, 'session-group-1')
  assert.equal(group.name, '鲸鲸交流群')
  assert.deepEqual(group.members.map((item) => item.name), ['张三'])
})

test('自检：会话编号认不出来就标出来，不是静默降级', () => {
  const rows = checkGroupSessions(
    [
      { id: 'group:qq:1', sessionId: 'session-a' },
      { id: 'group:qq:2', sessionId: 'session-b' },
      { id: 'group:qq:3', sessionId: '' },
    ],
    ['session-a'],
  )
  assert.deepEqual(rows, [
    { id: 'group:qq:1', sessionId: 'session-a', ok: true, reason: '' },
    { id: 'group:qq:2', sessionId: 'session-b', ok: false, reason: 'missing' },
    { id: 'group:qq:3', sessionId: '', ok: false, reason: 'no-session' },
  ])
})

test('所有群共用一个空目录，不每群建目录', () => {
  assert.equal(groupDirOf({ root: `C:${sep}data${sep}whale` }), `C:${sep}data${sep}whale${sep}groups`)
  assert.equal(groupDirOf({}), '')
  assert.equal(groupSceneOf('qq', '778899'), groupScene('qq', '778899'))
})
