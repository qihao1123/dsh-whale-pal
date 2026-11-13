/**
 * 两种模式：按会话目录定、绑定/解绑命令、工作区改名，以及那两条任何模式都不放松的规矩。
 *
 * 2026-11-10 改的性质：模式不再有全局默认、也不再有会话级覆盖位 ——
 * 那两层正是「在一个会话里切一下、别的会话跟着变」的来源。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  WHALE_TAG,
  findWorkspace,
  handleModeCommand,
  isWhaleWorkspace,
  listWorkspaces,
  modeText,
  parseModeCommand,
  resolveMode,
  setWhaleWorkspace,
  syncAllWorkspaceTitles,
  syncWorkspaceTitle,
  taggedTitle,
} from '../lib/mode.js'

function makeApi(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-mode-'))
  const configPath = join(dir, 'config.json')
  let current = { bot_name: 'whale', ...config }
  writeFileSync(configPath, JSON.stringify(current), 'utf8')
  return {
    paths: { config: configPath },
    getConfig: () => current,
    setConfig(next) {
      current = next
      writeFileSync(configPath, JSON.stringify(next), 'utf8')
      return { ok: true, config: next, warnings: [] }
    },
  }
}

/** 假的 workspaceController：follow 回一帧 baseline 就结束。 */
function makeController(items, { failRename = false } = {}) {
  const calls = []
  return {
    calls,
    async *follow() {
      yield { type: 'baseline', value: { items } }
      // 真实实现是长流；这里给一帧就够，测试要的是「读第一帧就断」。
    },
    async rename(request) {
      calls.push(request)
      if (failRename) throw new Error('name-conflict')
      return { workspace: { workspaceId: request.workspaceId, title: request.title } }
    },
  }
}

describe('命令解析', () => {
  it('show 的三种写法', () => {
    assert.deepEqual(parseModeCommand(''), { action: 'show' })
    assert.deepEqual(parseModeCommand('mode'), { action: 'show' })
    assert.deepEqual(parseModeCommand('  '), { action: 'show' })
  })

  it('设成鲸鲸与设回助手', () => {
    assert.deepEqual(parseModeCommand('mode whale'), { action: 'set', whale: true })
    assert.deepEqual(parseModeCommand('MODE Assistant'), { action: 'set', whale: false })
    assert.deepEqual(parseModeCommand('whale'), { action: 'set', whale: true })
    assert.deepEqual(parseModeCommand('assistant'), { action: 'set', whale: false })
    assert.deepEqual(parseModeCommand('bind'), { action: 'set', whale: true })
    assert.deepEqual(parseModeCommand('unbind'), { action: 'set', whale: false })
  })

  it('不认识的写法分开报', () => {
    assert.equal(parseModeCommand('mode 阴阳').action, 'invalid')
    assert.equal(parseModeCommand('别的').action, 'unknown')
  })
})

describe('按目录定模式', () => {
  const config = { whaleWorkspaces: ['D:\\AI 项目\\聊天'] }

  it('名单里的目录是鲸鲸，别的是助手', () => {
    assert.equal(resolveMode({ config, cwd: 'D:\\AI 项目\\聊天' }), 'whale')
    assert.equal(resolveMode({ config, cwd: 'D:\\AI 项目\\别的项目' }), 'assistant')
  })

  it('大小写、斜杠、尾斜杠都不影响判定', () => {
    assert.equal(isWhaleWorkspace(config, 'd:/ai 项目/聊天/'), true)
    assert.equal(isWhaleWorkspace(config, 'D:\\AI 项目\\聊天\\'), true)
  })

  it('子目录不算同一个目录', () => {
    assert.equal(isWhaleWorkspace(config, 'D:\\AI 项目\\聊天\\子目录'), false)
  })

  it('读不到目录时按助手走，不猜', () => {
    assert.equal(resolveMode({ config, cwd: '' }), 'assistant')
    assert.equal(resolveMode({ config }), 'assistant')
    assert.equal(resolveMode({}), 'assistant')
  })

  it('空名单里全是助手', () => {
    assert.equal(resolveMode({ config: {}, cwd: 'D:\\任意' }), 'assistant')
  })
})

describe('名单增删', () => {
  it('加入、移出、重复加入不会多一条', () => {
    const one = setWhaleWorkspace([], 'D:\\聊天', true)
    assert.deepEqual(one, ['D:\\聊天'])
    const two = setWhaleWorkspace(one, 'D:\\聊天\\', true)
    assert.equal(two.length, 1)
    assert.deepEqual(setWhaleWorkspace(two, 'D:\\聊天', false), [])
  })

  it('移出别的目录时不误删', () => {
    const list = ['D:\\a', 'D:\\b']
    assert.deepEqual(setWhaleWorkspace(list, 'D:\\a', false), ['D:\\b'])
  })
})

describe('工作区名加标记', () => {
  it('加、剥、再剥', () => {
    assert.equal(taggedTitle('聊天', true), `${WHALE_TAG}聊天`)
    assert.equal(taggedTitle(`${WHALE_TAG}聊天`, true), `${WHALE_TAG}聊天`)
    assert.equal(taggedTitle(`${WHALE_TAG}聊天`, false), '聊天')
    assert.equal(taggedTitle('聊天', false), '聊天')
  })

  it('重复加不会越叠越长', () => {
    const once = taggedTitle('聊天', true)
    assert.equal(taggedTitle(once, true), once)
  })
})

describe('绑定命令', () => {
  it('绑定把目录写进 config.whaleWorkspaces，旧的全局 mode 一并清掉', () => {
    const api = makeApi({ mode: 'whale' })
    const result = handleModeCommand({ api, cwd: 'D:\\聊天', rawInput: 'bind' })
    assert.equal(result.kind, 'success')
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.deepEqual(saved.whaleWorkspaces, ['D:\\聊天'])
    assert.equal(Object.hasOwn(saved, 'mode'), false)
  })

  it('解绑把这一个目录移掉，别的目录留着', () => {
    const api = makeApi({ whaleWorkspaces: ['D:\\聊天', 'D:\\b'] })
    const result = handleModeCommand({ api, cwd: 'D:\\聊天', rawInput: 'unbind' })
    assert.equal(result.kind, 'success')
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.deepEqual(saved.whaleWorkspaces, ['D:\\b'])
  })

  it('只看当前模式时不写盘', () => {
    const api = makeApi({ whaleWorkspaces: ['D:\\聊天'] })
    const before = readFileSync(api.paths.config, 'utf8')
    const result = handleModeCommand({ api, cwd: 'D:\\聊天', rawInput: 'mode' })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /鲸鲸模式/)
    assert.equal(readFileSync(api.paths.config, 'utf8'), before)
  })

  it('读不到目录就不改，也不猜它是哪一间', () => {
    const api = makeApi()
    const result = handleModeCommand({ api, cwd: '', rawInput: 'bind' })
    assert.equal(result.kind, 'error')
  })

  it('不认识的模式只回报可选值', () => {
    const api = makeApi()
    const result = handleModeCommand({ api, cwd: 'D:\\聊天', rawInput: 'mode 阴阳' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /assistant 和 whale/)
  })
})

describe('工作区改名', () => {
  const items = [{ workspaceId: 'w1', path: 'D:\\聊天', title: '聊天' }]

  it('绑定后名字带上标记', async () => {
    const controller = makeController(items)
    const said = await syncWorkspaceTitle({ workspaceController: controller, cwd: 'D:\\聊天', whale: true })
    assert.equal(said.ok, true)
    assert.equal(said.changed, true)
    assert.deepEqual(controller.calls, [{ workspaceId: 'w1', title: `${WHALE_TAG}聊天` }])
  })

  it('解绑后标记被剥掉', async () => {
    const controller = makeController([{ workspaceId: 'w1', path: 'D:\\聊天', title: `${WHALE_TAG}聊天` }])
    const said = await syncWorkspaceTitle({ workspaceController: controller, cwd: 'D:\\聊天', whale: false })
    assert.equal(said.ok, true)
    assert.deepEqual(controller.calls, [{ workspaceId: 'w1', title: '聊天' }])
  })

  it('名字已经对了就不再改名', async () => {
    const controller = makeController([{ workspaceId: 'w1', path: 'D:\\聊天', title: '聊天' }])
    const said = await syncWorkspaceTitle({ workspaceController: controller, cwd: 'D:\\聊天', whale: false })
    assert.equal(said.ok, true)
    assert.equal(said.changed, false)
    assert.deepEqual(controller.calls, [])
  })

  it('这三种失败都给出原因，不抛错', async () => {
    assert.equal((await syncWorkspaceTitle({ workspaceController: null, cwd: 'x', whale: true })).reason, 'no-service')
    const empty = makeController([])
    assert.equal((await syncWorkspaceTitle({ workspaceController: empty, cwd: 'D:\\聊天', whale: true })).reason, 'not-registered')
    const broken = makeController(items, { failRename: true })
    const said = await syncWorkspaceTitle({ workspaceController: broken, cwd: 'D:\\聊天', whale: true })
    assert.equal(said.ok, false)
    assert.equal(said.reason, 'rename-failed')
  })

  // 命令那条路：改名只是增强，服务缺席或撞名都不许把绑定回滚掉。
  it('服务缺席时绑定照样落盘，只在日志里记一句跳过', async () => {
    const api = makeApi()
    const logs = []
    const result = handleModeCommand({
      api,
      cwd: 'D:\\聊天',
      rawInput: 'bind',
      workspaceController: null,
      log: (line) => logs.push(line),
    })
    assert.equal(result.kind, 'success')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(JSON.parse(readFileSync(api.paths.config, 'utf8')).whaleWorkspaces, ['D:\\聊天'])
    assert.ok(logs.some((line) => line.includes('工作区改名跳过：no-service')))
  })

  it('撞名导致改名失败也只记日志，绑定不回滚', async () => {
    const api = makeApi()
    const logs = []
    const broken = makeController(items, { failRename: true })
    const result = handleModeCommand({
      api,
      cwd: 'D:\\聊天',
      rawInput: 'bind',
      workspaceController: broken,
      log: (line) => logs.push(line),
    })
    assert.equal(result.kind, 'success')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.ok(logs.some((line) => line.includes('rename-failed')))
  })
})

describe('工作区清单', () => {
  it('按 path 找到对应的那一间', async () => {
    const controller = makeController([
      { workspaceId: 'w1', path: 'D:\\a', title: 'A' },
      { workspaceId: 'w2', path: 'D:\\聊天', title: '聊天' },
    ])
    const found = await findWorkspace(controller, 'd:/聊天/')
    assert.equal(found.ok, true)
    assert.equal(found.workspace.workspaceId, 'w2')
  })

  it('列清单时把空路径滤掉', async () => {
    const controller = makeController([
      { workspaceId: 'w1', path: 'D:\\a', title: 'A' },
      { workspaceId: 'w2', path: '', title: '空' },
    ])
    const list = await listWorkspaces(controller)
    assert.deepEqual(list, [{ id: 'w1', path: 'D:\\a', title: 'A' }])
  })

  it('没有工作区服务时回空数组，不抛错', async () => {
    assert.deepEqual(await listWorkspaces(null), [])
  })
})

describe('整批对齐工作区名', () => {
  const items = [
    { workspaceId: 'w1', path: 'D:\\聊天', title: '聊天' },
    { workspaceId: 'w2', path: 'D:\\项目', title: '项目' },
    { workspaceId: 'w3', path: 'D:\\旧', title: `${WHALE_TAG}旧` },
  ]

  it('名单里的加标记，移出的剥掉，没动的就不碰', async () => {
    const controller = makeController(items)
    const said = await syncAllWorkspaceTitles({ workspaceController: controller, list: ['D:\\聊天'] })
    assert.equal(said.ok, true)
    assert.deepEqual(controller.calls, [
      { workspaceId: 'w1', title: `${WHALE_TAG}聊天` },
      { workspaceId: 'w3', title: '旧' },
    ])
  })

  it('名字本来就对的，一次 rename 都不发', async () => {
    const controller = makeController([{ workspaceId: 'w1', path: 'D:\\项目', title: '项目' }])
    const said = await syncAllWorkspaceTitles({ workspaceController: controller, list: [] })
    assert.equal(said.ok, true)
    assert.deepEqual(controller.calls, [])
  })

  it('单条撞名失败不连累其余', async () => {
    const controller = makeController(items, { failRename: true })
    const said = await syncAllWorkspaceTitles({ workspaceController: controller, list: ['D:\\聊天'] })
    assert.equal(said.ok, true)
    assert.deepEqual(said.changed, [])
  })
})

describe('模式那段提示', () => {
  it('主次排序两种模式正好相反', () => {
    assert.match(modeText({ mode: 'whale' }), /人格表达在前，任务准确性在后/)
    assert.match(modeText({ mode: 'assistant' }), /任务准确性在前，人格表达在后/)
  })

  it('门禁与「不让路」在任何模式里都在', () => {
    for (const mode of ['assistant', 'whale']) {
      const text = modeText({ mode })
      assert.match(text, /门禁与确认口令按字面判/)
      assert.match(text, /不构成确认/)
      assert.match(text, /事实、校验、安全不在这条排序里/)
    }
  })

  it('模式段只定主次，不规定语气', () => {
    for (const mode of ['assistant', 'whale']) {
      const text = modeText({ mode })
      assert.doesNotMatch(text, /不表演情绪/)
      assert.doesNotMatch(text, /可以短、可以松/)
      assert.doesNotMatch(text, /只改形式/)
      assert.doesNotMatch(text, /任务进行中自动按助手模式/)
    }
  })
})
