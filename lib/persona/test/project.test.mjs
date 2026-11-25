import assert from 'node:assert/strict'
import test from 'node:test'
import { join, normalize } from 'node:path'

import {
  detectProjectScene,
  ensureProjectScene,
  isBackupDir,
  isWithin,
} from '../lib/project.js'
import { createScenes, projectScene, SCENE_OWNER } from '../lib/scene.js'
import { addMemory, resolveMemory, selectMemory } from '../lib/memory.js'
import { createInitialState } from '../lib/state/schema.js'
import { applyAssessment } from '../lib/updater.js'
import { DEFAULTS, normalize as normalizeConfig } from '../lib/config.js'

const config = normalizeConfig(DEFAULTS)
const NOW = 1_760_000_000_000

/** 假盘：只认「某个目录下有哪些标记文件」。路径按当前平台的写法拼，Windows 和 Linux 都能跑。 */
function fakeDisk() {
  const files = new Set()
  return {
    files,
    add(dir, ...names) {
      for (const name of names) files.add(join(normalize(dir), name))
      return this
    },
    exists: (path) => files.has(path),
  }
}

test('目录名像备份、副本、临时产物的不算项目', () => {
  for (const name of ['备份', '项目副本', '.bak-2026-11-10', 'backup', 'tmp', 'temp', 'old', '归档']) {
    assert.equal(isBackupDir(name), true, `${name} 应该当成备份目录`)
  }
  for (const name of ['鲸鲸', 'whale-pal', 'src', 'plugins']) {
    assert.equal(isBackupDir(name), false, `${name} 不该被当成备份目录`)
  }
})

test('子目录往上找标记，归到那个项目，不另起一个', () => {
  const disk = fakeDisk().add('D:/work/alpha', '.git')
  const found = detectProjectScene('D:/work/alpha/lib/persona', { exists: disk.exists })
  assert.equal(found.scene, projectScene('alpha'))
  assert.equal(found.dir, normalize('D:/work/alpha'))
  assert.equal(found.via, 'marker')
})

test('找不到标记时，当前目录自己就是一个项目', () => {
  const disk = fakeDisk()
  const found = detectProjectScene('D:/work/beta', { exists: disk.exists })
  assert.equal(found.scene, projectScene('beta'))
  assert.equal(found.via, 'cwd')
})

test('备份目录不建池：并到被备份的那个项目', () => {
  // 有标记：跳过备份目录，落到上面的项目。
  const marked = fakeDisk().add('D:/work/alpha', 'package.json')
  const a = detectProjectScene('D:/work/alpha/.bak-2026-11-10-card-landed', { exists: marked.exists })
  assert.equal(a.scene, projectScene('alpha'))
  // 没标记：退到备份目录的上一层，仍然不新建池。
  const bare = fakeDisk()
  const b = detectProjectScene('D:/work/gamma/备份/旧文件', { exists: bare.exists })
  assert.equal(b.scene, projectScene('gamma'))
  assert.equal(b.via, 'backup')
  assert.equal(b.dir, normalize('D:/work/gamma'))
})

test('认不出项目时返回空，不硬造一个池', () => {
  const disk = fakeDisk()
  // 盘根没有目录名，算认不出。
  const root = detectProjectScene('D:/', { exists: disk.exists })
  assert.equal(root.scene, null)
  assert.equal(root.via, 'unresolved')
  const empty = detectProjectScene('   ', { exists: disk.exists })
  assert.equal(empty.scene, null)
})

test('手动合并：几个目录指定成同一个项目，子目录也算', () => {
  const scenes = createScenes()
  scenes.projects.push({
    id: 'project:合并',
    name: '合并',
    dirs: [normalize('D:/work/a'), normalize('D:/work/b')],
    editable: true,
  })
  const found = detectProjectScene('D:/work/b/src', { scenes, exists: () => false })
  assert.equal(found.via, 'manual')
  assert.equal(found.scene, 'project:合并')
})

test('同名但不同目录的两个项目，id 分得开', () => {
  const scenes = createScenes()
  const one = ensureProjectScene(scenes, { dir: 'D:/work/a/tools', name: 'tools' }, NOW)
  const two = ensureProjectScene(scenes, { dir: 'D:/work/b/tools', name: 'tools' }, NOW)
  assert.notEqual(one.id, two.id)
  // 同一个目录再认定一次，复用原节点，不新增。
  const again = ensureProjectScene(scenes, { dir: 'D:/work/a/tools/lib', name: 'tools' }, NOW)
  assert.equal(again.id, one.id)
  assert.equal(scenes.projects.length, 2)
})

test('项目清单满了就不建池，返回空让调用方落主人层', () => {
  const scenes = createScenes()
  for (let i = 0; i < 50; i += 1) ensureProjectScene(scenes, { dir: `D:/work/p${i}`, name: `p${i}` }, NOW)
  const extra = ensureProjectScene(scenes, { dir: 'D:/work/extra', name: 'extra' }, NOW)
  assert.equal(extra, null)
})

test('A 项目和 B 项目说一句措辞很像的话：两条都在，谁也没顶掉谁', () => {
  const state = createInitialState(config, NOW)
  const a = applyAssessment(state, { memory: { facts: ['这个模块要重构'] } }, {
    now: NOW,
    turn: 1,
    project: { dir: 'D:/work/alpha', name: 'alpha' },
  })
  // 一字不差才算「同一件事」（P3 的计数晋升）；措辞像但不一样的是两件事。
  const b = applyAssessment(a.state, { memory: { facts: ['这个模块要重构了'] } }, {
    now: NOW,
    turn: 2,
    project: { dir: 'D:/work/beta', name: 'beta' },
  })
  const texts = b.state.memory.facts.map((entry) => entry.text)
  assert.deepEqual(texts, ['这个模块要重构', '这个模块要重构了'])
  assert.deepEqual(b.state.memory.facts.map((entry) => entry.scene), [projectScene('alpha'), projectScene('beta')])
  // 两个项目都进了场景树。
  assert.deepEqual(b.state.scenes.projects.map((item) => item.name).sort(), ['alpha', 'beta'])
})

test('同一个项目里说同样的话，还是合并成一条', () => {
  const state = createInitialState(config, NOW)
  const project = { dir: 'D:/work/alpha', name: 'alpha' }
  const first = applyAssessment(state, { memory: { facts: ['这个模块要重构'] } }, { now: NOW, turn: 1, project })
  const second = applyAssessment(first.state, { memory: { facts: ['这个模块要重构'] } }, { now: NOW, turn: 2, project })
  assert.equal(second.state.memory.facts.length, 1)
  assert.equal(second.state.memory.facts[0].hits, 2)
})

test('A 项目说满 200 条，B 项目刚说一条：B 那条还在', () => {
  // 每条都要真的不一样：措辞太像会被去重合并，那样测的就不是名额了。
  const CHARS = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏'
  const topic = (i) => `${CHARS[i % 20]}${CHARS[Math.floor(i / 20) % 20]}的做法`
  const list = []
  for (let i = 0; i < 200; i += 1) {
    addMemory(list, topic(i), { kind: 'facts', cap: 200, scene: projectScene('alpha'), session: 1 })
  }
  const result = addMemory(list, '项目乙只有这一条', { kind: 'facts', cap: 200, scene: projectScene('beta'), session: 2 })
  assert.equal(result.status, 'added')
  const beta = list.filter((entry) => entry.scene === projectScene('beta'))
  assert.equal(beta.length, 1)
  assert.equal(beta[0].text, '项目乙只有这一条')
  // 甲仍然顶在 200，没有因为多了一个池子被放宽。
  assert.equal(list.filter((entry) => entry.scene === projectScene('alpha')).length, 200)
})

test('认不出项目时，写入落主人层，场景树里不多出空项目', () => {
  const state = createInitialState(config, NOW)
  const applied = applyAssessment(state, { memory: { facts: ['用户喜欢猫'] } }, { now: NOW, turn: 1, project: null })
  assert.equal(applied.state.memory.facts[0].scene, SCENE_OWNER)
  assert.deepEqual(applied.state.scenes.projects, [])
})

test('做完了的事只在同一个池子里结', () => {
  const list = []
  addMemory(list, '群聊记忆怎么分层还没定', { kind: 'openTopics', scene: projectScene('alpha'), session: 1 })
  addMemory(list, '群聊记忆怎么分层还得定', { kind: 'openTopics', scene: projectScene('beta'), session: 1 })
  const done = resolveMemory(list, '群聊记忆怎么分层还没定', { session: 2, scene: projectScene('alpha') })
  assert.equal(done, '群聊记忆怎么分层还没定')
  const alive = list.filter((entry) => entry.resolved !== true)
  assert.equal(alive.length, 1)
  assert.equal(alive[0].scene, projectScene('beta'))
})

test('招回还是全局的：P1 只改写入，不动读', () => {
  const memory = { facts: [], preferences: [], events: [], openTopics: [] }
  addMemory(memory.facts, '项目甲的规矩', { kind: 'facts', scene: projectScene('alpha'), session: 1 })
  // P2 才会按距离排序；现在两个池子都进候选，谁也不许被悄悄藏起来。
  const picked = selectMemory(memory, { session: 1, limit: 4, query: '规矩' })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].text, '项目甲的规矩')
})
