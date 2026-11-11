/**
 * 换会话：交接条怎么拼、会话怎么开、失败怎么如实说。
 *
 * 全用假服务，不碰真宿主、不建真会话 —— 这条路一旦真跑起来会在 Web GUI 里
 * 多出一个会话，所以单测只在纯函数与假对象上做。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  HANDOFF_CATALOG_MAX,
  HANDOFF_MAX,
  cwdOfSession,
  handoffText,
  makeServiceOf,
  openItemsOf,
  promptSignal,
  switchSession,
} from '../lib/ctx/switch.js'

const CATALOG = ['C028 · Primary（test、js）', 'C029 · Primary（empty、ctx）'].join('\n')

function fakeSession({ id = 'session-old', cwd = 'D:\\AI 项目\\聊天' } = {}) {
  return { id, header: { id, cwd } }
}

function fakeController({ createError = null, promptError = null, sessionId = 'session-new-1', noPrompt = false } = {}) {
  const calls = { create: [], prompt: [], signal: [] }
  const controller = {
    calls,
    async create(request) {
      calls.create.push(request)
      if (createError) throw createError
      return { sessionId, agentPreset: request?.agentPreset }
    },
  }
  if (noPrompt !== true) {
    // 照宿主的真实行为：`prompt(request, signal)` 第一行就 signal.throwIfAborted()，
    // 没传第二个参数会直接抛 TypeError（2026-11-12 真机就是这么栽的）。
    controller.prompt = async (request, signal) => {
      calls.prompt.push(request)
      calls.signal.push(signal)
      if (typeof signal?.throwIfAborted !== 'function') throw new TypeError('cannot read properties of undefined (reading ThowIfAborted)')
      if (promptError) throw promptError
      return { accepted: true }
    }
  }
  return controller
}

function servicesOf(map) {
  return (key) => (Object.hasOwn(map, key) ? map[key] : null)
}

describe('makeServiceOf / cwdOfSession', () => {
  it('先直接取；直接取会抛的，走 ctx.get', () => {
    const live = { get: () => 'D:\\实时目录' }
    const ctx = {
      get: (key) => (key === 'workingDirectory' ? live : null),
      get sessionController() {
        throw new Error('没 inject 不能直接取')
      },
    }
    const get = makeServiceOf(ctx)
    assert.equal(get('workingDirectory'), live)
    assert.equal(get('sessionController'), null)
  })

  it('目录优先读投影，投影拿不到才退会话头，两个都空就空串', () => {
    const session = fakeSession({ cwd: 'D:\\会话头' })
    assert.equal(cwdOfSession(session, { get: () => 'D:\\投影' }), 'D:\\投影')
    assert.equal(cwdOfSession(session, { get: () => { throw new Error('没投影') } }), 'D:\\会话头')
    assert.equal(cwdOfSession(fakeSession({ cwd: '' }), null), '')
  })
})

describe('openItemsOf', () => {
  it('未结话题 + 还开着的约定，按上限收；已结的不要', () => {
    const items = openItemsOf({
      memory: { openTopics: ['t1', 't2'] },
      commitments: [{ status: 'open', text: 'c1' }, { status: 'done', text: 'c2' }, { status: 'open', text: 'c3' }],
    })
    assert.deepEqual(items, ['t1', 't2', 'c1', 'c3'])
  })

  it('读不到状态就是空列表，不抛', () => {
    assert.deepEqual(openItemsOf(null), [])
    assert.deepEqual(openItemsOf({ memory: {}, commitments: 'nope' }), [])
  })
})

describe('handoffText', () => {
  it('第一句就写明不是用户本人发的，并带旧会话、目录、未完成、目录行', () => {
    const text = handoffText({
      oldSessionId: 'session-old',
      cwd: 'D:\\AI 项目\\插件dsh-whale-pal开发',
      used: 96000,
      trigger: 80000,
      items: ['压缩档案取回体积要降到 ≤2000 字'],
      catalog: CATALOG,
    })
    assert.match(text, /不是用户本人发/u)
    assert.match(text, /session-old/u)
    assert.match(text, /96000/u)
    assert.match(text, /80000/u)
    assert.match(text, /D:\\AI 项目\\插件dsh-whale-pal开发/u)
    assert.match(text, /压缩档案取回体积/u)
    assert.match(text, /C028/u)
    assert.match(text, /whale_ctx/u)
  })

  it('没目录、没未完成、没档案：那几块整块不出现，不留空壳', () => {
    const text = handoffText({ oldSessionId: 'session-old' })
    assert.doesNotMatch(text, /^- 当前目录：/mu)
    assert.doesNotMatch(text, /^- 未完成的事：/mu)
    assert.doesNotMatch(text, /^- 档案目录/mu)
  })

  it('手动开的：理由照人说的写，不套用「压不动」那套', () => {
    const text = handoffText({ oldSessionId: 'session-old', reason: '用户手动 /whale new 开的', used: 96000, trigger: 80000 })
    assert.match(text, /用户手动 \/whale new 开的/u)
    assert.doesNotMatch(text, /96000/u)
  })

  it('目录只带前几行，整条有字数上限', () => {    const many = Array.from({ length: 20 }, (_, i) => `C0${String(i).padStart(2, '0')} · 主题 ${i}`).join('\n')
    const text = handoffText({ oldSessionId: 's', catalog: many })
    assert.equal(text.split('\n').filter((line) => /C0\d\d · 主题/u.test(line)).length, HANDOFF_CATALOG_MAX)
    const long = handoffText({ oldSessionId: 's', items: Array.from({ length: 40 }, () => '很长的一件事'.repeat(20)) })
    assert.ok(long.length <= HANDOFF_MAX + 1, `截断后长度 ${long.length}`)
  })
})

describe('switchSession', () => {
  it('没 sessionController：如实说没成，不乱开', async () => {
    const done = await switchSession({
      getService: servicesOf({}),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession(),
    })
    assert.equal(done.ok, false)
    assert.equal(done.reason, 'no-session-controller')
  })

  it('助手模式：按目录和预设建会话，并把交接条递给它', async () => {
    const controller = fakeController()
    const done = await switchSession({
      getService: servicesOf({
        sessionController: controller,
        workingDirectory: { get: () => 'D:\\AI 项目\\插件dsh-whale-pal开发' },
        agentPresets: { presetForSession: () => 'standard' },
      }),
      api: {
        getConfig: () => ({ whaleWorkspaces: ['D:\\AI 项目\\聊天'] }),
        getState: () => ({ memory: { openTopics: ['压缩档案取回体积要降到 ≤2000 字'] }, commitments: [] }),
      },
      session: fakeSession({ id: 'session-old', cwd: 'D:\\AI 项目\\插件dsh-whale-pal开发' }),
      used: 96000,
      trigger: 80000,
      catalog: CATALOG,
    })

    assert.equal(done.ok, true)
    assert.equal(done.mode, 'assistant')
    assert.equal(done.sessionId, 'session-new-1')
    assert.equal(done.seeded, true)
    assert.deepEqual(controller.calls.create[0], { cwd: 'D:\\AI 项目\\插件dsh-whale-pal开发', agentPreset: 'standard' })
    assert.equal(controller.calls.prompt.length, 1)
    assert.equal(typeof controller.calls.signal[0]?.throwIfAborted, 'function')
    const sent = controller.calls.prompt[0]
    assert.equal(sent.sessionId, 'session-new-1')
    assert.equal(sent.mode, 'queue')
    assert.equal(sent.content[0].type, 'text')
    assert.match(sent.content[0].text, /不是用户本人发/u)
    assert.match(sent.content[0].text, /session-old/u)
    assert.match(sent.content[0].text, /压缩档案取回体积/u)
  })

  it('挂到老会话的工作区：按会话编号找回工作区，再把新会话 attach 上去', async () => {
    const controller = fakeController()
    const attached = []
    const workspace = {
      id: 'ws-1',
      path: 'D:\\AI 项目\\插件dsh-whale-pal开发',
      sessionIds: ['session-old'],
      attachSession: async (id) => attached.push(id),
    }
    const done = await switchSession({
      getService: servicesOf({
        sessionController: controller,
        workingDirectory: { get: () => 'D:\\AI 项目\\插件dsh-whale-pal开发' },
        workspaceRegistry: { list: () => [workspace] },
      }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession({ id: 'session-old' }),
    })
    assert.equal(done.ok, true)
    assert.equal(done.grouped, true)
    assert.equal(done.workspace, 'ws-1')
    assert.deepEqual(attached, ['session-new-1'])
  })

  it('按编号找不到就按目录反查；两样都找不到就不归组（也不新建工作区）', async () => {
    const controller = fakeController()
    const attached = []
    const byPath = {
      id: 'ws-2',
      path: 'D:\\AI 项目\\插件dsh-whale-pal开发',
      sessionIds: [],
      attachSession: async (id) => attached.push(id),
    }
    const resolved = []
    const found = await switchSession({
      getService: servicesOf({
        sessionController: controller,
        workingDirectory: { get: () => 'D:\\AI 项目\\插件dsh-whale-pal开发' },
        workspaceRegistry: {
          list: () => [],
          resolveByPath: async (dir) => {
            resolved.push(dir)
            return byPath
          },
        },
      }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession({ id: 'session-old' }),
    })
    assert.equal(found.grouped, true)
    assert.equal(found.workspace, 'ws-2')
    assert.deepEqual(resolved, ['D:\\AI 项目\\插件dsh-whale-pal开发'])
    assert.deepEqual(attached, ['session-new-1'])

    const none = await switchSession({
      getService: servicesOf({
        sessionController: fakeController(),
        workspaceRegistry: { list: () => [], resolveByPath: async () => undefined },
      }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession(),
    })
    assert.equal(none.ok, true)
    assert.equal(none.grouped, null)
    assert.equal(none.workspace, '')
  })

  it('挂工作区失败：会话算开成，但把原因带出来', async () => {
    const done = await switchSession({
      getService: servicesOf({
        sessionController: fakeController(),
        workspaceRegistry: {
          list: () => [{
            id: 'ws-1',
            sessionIds: ['session-old'],
            attachSession: async () => {
              throw new Error('注册表写不进去')
            },
          }],
        },
      }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession(),
    })
    assert.equal(done.ok, true)
    assert.equal(done.grouped, false)
    assert.match(done.groupDetail, /注册表写不进去/u)
    // 归组失败不该拦住交接条：两边是两件事。
    assert.equal(done.seeded, true)
  })

  it('鲸鲸模式：干净开，不给它塞交接条', async () => {    const controller = fakeController()
    const done = await switchSession({
      getService: servicesOf({
        sessionController: controller,
        workingDirectory: { get: () => 'D:\\AI 项目\\聊天' },
        agentPresets: { presetForSession: () => 'standard' },
      }),
      api: { getConfig: () => ({ whaleWorkspaces: ['D:\\AI 项目\\聊天'] }), getState: () => ({}) },
      session: fakeSession(),
    })
    assert.equal(done.ok, true)
    assert.equal(done.mode, 'whale')
    assert.equal(done.seeded, false)
    assert.equal(controller.calls.prompt.length, 0)
  })

  it('建会话抛错：不算开成，把原因带出来', async () => {
    const done = await switchSession({
      getService: servicesOf({ sessionController: fakeController({ createError: new Error('宿主忙') }) }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession(),
    })
    assert.equal(done.ok, false)
    assert.equal(done.reason, 'create-failed')
    assert.match(done.detail, /宿主忙/u)
  })

  it('宿主没回会话编号：同样不算开成', async () => {
    const done = await switchSession({
      getService: servicesOf({ sessionController: fakeController({ sessionId: '' }) }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession(),
    })
    assert.equal(done.ok, false)
    assert.equal(done.reason, 'create-failed')
    assert.match(done.detail, /没回会话编号/u)
  })

  it('会话建成了、交接条没递进去：算开成，但说实话', async () => {
    const done = await switchSession({
      getService: servicesOf({ sessionController: fakeController({ promptError: new Error('队列不收') }) }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession(),
    })
    assert.equal(done.ok, true)
    assert.equal(done.seeded, false)
    assert.equal(done.reason, 'prompt-failed')
    assert.match(done.detail, /队列不收/u)
    assert.equal(done.sessionId, 'session-new-1')
  })

  it('这个宿主没有 prompt：会话照建，交接条递不了', async () => {
    const done = await switchSession({
      getService: servicesOf({ sessionController: fakeController({ noPrompt: true }) }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession(),
    })
    assert.equal(done.ok, true)
    assert.equal(done.reason, 'no-prompt')
    assert.equal(done.seeded, false)
  })

  it('预设读不到就用会话头里的，两个都没有就不带预设', async () => {
    const controller = fakeController()
    const withHeader = await switchSession({
      getService: servicesOf({
        sessionController: controller,
        agentPresets: { presetForSession: () => { throw new Error('读不到') } },
      }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: { id: 'session-old', header: { id: 'session-old', cwd: 'D:\\x', agentPreset: 'lab' } },
    })
    assert.equal(withHeader.preset, 'lab')

    const bare = await switchSession({
      getService: servicesOf({ sessionController: controller }),
      api: { getConfig: () => ({}), getState: () => ({}) },
      session: fakeSession(),
    })
    assert.equal(bare.preset, '')
  })
})

describe('promptSignal', () => {
  it('给出的是宿主认的 AbortSignal：能 throwIfAborted，默认不已经中止', () => {
    const signal = promptSignal()
    assert.equal(typeof signal?.throwIfAborted, 'function')
    assert.equal(signal.aborted, false)
    assert.doesNotThrow(() => signal.throwIfAborted())
  })

  it('到点会自己中止：别让递交接条这一步行无限期挂着', async () => {
    const signal = promptSignal(5)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(signal.aborted, true)
    assert.throws(() => signal.throwIfAborted())
  })
})
