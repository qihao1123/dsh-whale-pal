import assert from 'node:assert/strict'
import test from 'node:test'

import { findMemoryById, selectLong, selectMemory } from '../lib/memory.js'
import { renderStateSummary } from '../lib/prompt/render.js'
import { createInitialState } from '../lib/state/schema.js'
import { groupScene, projectScene, speakerScene, SCENE_OWNER } from '../lib/scene.js'
import { DEFAULTS, normalize } from '../lib/config.js'

const config = normalize(DEFAULTS)
const NOW = 1_760_000_000_000

function entry(text, scene, extra = {}) {
  return {
    id: extra.id ?? '',
    idIssuedAt: NOW,
    scene,
    text,
    at: NOW,
    session: 1,
    lastSeenAt: NOW,
    lastSeenSession: 1,
    salience: 0.7,
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

function memoryOf(facts = [], preferences = []) {
  return { facts, preferences, events: [], openTopics: [] }
}

test('A 项目的规则在 B 项目下不出现', () => {
  const memory = memoryOf([entry('这个模块用 tabs', projectScene('alpha'))])
  const inB = selectMemory(memory, { session: 1, limit: 4, scene: projectScene('beta') })
  assert.deepEqual(inB.map((item) => item.text), [])
})

test('B 项目里明确提起来，才轮得到 A 项目的那条', () => {
  const memory = memoryOf([entry('这个模块用 tabs', projectScene('alpha'))])
  const asked = selectMemory(memory, { session: 1, limit: 4, scene: projectScene('beta'), query: 'tabs 缩进' })
  assert.deepEqual(asked.map((item) => item.text), ['这个模块用 tabs'])
  // 这条是有来源的：界面/提示词要能说清它从哪来。
  assert.equal(asked[0].scene, projectScene('alpha'))
})

test('主人层的偏好在任何场景下都出现', () => {
  const memory = memoryOf(
    [entry('这个模块用 tabs', projectScene('alpha'))],
    [entry('用户喜欢深色主题', SCENE_OWNER, { salience: 0.75 })],
  )
  for (const scene of [SCENE_OWNER, projectScene('alpha'), groupScene('qq', '7788')]) {
    const picked = selectMemory(memory, { session: 1, limit: 4, scene })
    assert.ok(picked.some((item) => item.text === '用户喜欢深色主题'), `${scene} 里主人层的偏好不见了`)
  }
})

test('越近的越先想起来：同样重要时，本项目的排在主人层前面', () => {
  const memory = memoryOf([
    entry('这个项目用 tabs', projectScene('alpha')),
    entry('用户喜欢深色主题', SCENE_OWNER),
  ])
  const picked = selectMemory(memory, { session: 1, limit: 1, scene: projectScene('alpha') })
  assert.equal(picked[0].text, '这个项目用 tabs')
})

test('群聊里认识的人，私聊里不主动出现；明确提到名字才查得到', () => {
  const group = groupScene('qq', '7788')
  const zhangsan = speakerScene(group, '张三')
  const memory = memoryOf([entry('张三在群里说不喜欢被叫哥', zhangsan)])
  const quiet = selectMemory(memory, { session: 1, limit: 4, scene: SCENE_OWNER })
  assert.deepEqual(quiet.map((item) => item.text), [], '私聊里不该主动冒出群聊的事')
  const asked = selectMemory(memory, { session: 1, limit: 4, scene: SCENE_OWNER, query: '张三 怎么称呼' })
  assert.deepEqual(asked.map((item) => item.text), ['张三在群里说不喜欢被叫哥'])
})

test('不主动出现不等于查不到：取回工具照样能按编号取', () => {
  const group = groupScene('qq', '7788')
  const zhangsan = speakerScene(group, '张三')
  const state = createInitialState(config, NOW)
  state.memory.facts.push(entry('张三在群里说不喜欢被叫哥', zhangsan, { id: 'M-088' }))
  const found = findMemoryById(state, 'M-088')
  assert.equal(found?.entry.text, '张三在群里说不喜欢被叫哥')
  // 也不该在私聊的目录里露出来。
  const summary = renderStateSummary(state, config, { scene: SCENE_OWNER })
  assert.equal(summary.includes('M-088'), false)
})

test('一直在的长期记忆也只取这条链上的', () => {
  const long = [
    { ...entry('项目乙的规矩', projectScene('beta'), { id: 'M-100' }), kind: 'facts', pinned: true, lastSeenSession: 2 },
    { ...entry('用户的底线', SCENE_OWNER, { id: 'M-101' }), kind: 'facts', pinned: true, lastSeenSession: 1 },
  ]
  const picked = selectLong(long, 3, { scene: projectScene('alpha') })
  assert.deepEqual(picked.map((item) => item.id), ['M-101'])
})

test('提示词里能看出来源：本项目的不标？不，标项目名；主人层的才不标', () => {
  const state = createInitialState(config, NOW)
  state.memory.facts.push(entry('这个项目用 tabs', projectScene('alpha')))
  state.memory.preferences.push(entry('用户喜欢深色主题', SCENE_OWNER))
  const summary = renderStateSummary(state, config, { scene: projectScene('alpha') })
  assert.ok(summary.includes('〔alpha〕这个项目用 tabs'), summary)
  assert.ok(summary.includes('用户喜欢深色主题'), summary)
  assert.equal(summary.includes('〔主人〕'), false, '主人层是默认，不该每行都挂一个人人都有的标签')
})

test('项目的名字改了，提示词里的标签跟着改（认的是场景树里的名字，不是 id）', () => {
  const state = createInitialState(config, NOW)
  state.scenes.projects.push({ id: projectScene('alpha'), name: '鲸鲸插件', dirs: [], editable: true })
  state.memory.facts.push(entry('这个项目用 tabs', projectScene('alpha')))
  const summary = renderStateSummary(state, config, { scene: projectScene('alpha') })
  assert.ok(summary.includes('〔鲸鲸插件〕这个项目用 tabs'), summary)
})
