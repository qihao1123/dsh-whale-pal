import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSceneView } from '../index.js'
import { detectProjectScene, ensureProjectScene } from '../lib/project.js'
import { groupByScene, projectScene, SCENE_OWNER, SCENE_WORK_GENERAL } from '../lib/scene.js'
import { decideSceneRequest, mergeProjectDir, moveMemoryToScene, renameScene } from '../lib/scenes-edit.js'
import { selectMemory } from '../lib/memory.js'
import { createInitialState, normalizeState } from '../lib/state/schema.js'
import { applyAssessment } from '../lib/updater.js'
import { DEFAULTS, normalize } from '../lib/config.js'

const config = normalize(DEFAULTS)
const NOW = 1_760_000_000_000
const alpha = { dir: 'D:/work/alpha', name: 'alpha' }
const beta = { dir: 'D:/work/beta', name: 'beta' }

function seed() {
  const state = createInitialState(config, NOW)
  const first = applyAssessment(state, { memory: { facts: ['这个模块要重构'] } }, { now: NOW, turn: 1, project: alpha })
  // 真实流程里落盘前会过一遍 normalizeState（发号也在这里），测试照这条走。
  return normalizeState(first.state, config, NOW)
}

test('设置页拿得到场景清单：每层叫什么、几条、最后更新', () => {
  const state = seed()
  const view = buildSceneView(state, { cwd: 'D:/work/alpha', via: 'marker', scene: projectScene('alpha') })
  assert.equal(view.current.cwd, 'D:/work/alpha')
  assert.equal(view.pools.length, 1)
  assert.equal(view.pools[0].id, projectScene('alpha'))
  assert.equal(view.pools[0].label, 'alpha')
  assert.equal(view.pools[0].count, 1)
  assert.ok(view.pools[0].lastUpdatedAt > 0)
  assert.ok(view.note.includes('记得的会比从前少'), '界面要一句解释，不然用户以为坏了')
})

test('每条记忆都能看到归属与理由', () => {
  const state = seed()
  const view = buildSceneView(state)
  assert.equal(view.entries.length, 1)
  assert.equal(view.entries[0].scene, projectScene('alpha'))
  assert.equal(view.entries[0].sceneLabel, 'alpha')
  assert.ok(view.entries[0].why.includes('这个场景'), view.entries[0].why)

  // 计数升上去的，理由要说清是「两个场景都出现过」。
  const counted = applyAssessment(state, { memory: { facts: ['这个模块要重构'] } }, { now: NOW, turn: 2, project: beta })
  const after = buildSceneView(counted.state)
  assert.equal(after.entries.length, 1)
  assert.equal(after.entries[0].scene, SCENE_WORK_GENERAL)
  assert.ok(after.entries[0].why.includes('两个以上场景'), after.entries[0].why)
})

test('把一条挪走：原来那个池子里没了，目标池子里有', () => {
  const state = seed()
  state.scenes.projects.push({ id: projectScene('beta'), name: 'beta', dirs: ['D:/work/beta'], editable: true })
  const id = state.memory.facts[0].id
  assert.ok(id, '条目应当有编号')
  const result = moveMemoryToScene(state, { id, scene: projectScene('beta') })
  assert.equal(result.ok, true)
  assert.equal(result.from, projectScene('alpha'))
  assert.equal(result.to, projectScene('beta'))
  const pools = groupByScene(state.memory.facts)
  assert.equal((pools.get(projectScene('alpha')) ?? []).length, 0)
  assert.equal((pools.get(projectScene('beta')) ?? []).length, 1)
  // 人挪的记成手动，不再背计数晋升的七折。
  assert.equal(state.memory.facts[0].elevatedBy, 'manual')
  assert.equal(state.memory.facts[0].weight, 1)
})

test('挪一条：编号不存在就明说，不拿相似的那条顶上', () => {
  const state = seed()
  const result = moveMemoryToScene(state, { id: 'M-999', scene: projectScene('alpha') })
  assert.deepEqual(result, { ok: false, error: 'not-found' })
})

test('改一次目录到项目的映射，下一次召回立刻跟着变，不用重启', () => {
  const state = createInitialState(config, NOW)
  state.scenes.projects.push({ id: projectScene('alpha'), name: 'alpha', dirs: ['D:/work/alpha'], editable: true })
  state.scenes.projects.push({ id: projectScene('beta'), name: 'beta', dirs: ['D:/work/beta'], editable: true })
  const applied = applyAssessment(state, { memory: { facts: ['这个模块要重构'] } }, { now: NOW, turn: 1, project: alpha })
  const next = applied.state
  // 挪之前：在 beta 下，alpha 的那条不在召回里。
  const before = selectMemory(next.memory, { session: 1, limit: 4, scene: projectScene('beta') })
  assert.deepEqual(before.map((item) => item.text), [])
  // 把 beta 的目录并进 alpha 项目。
  const merged = mergeProjectDir(next, { dir: 'D:/work/beta', scene: projectScene('alpha') })
  assert.equal(merged.ok, true)
  const found = detectProjectScene('D:/work/beta/src', { scenes: next.scenes })
  assert.equal(found.via, 'manual')
  assert.equal(found.scene, projectScene('alpha'))
  // 同一份状态、同一个查询，归属立刻变了。
  const after = selectMemory(next.memory, { session: 1, limit: 4, scene: found.scene })
  assert.deepEqual(after.map((item) => item.text), ['这个模块要重构'])
})

test('一个目录只属于一个项目：并过来时从别处摘掉', () => {
  const state = createInitialState(config, NOW)
  ensureProjectScene(state.scenes, { dir: 'D:/work/alpha', name: 'alpha' }, NOW)
  ensureProjectScene(state.scenes, { dir: 'D:/work/beta', name: 'beta' }, NOW)
  mergeProjectDir(state, { dir: 'D:/work/alpha', scene: projectScene('beta') })
  const alphaProject = state.scenes.projects.find((item) => item.id === projectScene('alpha'))
  assert.deepEqual(alphaProject.dirs, [])
  const betaProject = state.scenes.projects.find((item) => item.id === projectScene('beta'))
  assert.ok(betaProject.dirs.includes('D:/work/alpha'))
  // 只剩一处命中，不存在两个项目抢同一个目录。
  const found = detectProjectScene('D:/work/alpha/lib', { scenes: state.scenes })
  assert.equal(found.scene, projectScene('beta'))
})

test('场景名可以改，id 不动', () => {
  const state = seed()
  const result = renameScene(state, { scene: projectScene('alpha'), name: '鲸鲸插件' })
  assert.equal(result.ok, true)
  const node = state.scenes.projects.find((item) => item.id === projectScene('alpha'))
  assert.equal(node.name, '鲸鲸插件')
  assert.equal(node.id, projectScene('alpha'))
})

test('「通用层满了」的请求：放进去就真挪，拒绝就只划掉', () => {
  const state = seed()
  state.scenes.projects.push({ id: projectScene('beta'), name: 'beta', dirs: ['D:/work/beta'], editable: true })
  const id = state.memory.facts[0].id
  state.sceneRequests = [{ id, scene: SCENE_WORK_GENERAL, text: '这个模块要重构', at: NOW, session: 3 }]
  const accepted = decideSceneRequest(state, { scene: SCENE_WORK_GENERAL, text: '这个模块要重构', accept: true })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.moved, true)
  assert.equal(state.memory.facts[0].scene, SCENE_WORK_GENERAL)
  assert.deepEqual(state.sceneRequests, [])

  const state2 = seed()
  state2.sceneRequests = [{ id: '', scene: SCENE_WORK_GENERAL, text: '这个模块要重构', at: NOW, session: 3 }]
  const declined = decideSceneRequest(state2, { scene: SCENE_WORK_GENERAL, text: '这个模块要重构', accept: false })
  assert.equal(declined.moved, false)
  assert.equal(state2.memory.facts[0].scene, projectScene('alpha'), '拒绝不该动原来的条目')
})

test('挪到一层树里没有的地方：拒绝，不造出看不清来源的池子', () => {
  const state = seed()
  const id = state.memory.facts[0].id
  const result = moveMemoryToScene(state, { id, scene: 'project:不存在' })
  assert.deepEqual(result, { ok: false, error: 'no-scene' })
  assert.equal(state.memory.facts[0].scene, projectScene('alpha'))
})

test('主人层那条不会被误标成「项目里记的」', () => {
  const state = createInitialState(config, NOW)
  state.memory.preferences.push({
    id: 'M-001',
    scene: SCENE_OWNER,
    text: '用户喜欢深色主题',
    at: NOW,
    session: 1,
    lastSeenAt: NOW,
    lastSeenSession: 1,
    salience: 0.7,
    hits: 1,
  })
  const view = buildSceneView(state)
  assert.equal(view.entries[0].why, '偏好默认放主人层')
})
