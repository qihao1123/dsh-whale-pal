import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createSceneRegistry, SCENE_API_VERSION, SceneApiTooOldError, sceneRegistry } from '../lib/persona/lib/scene-registry.js'
import { createScenes, parentScene, projectScene, sceneLabel, SCENE_OWNER } from '../lib/persona/lib/scene.js'
import { addMemory, findMemoryById } from '../lib/persona/lib/memory.js'
import { createInitialState, normalizeState } from '../lib/persona/lib/state/schema.js'
import { DEFAULTS, normalize } from '../lib/persona/lib/config.js'
import { scanOpenPackage } from '../scripts/check-open.mjs'

const config = normalize(DEFAULTS)
const NOW = 1_760_000_000_000
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('注册口：外部类型注册进来，认得它的名字和父节点，注销后认不出来', () => {
  const registry = createSceneRegistry(SCENE_API_VERSION)
  const dispose = registry.register({
    axis: 'demo',
    label: '演示场景',
    parentOf: (id) => (id.includes(':') ? 'demo' : 'owner'),
    labelOf: (id) => (id.includes(':') ? `演示·${id.split(':').pop()}` : '演示场景'),
  })
  assert.deepEqual(registry.list(), [{ axis: 'demo', label: '演示场景' }])
  assert.equal(registry.typeOf('demo:a')?.axis, 'demo')
  assert.equal(registry.labelOf('demo:a'), '演示·a')
  assert.equal(registry.labelOf('demo'), '演示场景')
  assert.equal(registry.parentOf('demo:a'), 'demo')
  assert.equal(registry.isKnown('demo:a'), true)
  dispose()
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.isKnown('demo:a'), false)
  // 注销后不走注册表，但 id 本身仍然是一个池子（存储层不吞东西）。
  assert.equal(registry.labelOf('demo:a'), 'a')
})

test('注册口版本门槛：不够就拒绝加载，并说清需要哪一版', () => {
  const registry = createSceneRegistry(1)
  assert.equal(registry.requireApi(1), true)
  assert.throws(
    () => registry.requireApi(2),
    (error) => {
      assert.equal(error instanceof SceneApiTooOldError, true)
      assert.equal(error.code, 'scene-api-too-old')
      assert.match(error.message, /需要 v2/u)
      assert.match(error.message, /当前 v1/u)
      return true
    },
  )
})

test('同一个 axis 不许注册两次，只许小写英文开头', () => {
  const registry = createSceneRegistry()
  registry.register({ axis: 'demo' })
  assert.throws(() => registry.register({ axis: 'demo' }), /已经注册过/u)
  assert.throws(() => registry.register({ axis: '直播' }), /小写词/u)
  assert.throws(() => registry.register({ axis: '' }), /必须有一个 axis/u)
})

test('注册进默认表的类型：父节点和显示名都走注册表，开源包不写死', () => {
  const dispose = sceneRegistry.register({
    axis: 'demo',
    label: '演示',
    parentOf: () => 'owner',
    labelOf: (id) => (id === 'demo:1' ? '第一个演示' : '演示'),
  })
  try {
    assert.equal(parentScene('demo:1'), SCENE_OWNER)
    assert.equal(sceneLabel('demo:1'), '第一个演示')
  } finally {
    dispose()
  }
  // 注销之后退回主人层 + id 最后一段。
  assert.equal(parentScene('demo:1'), SCENE_OWNER)
  assert.equal(sceneLabel('demo:1'), '1')
})

test('外部场景的节点跟别的场景长在同一棵树里：一条编号两边都查得到', () => {
  const state = createInitialState(config, NOW)
  state.scenes.external.push({ id: 'demo:1', type: 'demo', label: '第一个演示', createdAt: NOW, updatedAt: NOW })
  addMemory(state.memory.facts, '这个演示场景里说过的话', { kind: 'facts', scene: 'demo:1', session: 1 })
  const reloaded = normalizeState(JSON.parse(JSON.stringify(state)), config, NOW)
  assert.equal(reloaded.scenes.external[0].id, 'demo:1')
  const entry = reloaded.memory.facts.find((item) => item.scene === 'demo:1')
  assert.ok(entry?.id, '外部场景的条目也要有编号')
  const found = findMemoryById(reloaded, entry.id)
  assert.equal(found?.entry.text, '这个演示场景里说过的话')
  assert.equal(found?.entry.scene, 'demo:1')
})

test('场景树是同一棵：项目、群、外部场景都在 scenes 里，不各存一套', () => {
  const scenes = createScenes()
  scenes.projects.push({ id: projectScene('alpha'), name: 'alpha', dirs: [] })
  scenes.groups.push({ id: 'group:qq:1', platform: 'qq', groupId: '1', name: '群', members: [], sessionId: 's-1' })
  scenes.external.push({ id: 'demo:1', type: 'demo', label: '演示' })
  const state = createInitialState(config, NOW)
  state.scenes = scenes
  const reloaded = normalizeState(JSON.parse(JSON.stringify(state)), config, NOW)
  assert.equal(reloaded.scenes.projects.length, 1)
  assert.equal(reloaded.scenes.groups.length, 1)
  assert.equal(reloaded.scenes.external.length, 1)
  // 三个分支挂在同一个 scenes 对象上，取回工具用的是同一份 memory。
  assert.equal(Object.keys(reloaded.scenes).includes('live'), false, '开源包里不该有一个写死的外部场景分支')
})

test('开源包发布检查：要发出去的文件里没有外部场景的东西，也没有说不清的依赖', () => {
  const report = scanOpenPackage({ root: ROOT })
  assert.deepEqual(report.hits, [], JSON.stringify(report.hits, null, 2))
  assert.equal(report.ok, true)
  assert.ok(report.files > 20, `扫的文件太少，可能路径不对：${report.files}`)
})
