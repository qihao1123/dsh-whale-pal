/**
 * 接线：设置路由、/whale 命令、whale_pal_identity 工具、模式一段提示，
 * 以及文案禁词扫描（融合计划 §13.6 起的那条可校验口径）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'

import { BANNED, COPY } from '../lib/copy.js'
import { ANCHOR_ORDER, ANCHOR_SECTION, MODE_ORDER, MODE_SECTION, PROGRESS_ORDER, PROGRESS_SECTION, SETTINGS_ROUTE, registerSurface } from '../lib/host.js'
import { resolveDataPaths } from '../lib/paths.js'
import { ctxRoot, writeCard } from '../lib/ctx/store.js'

function makeApi({ vaultPath = '', splitCard } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-surface-'))
  const configPath = join(dir, 'config.json')
  const statePath = join(dir, 'state.json')
  let config = vaultPath === '' ? { bot_name: 'whale' } : { bot_name: 'whale', knowledge: { vaultPath } }
  let state = {
    revision: 3,
    selfName: { current: 'whale', history: [] },
    titleName: { current: '用户', history: [] },
    memory: { facts: [], preferences: [], events: [], openTopics: [] },
    longMemory: [],
    traits: [],
    relationship: { commitments: [] },
  }
  writeFileSync(configPath, JSON.stringify(config), 'utf8')
  writeFileSync(statePath, JSON.stringify(state), 'utf8')
  return {
    paths: { config: configPath, state: statePath, runState: join(dir, 'run-state.json') },
    getConfig: () => config,
    getState: () => state,
    setConfig(next) {
      config = next
      writeFileSync(configPath, JSON.stringify(next), 'utf8')
      return { ok: true, config: next, warnings: [] }
    },
    setState(next) {
      state = next
      writeFileSync(statePath, JSON.stringify(next), 'utf8')
      return state
    },
    buildView: () => ({ state: { revision: state.revision } }),
    ...(typeof splitCard === 'function' ? { splitCard } : {}),
  }
}

function makeCtx() {
  const routes = []
  const commands = []
  const tools = []
  const sections = []
  const effects = []
  const ctx = {
    webServer: { register: (route) => (routes.push(route), () => {}) },
    commands: { register: (def) => (commands.push(def), () => {}) },
    tools: { register: (def) => (tools.push(def), () => {}) },
    systemPrompt: { section: (def) => (sections.push(def), () => {}) },
    effect(fn) {
      const dispose = fn()
      const owned = typeof dispose === 'function' ? dispose : () => {}
      effects.push(owned)
      return owned
    },
  }
  return { ctx, routes, commands, tools, sections, effects }
}

function callRoute(handler, { url, method = 'GET', body }) {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk ?? ''
    },
  }
  const req = {
    url,
    method,
    [Symbol.asyncIterator]() {
      return Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])[
        Symbol.asyncIterator
      ]()
    },
  }
  return handler(req, res).then(() => ({
    status: res.statusCode,
    json: res.body ? JSON.parse(res.body) : null,
  }))
}

describe('健康检查', () => {
  it('注册进 webServer 的那个 handler 才管用：/health 与 /status 带同一份报告', async () => {
    const { ctx, routes } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    // 关键：用 routes[0].handler，不是返回值里的 handler——
    // 线上跑的是注册进去的那个，测返回值会放过接线错误。
    const health = await callRoute(routes[0].handler, { url: '/api/whale-pal/health' })
    assert.equal(health.status === 200 || health.status === 503, true)
    assert.equal(typeof health.json.state, 'string')
    assert.equal(Array.isArray(health.json.steps), true)

    const status = await callRoute(routes[0].handler, { url: '/api/whale-pal/status' })
    assert.equal(status.status, 200)
    assert.equal(typeof status.json.health.state, 'string')
  })

  it('报告里的挂载数量对得上：路由 1、命令 1、工具 7、本层提示段 3', async () => {
    const { ctx, routes } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const health = await callRoute(routes[0].handler, { url: '/api/whale-pal/health' })
    const mounted = health.json.steps.find((step) => step.id === 'mounted')
    assert.match(mounted.detail, /routes 1/)
    assert.match(mounted.detail, /commands 1/)
    // 七样：whale_ctx、身份、台账、进度、回滚、健康、记忆取回。
    // 「打开笔记」并进 whale_ctx 的 action=open，「库版本」那支工具已删（版本在 /status 里）。
    assert.match(mounted.detail, /tools 7/)
    // systemPrompt 用 section() 挂载，数 register 会永远是 0。
    // 这里只算这一层注册的：模式 + 进度 + 锚定块；内核与状态两段由 applyPersona 注册。
    assert.match(mounted.detail, /sections 3/)
  })

  it('库版本不进工具了：/status 那一格还在，版本号仍从台账那一行读', async () => {
    const { ctx, routes } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const empty = await callRoute(routes[0].handler, { url: '/api/whale-pal/status' })
    assert.equal(empty.json.upgrade.ok, true)
    assert.equal(empty.json.upgrade.never, true)

    const vault = mkdtempSync(join(tmpdir(), 'whale-upgrade-ver-'))
    try {
      mkdirSync(join(vault, '台账'), { recursive: true })
      writeFileSync(
        join(vault, '台账', '事件.md'),
        '| 时间 | 类型 | 发生了什么 |\n| --- | --- | --- |\n| 2026-11-06T00:00:00Z | 任务 | 版本：V4.7 · 升级于 2026-11-06 | 待补 |\n',
        'utf8',
      )
      api.setConfig({ ...api.getConfig(), knowledge: { vaultPath: vault, vaultName: '库' } })
      const status = await callRoute(routes[0].handler, { url: '/api/whale-pal/status' })
      assert.equal(status.status, 200)
      assert.equal(status.json.upgrade.never, false)
      assert.equal(status.json.upgrade.vaultVersion, 'V4.7')
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('记忆取回工具：list / read / search 三个动作都走真 api 的状态', async () => {
    const { ctx, tools } = makeCtx()
    const api = makeApi()
    api.setState({
      ...api.getState(),
      memory: {
        facts: [
          { id: 'M-001', text: '用户的编辑器是 neovim', at: 1, session: 1, salience: 0.9, hits: 2 },
          { id: 'M-002', text: '用户讨厌客套话，要直接说', at: 1, session: 1, salience: 0.7, hits: 1 },
        ],
        preferences: [],
        events: [],
        openTopics: [],
      },
    })
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const memory = tools.find((tool) => tool.name === COPY.memoryToolName)
    assert.equal(Boolean(memory), true, '工具要挂上')

    const listed = await memory.execute({ action: 'list' })
    assert.equal(listed.ok, true)
    assert.equal(listed.total, 2)
    assert.deepEqual(listed.rows.map((row) => row.id), ['M-001', 'M-002'])
    // 目录不带正文。
    assert.equal(listed.rows[0].text, undefined)

    const read = await memory.execute({ action: 'read', id: 'M-001' })
    assert.equal(read.ok, true)
    assert.equal(read.text, '用户的编辑器是 neovim')
    // read 的渲染是可读文本，不是 JSON。
    const rendered = memory.output.render({ action: 'read' }, read)
    assert.equal(rendered[0].text.includes('用户的编辑器是 neovim'), true)
    assert.equal(rendered[0].text.startsWith('{'), false)

    const missing = await memory.execute({ action: 'read', id: 'M-404' })
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'not-found')

    const found = await memory.execute({ action: 'search', query: 'neovim' })
    assert.equal(found.ok, true)
    assert.equal(found.total, 1)
    assert.equal(found.rows[0].id, 'M-001')

    const bad = await memory.execute({ action: 'nope' })
    assert.equal(bad.ok, false)
  })

  it('只读降级时写入回 403，且不动文件', async () => {
    const { ctx, routes } = makeCtx()
    const api = makeApi()
    const root = mkdtempSync(join(tmpdir(), 'whale-health-ro-'))
    const blocker = join(root, 'not-a-dir')
    writeFileSync(blocker, 'x', 'utf8')
    const paths = { root: blocker, config: join(blocker, 'config.json') }
    registerSurface({ ctx, api, paths, log: () => {} })
    const result = await callRoute(routes[0].handler, {
      url: '/api/whale-pal/settings',
      method: 'POST',
      body: { obsidianEnabled: true },
    })
    assert.equal(result.status, 403)
    assert.equal(result.json.error, 'readonly-degraded')
  })
})

describe('设置路由', () => {
  it('GET /status 回四块', async () => {
    const { ctx, routes } = makeCtx()
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    assert.equal(routes[0].path, SETTINGS_ROUTE)
    assert.equal(SETTINGS_ROUTE, '/api/whale-pal')
    const result = await callRoute(surface.handler, { url: '/api/whale-pal/status' })
    assert.equal(result.status, 200)
    assert.equal(result.json.identity.length, 11)
    // 原文存档那一格：没存过是空串，页面据此显示「还没粘进来内容」。
    assert.equal(result.json.card.raw, '')
    assert.equal(result.json.readOnly, undefined)
    assert.deepEqual(result.json.editable.whaleWorkspaces.value, [])
    assert.equal(result.json.editable.linkMode, undefined)
    assert.ok(result.json.accounting)
    assert.equal(result.json.view.state.revision, 3)
  })

  it('POST /settings 改库名：这一格已经撤了，回 403 且不动配置', async () => {
    const { ctx } = makeCtx()
    const api = makeApi()
    const before = readFileSync(api.paths.config, 'utf8')
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/settings',
      method: 'POST',
      body: { vaultName: '我的库' },
    })
    assert.equal(result.status, 403)
    assert.equal(result.json.error, 'key-not-allowed')
    assert.equal(readFileSync(api.paths.config, 'utf8'), before)
  })

  it('POST /settings 改已填的名称：200，新值落盘', async () => {
    const { ctx } = makeCtx()
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/settings',
      method: 'POST',
      body: { name: '鲸鲸' },
    })
    assert.equal(result.status, 200)
    assert.deepEqual(result.json.applied, ['name'])
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).bot_name, '鲸鲸')
  })

  it('POST /settings 改白名单外的键：403', async () => {
    const { ctx } = makeCtx()
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/settings',
      method: 'POST',
      body: { assessor_mode: 'every-turn' },
    })
    assert.equal(result.status, 403)
    assert.equal(result.json.error, 'key-not-allowed')
  })

  it('POST /card/parse 拆一段：回十项 + 其余，不写盘', async () => {
    const { ctx } = makeCtx()
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const before = readFileSync(api.paths.config, 'utf8')
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/card/parse',
      method: 'POST',
      body: { raw: ['## 名称', '六一', '', '## 价值观', '自由、公平', '', '外貌：短发'].join('\n') },
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.fields.name, '六一')
    assert.equal(result.json.fields.values, '自由、公平')
    assert.equal(result.json.rest, '外貌：短发')
    assert.deepEqual(result.json.hits, ['name', 'values'])
    // 解析不落盘：这一步只是给人看清楚，写是下一条 /settings。
    assert.equal(readFileSync(api.paths.config, 'utf8'), before)
  })

  it('POST /card/parse 原文超长：400，不解析', async () => {
    const { ctx } = makeCtx()
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/card/parse',
      method: 'POST',
      body: { raw: 'x'.repeat(10001) },
    })
    assert.equal(result.status, 400)
    assert.equal(result.json.error, 'personaCard-too-long')
  })

  it('POST /card/split：宿主没这一格时回 503，不假装拆过', async () => {
    const { ctx } = makeCtx()
    // 老 api 没有 splitCard —— 页面点了按钮就该看到一句真话，而不是空结果。
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/card/split',
      method: 'POST',
      body: { raw: '名称：六一' },
    })
    assert.equal(result.status, 503)
    assert.equal(result.json.ok, false)
    assert.equal(result.json.message, COPY.cardSplitFailed)
  })

  it('POST /card/split：模型拆完把规则段落一起带回，段落不会凭空消失', async () => {
    const { ctx } = makeCtx()
    const api = makeApi({
      splitCard: async () => ({ ok: true, fields: { name: '六一' }, hits: ['name'], total: 40 }),
    })
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/card/split',
      method: 'POST',
      body: { raw: ['名称：六一', '', '外貌：黑色短发'].join('\n') },
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(result.json.fields.name, '六一')
    assert.equal(result.json.total, 40)
    // 模型那条只认十项；「没进内核」的段落靠规则拆这一份补上。
    assert.equal(result.json.rest, '外貌：黑色短发')
    assert.deepEqual(result.json.sections.map((item) => item.title), ['外貌'])
    // 规则拆到的那几项也一起回：模型跳过的项，页面拿它补，不用再请求一次。
    // 规则拆是十项平铺的，没认出的项是空串，页面按空白跳过。
    assert.equal(result.json.ruleFields.name, '六一')
    assert.equal(result.json.ruleFields.boundaries, '')
  })

  it('POST /card/split：模型交代的搬运账一起回给页面', async () => {
    const { ctx } = makeCtx()
    const api = makeApi({
      splitCard: async () => ({
        ok: true,
        fields: { name: '六一', language: '对普通网友保持边界' },
        hits: ['name', 'language'],
        total: 20,
        moves: [{ from: '和不同的人相处', to: 'language' }],
        unused: [{ from: '外貌', why: '没有对应项' }],
      }),
    })
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/card/split',
      method: 'POST',
      body: { raw: '名称：六一' },
    })
    assert.equal(result.status, 200)
    assert.deepEqual(result.json.moves, [{ from: '和不同的人相处', to: 'language' }])
    assert.deepEqual(result.json.unused, [{ from: '外貌', why: '没有对应项' }])
  })

  it('POST /card/split：模型没交代搬运账时给空数组，页面不用防 undefined', async () => {
    const { ctx } = makeCtx()
    const api = makeApi({
      splitCard: async () => ({ ok: true, fields: { name: '六一' }, hits: ['name'], total: 2 }),
    })
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/card/split',
      method: 'POST',
      body: { raw: '名称：六一' },
    })
    assert.equal(result.status, 200)
    assert.deepEqual(result.json.moves, [])
    assert.deepEqual(result.json.unused, [])
  })

  it('POST /card/split：失败时把原因接在话后面，不只说「读不懂」', async () => {
    const { ctx } = makeCtx()
    const api = makeApi({
      splitCard: async () => ({ ok: false, error: 'truncated', finish: 'max-tokens', chars: 812 }),
    })
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/card/split',
      method: 'POST',
      body: { raw: '名称：六一' },
    })
    assert.equal(result.status, 503)
    assert.equal(result.json.error, 'truncated')
    assert.equal(result.json.finish, 'max-tokens')
    assert.equal(result.json.chars, 812)
    assert.ok(result.json.message.includes('输出额度用完了'), '原因要能看出来')
  })

  it('POST /card/split：不认识的失败码原样带上，不吞成「读不懂」', async () => {
    const { ctx } = makeCtx()
    const api = makeApi({
      splitCard: async () => ({ ok: false, error: 'permission denied by upstream' }),
    })
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/card/split',
      method: 'POST',
      body: { raw: '名称：六一' },
    })
    assert.equal(result.status, 503)
    assert.ok(result.json.message.includes('permission denied by upstream'))
  })

  it('挂载写一笔 running，卸载写一笔 clean：退出标记真有人写', () => {
    const { ctx, effects } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    assert.equal(JSON.parse(readFileSync(api.paths.runState, 'utf8')).status, 'running', '启动这一笔不写，被杀就认不出来')
    // 卸载钩子由宿主托管：以前只放在返回值里，没人接，一次都没跑过。
    effects[effects.length - 1]()
    assert.equal(JSON.parse(readFileSync(api.paths.runState, 'utf8')).status, 'clean')
  })

  it('路由注册被顶掉：写进 health 的「没挂上」，不只打日志', () => {
    const { ctx } = makeCtx()
    const api = makeApi()
    const clashing = { ...ctx, webServer: { register: () => { throw new Error('webserver: duplicate prefix route "/api/whale-pal"') } } }
    const surface = registerSurface({ ctx: clashing, api, paths: api.paths, log: () => {} })
    assert.ok(surface.registered.warnings.join('；').includes('设置路由没挂上'))
    assert.ok(surface.health().steps.find((step) => step.id === 'mounted').detail.includes('设置路由没挂上'))
  })

  it('别的路径 404', async () => {
    const { ctx } = makeCtx()
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, { url: '/api/whale-pal/nope' })
    assert.equal(result.status, 404)
  })
})

describe('命令与工具', () => {
  it('/whale 注册上了，能按目录绑模式', () => {
    const { ctx, commands } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    assert.equal(commands[0].name, 'whale')
    const result = commands[0].handler({
      rawInput: 'mode whale',
      agent: { session: { header: { cwd: 'D:\\聊天' } } },
    })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /鲸鲸工作区/)
    assert.deepEqual(JSON.parse(readFileSync(api.paths.config, 'utf8')).whaleWorkspaces, ['D:\\聊天'])
  })

  // 命令这一路也走同一个 cwdOf：会话里 cd 过之后敲 /whale bind，绑的是当前目录，不是老的。
  it('/whale bind 绑的是工作目录投影里的当前目录', () => {
    const { ctx, commands } = makeCtx()
    const api = makeApi()
    const session = { header: { cwd: 'D:\\老目录' } }
    ctx.workingDirectory = { get: (s) => (s === session ? 'D:\\新目录' : '') }
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = commands[0].handler({ rawInput: 'bind', agent: { session } })
    assert.equal(result.kind, 'success')
    assert.deepEqual(JSON.parse(readFileSync(api.paths.config, 'utf8')).whaleWorkspaces, ['D:\\新目录'])
  })

  it('/whale mode 读不到工作目录时不瞎改', () => {
    const { ctx, commands } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = commands[0].handler({ rawInput: 'bind' })
    assert.equal(result.kind, 'error')
  })

  // 手动开新会话：跟自动那条同一个函数，编号由另一条消息递回来。
  // 命令结果里不留字：留了会一直挂在命令行上（第一版就长这样，看着像卡住）。
  it('/whale new 真开一个会话，并把编号回报到这个会话', async () => {
    const { ctx, commands } = makeCtx()
    const api = makeApi()
    const injected = []
    const calls = { create: [], prompt: [], signal: [] }
    ctx.sessionController = {
      create: async (request) => {
        calls.create.push(request)
        return { sessionId: 'session-new-9' }
      },
      prompt: async (request, signal) => {
        calls.prompt.push(request)
        calls.signal.push(signal)
        if (typeof signal?.throwIfAborted !== 'function') throw new TypeError('signal 没传')
        return { accepted: true }
      },
    }
    ctx.workingDirectory = { get: () => 'D:\\AI 项目\\插件dsh-whale-pal开发' }
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    const result = commands[0].handler({
      rawInput: 'new',
      agent: { session: { id: 'session-old', header: { cwd: 'D:\\AI 项目\\插件dsh-whale-pal开发' } }, inject: (m) => injected.push(m) },
    })
    assert.equal(result.kind, 'success')
    assert.equal(result.text, undefined)
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(calls.create.length, 1)
    assert.equal(calls.create[0].cwd, 'D:\\AI 项目\\插件dsh-whale-pal开发')
    assert.equal(calls.prompt.length, 1)
    assert.equal(typeof calls.signal[0]?.throwIfAborted, 'function')
    assert.match(calls.prompt[0].content[0].text, /用户手动 \/whale new 开的/u)
    assert.equal(injected.length, 2)
    assert.match(injected[0].content[0].text, /正在开新会话/u)
    assert.match(injected[1].content[0].text, /session-new-9/u)
  })

  it('/whale new 交接条没递进去时，把那句报错带出来', async () => {
    const { ctx, commands } = makeCtx()
    const api = makeApi()
    const injected = []
    ctx.sessionController = {
      create: async () => ({ sessionId: 'session-new-10' }),
      prompt: async () => {
        throw new Error('队列不收')
      },
    }
    ctx.workingDirectory = { get: () => 'D:\\x' }
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    commands[0].handler({
      rawInput: 'new',
      agent: { session: { id: 'session-old', header: { cwd: 'D:\\x' } }, inject: (m) => injected.push(m) },
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(injected.length, 2)
    assert.match(injected[1].content[0].text, /交接条没递进去：队列不收/u)
  })

  it('/whale new 开不成时如实说，不假装开了', async () => {
    const { ctx, commands } = makeCtx()
    const api = makeApi()
    const injected = []
    ctx.sessionController = {
      create: async () => {
        throw new Error('宿主忙')
      },
    }
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    const result = commands[0].handler({
      rawInput: 'new',
      agent: { session: { id: 'session-old', header: { cwd: 'D:\\x' } }, inject: (m) => injected.push(m) },
    })
    assert.equal(result.kind, 'success')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(injected.length, 2)
    assert.match(injected[1].content[0].text, /开新会话没成：create-failed/u)
  })

  // 2026-11-11 定的回执口径：成功不吭声，失败往会话里塞一行（用户原话「只让失败说话」）。
  // 跑的是注册进宿主的那个 handler：回执补在接线里，不在各条命令自己身上。
  it('/whale 失败时塞一行回执，成功一个字不加', () => {
    const { ctx, commands } = makeCtx()
    const api = makeApi()
    const injected = []
    const inject = (message) => injected.push(message)
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    const failed = commands[0].handler({ rawInput: 'mode 阴阳', agent: { inject } })
    assert.equal(failed.kind, 'error')
    assert.equal(injected.length, 1)
    assert.match(injected[0].content[0].text, /^\[whale-pal\] \/whale mode 阴阳 失败：/)

    const ok = commands[0].handler({
      rawInput: 'mode',
      agent: { session: { header: { cwd: 'D:\\聊天' } }, inject },
    })
    assert.equal(ok.kind, 'success')
    assert.equal(injected.length, 1, '成功不加回执')
  })

  it('/whale import 报得出旧状态导入的情况，回滚没确认就只报会丢什么', () => {
    const { ctx, commands } = makeCtx()
    const api = makeApi()
    const dir = mkdtempSync(join(tmpdir(), 'whale-surface-import-'))
    const resolved = resolveDataPaths({ dshHome: dir, profile: 'test', dataDir: join(dir, 'new'), legacyDir: join(dir, 'old') })
    registerSurface({
      ctx,
      api,
      paths: resolved.paths,
      legacy: resolved.legacy,
      base: resolved.base,
      importRecord: resolved.importRecord,
      log: () => {},
    })

    const said = commands[0].handler({ rawInput: 'import' })
    assert.equal(said.kind, 'success')
    assert.match(said.text, /旧状态导入/)
    assert.match(said.text, /不导：旧根里没有状态/, '全新机器要照实说没得导')

    const wild = commands[0].handler({ rawInput: 'import 瞎写' })
    assert.equal(wild.kind, 'error')
    assert.match(wild.text, /import 只认/)
  })

  it('/whale ledger 读得出台账；没库的时候照实说，不编', () => {
    const { ctx, commands } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    const said = commands[0].handler({ rawInput: 'ledger' })
    assert.equal(said.kind, 'success')
    // 夹具里没设库：那就该说「没处写」，不许报一堆 0 装成有账。
    assert.match(said.text, /台账|没设库/)
    const wild = commands[0].handler({ rawInput: 'ledger 瞎写' })
    assert.equal(wild.kind, 'error')
    assert.match(wild.text, /ledger 只认/)
  })

  it('导入报告传进来就往台账补一行，判断/结果/教训留空等隔天补', () => {
    const vault = mkdtempSync(join(tmpdir(), 'whale-ledger-vault-'))
    const { ctx } = makeCtx()
    const api = makeApi({ vaultPath: vault })
    registerSurface({
      ctx,
      api,
      paths: api.paths,
      log: () => {},
      importReport: {
        imported: true,
        at: '2026-11-05T00:00:00.000Z',
        counts: { revision: 7, facts: 1, preferences: 0, events: 0, openTopics: 0, longMemory: 2, traits: 1, commitments: 1 },
      },
    })

    const file = join(vault, '台账', '事件.md')
    assert.equal(existsSync(file), true, '导入这件事要留一条台账')
    const written = readFileSync(file, 'utf8')
    assert.match(written, /从旧插件目录导入状态/)
    assert.match(written, /revision 7/)
    assert.match(written, /短记忆 1 条/)
    // 当场不下定论：判断/结果/教训三格留「待补」，由模型隔天补。
    assert.match(written, /待补/)
  })

  it('whale_pal_ledger 挂上了：动作齐、类型收口在四样上', async () => {
    const { ctx, tools } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const tool = tools.find((item) => item.name === 'whale_pal_ledger')
    assert.ok(tool, '台账工具要在')
    assert.deepEqual(tool.parameters.properties.action.enum, ['status', 'preview', 'event', 'fill', 'deviation', 'dissent', 'settle'])
    assert.deepEqual(tool.parameters.properties.type.enum, ['任务', '纠正', '偏好', '观察'])

    const fifth = await tool.execute({ action: 'event', type: '第五种', what: '试试' }, {})
    assert.equal(fifth.ok, false, '第五种类型写不进去')
    const blank = await tool.execute({ action: '瞎写' }, {})
    assert.deepEqual(blank, { ok: false, error: 'bad-action' })
  })

  it('whale_pal_identity 填一格就落一格，理由必填', async () => {
    const { ctx, tools } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const tool = tools.find((item) => item.name === COPY.toolName)
    assert.ok(tool)
    assert.equal(COPY.toolName, 'whale_pal_identity')
    const refused = await tool.execute({ key: 'name', value: '小六' }, {})
    assert.equal(refused.ok, false)
    assert.equal(refused.error, 'reason-required')
    const value = await tool.execute(
      { key: 'nameMeaning', value: '随手起的', reason: '用户自己说的' },
      {},
    )
    assert.equal(value.ok, true)
    assert.deepEqual(value.applied, ['nameMeaning'])
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).identity.nameMeaning, '随手起的')
  })
})

describe('服务缺席', () => {
  it('ctx 上访问未注入的服务会抛错时，其余服务照常挂上、不抛', () => {
    const routes = []
    const sections = []
    const base = {
      webServer: { register: (route) => (routes.push(route), () => {}) },
      systemPrompt: { section: (def) => (sections.push(def), () => {}) },
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
    }
    // Cordis 的真实行为：未 inject 的服务属性访问直接抛错，不是 undefined。
    const declared = ['webServer', 'systemPrompt']
    const throwing = new Proxy(base, {
      get(target, key) {
        if (key in target) return target[key]
        if (typeof key !== 'string') return undefined
        if (declared.includes(key)) return target[key]
        throw new Error(`service "${key}" is not declared by your plugin`)
      },
    })
    const api = makeApi()
    const logs = []
    assert.doesNotThrow(() =>
      registerSurface({ ctx: throwing, api, paths: api.paths, log: (m) => logs.push(m) }),
    )
    assert.equal(routes.length, 1)
    assert.equal(sections.length, 3)
    assert.deepEqual(logs, [])
  })
})

describe('模式提示', () => {
  it('模式段、进度点段、锚定块段都在人格两段之后，顺序固定', () => {
    const { ctx, sections } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const names = sections.map((section) => section.name)
    assert.deepEqual(names, [MODE_SECTION, PROGRESS_SECTION, ANCHOR_SECTION])
    assert.deepEqual(sections.map((section) => section.order), [MODE_ORDER, PROGRESS_ORDER, ANCHOR_ORDER])
    for (const section of sections) assert.ok(section.order > 91)
  })

  // 档案总要有条路进上下文，不然摘要、索引、原文全躺在库里，模型一个字也看不见。
  it('锚定块进系统提示：带上抬头，只放目录', () => {
    const { ctx, sections } = makeCtx()
    const api = makeApi()
    const vault = mkdtempSync(join(tmpdir(), 'whale-anchor-vault-'))
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const anchor = sections.find((section) => section.name === ANCHOR_SECTION)
    // 没选库：这一格必须整段不出现，不能留一行空话。
    assert.equal(anchor.text(), '')
    api.getConfig().knowledge = { vaultPath: vault }
    // 选了库但库里还没卡片：还是空的（锚定块按需现算，不落盘，没卡片就算不出内容）。
    assert.equal(anchor.text(), '')
    // 卡片是唯一源：种两张卡，锚定块由它们现算出来，盘上不该有 锚定块.md。
    const seedCard = (id, blockId, at, keywords) => ({
      id,
      blockId,
      gen: 1,
      batch: 'B001',
      source: 'native',
      at,
      fields: { range: '1–2', topic: 'Primary', summary: 'Primary', keywords, unfinished: '无（自动压缩，原文没标）' },
    })
    writeCard(ctxRoot(vault), seedCard('C001', 'b-1', '2026-11-04T05:00:00Z', ['dsh', 'md']))
    writeCard(ctxRoot(vault), seedCard('C002', 'b-2', '2026-11-04T06:00:00Z', ['ctx', 'js']))
    assert.equal(existsSync(join(vault, '_上下文', '锚定块.md')), false, '锚定块不该再落盘')
    const text = anchor.text()
    assert.ok(text.startsWith(COPY.ctxAnchorHead), '抬头要写清楚这是目录')
    assert.ok(text.includes('C002 · Primary（ctx、js）'))
    assert.ok(text.includes('C001 · Primary（dsh、md）'))
    // 无时间戳：带了时间戳哈希每次都变，前缀缓存就白保了。
    assert.equal(/20\d\d-\d\d-\d\d|T\d\d:/.test(text), false)
  })

  // 2026-11-11：会话里 `cd` 过之后，模式要按**当前**目录算，不是建会话时那个。
  // 当前目录在 `workingDirectory` 服务的 session 投影里；header.cwd 只是原始目录。
  it('工作目录投影优先于会话头：cd 过去之后按新目录定模式', () => {
    const { ctx, sections } = makeCtx()
    const api = makeApi()
    api.setConfig({ ...api.getConfig(), whaleWorkspaces: ['D:\\AI 项目\\聊天'] })
    const session = { header: { cwd: 'D:\\AI 项目\\插件dsh-whale-pal开发' } }
    ctx.workingDirectory = { get: (s) => (s === session ? 'D:\\AI 项目\\聊天' : '') }
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const mode = sections.find((section) => section.name === MODE_SECTION)
    assert.match(mode.text({ agent: { session } }), /【模式】鲸鲸模式/u)
  })

  it('服务缺席或抛错时退回会话头，模式段不许整段断掉', () => {
    const { ctx, sections } = makeCtx()
    const api = makeApi()
    api.setConfig({ ...api.getConfig(), whaleWorkspaces: ['D:\\AI 项目\\聊天'] })
    ctx.workingDirectory = {
      get() {
        throw new Error('projection unavailable')
      },
    }
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const mode = sections.find((section) => section.name === MODE_SECTION)
    assert.match(mode.text({ agent: { session: { header: { cwd: 'D:\\AI 项目\\聊天' } } } }), /【模式】鲸鲸模式/u)
    assert.match(mode.text({ agent: { session: { header: { cwd: 'D:\\别处' } } } }), /【模式】助手模式/u)
    // 什么都没有（老调用方、没 agent）也不能抛。
    assert.match(mode.text(), /【模式】助手模式/u)
  })

  // 2026-11-11 真机取证：插件没 inject workingDirectory，直接取 `ctx.workingDirectory`
  // 在真宿主上会抛（测试里的假 ctx 是普通对象，抛不出来，所以一直没发现）。
  // 于是 cwdOf 只能退回 header.cwd —— 会话里 cd 过去模式也不变。
  it('服务只能经 ctx.get 拿到时，也要读得到工作目录投影', () => {
    const { ctx, sections } = makeCtx()
    const api = makeApi()
    api.setConfig({ ...api.getConfig(), whaleWorkspaces: ['D:\\AI 项目\\聊天'] })
    const session = { header: { cwd: 'D:\\AI 项目\\插件dsh-whale-pal开发' } }
    const workingDirectory = { get: (s) => (s === session ? 'D:\\AI 项目\\聊天' : '') }
    // 模拟真 Cordis：直接访问没注入的服务会抛，只能走 ctx.get。
    const proxied = new Proxy(ctx, {
      get(target, prop, receiver) {
        if (prop === 'get') return (name) => (name === 'workingDirectory' ? workingDirectory : undefined)
        if (prop === 'workingDirectory') throw new Error('service not injected')
        return Reflect.get(target, prop, receiver)
      },
    })
    registerSurface({ ctx: proxied, api, paths: api.paths, log: () => {} })
    const mode = sections.find((section) => section.name === MODE_SECTION)
    assert.match(mode.text({ agent: { session } }), /【模式】鲸鲸模式/u)
  })

  it('装配上下文里没带会话时，退回当前驱动的 agent 取目录', () => {
    const { ctx, sections } = makeCtx()
    const api = makeApi()
    api.setConfig({ ...api.getConfig(), whaleWorkspaces: ['D:\\AI 项目\\聊天'] })
    const session = { header: { cwd: 'D:\\AI 项目\\插件dsh-whale-pal开发' } }
    ctx.workingDirectory = { get: (s) => (s === session ? 'D:\\AI 项目\\聊天' : '') }
    ctx.agents = { currentInitiator: () => ({ session }) }
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const mode = sections.find((section) => section.name === MODE_SECTION)
    assert.match(mode.text({}), /【模式】鲸鲸模式/u)
  })
})

describe('进度点工具', () => {
  it('whale_pal_progress 推得动状态机，口令不对推不动', async () => {
    const { ctx, tools, sections } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const tool = tools.find((item) => item.name === COPY.progressToolName)
    assert.ok(tool, 'whale_pal_progress 应当注册上')
    assert.equal(COPY.progressToolName, 'whale_pal_progress')

    // 没开工时提示段是空的，不占一行空话。
    const progressSection = sections.find((section) => section.name === PROGRESS_SECTION)
    assert.equal(progressSection.text(), '')

    const begun = await tool.execute({ action: 'begin' }, {})
    assert.equal(begun.ok, true)
    assert.equal(begun.marker, 'Stage 1·未确认')
    assert.match(progressSection.text(), /Stage 1·未确认/u)

    // 「对」不算确认——这是 D4 那条不变量在代码里的样子。
    const loose = await tool.execute({ action: 'confirm', token: '对' }, {})
    assert.equal(loose.ok, false)
    assert.match(loose.ask, /确定stage/u)
    assert.match(progressSection.text(), /Stage 1·未确认/u)

    const wrong = await tool.execute({ action: 'confirm', token: '确定stage 2 阶段' }, {})
    assert.equal(wrong.ok, false)
    assert.equal(wrong.error, 'wrong-stage')

    const right = await tool.execute({ action: 'confirm', token: '确定stage 1 阶段' }, {})
    assert.equal(right.ok, true)
    assert.equal(right.marker, 'Stage 1·拆解·已完成')
    assert.equal(right.pending, 0)
  })
})

describe('文案禁词', () => {
  const sample = (value) => (typeof value === 'function' ? value('示例') : String(value))

  it('COPY 里每个字符串都干净', () => {
    const offenders = []
    for (const [key, value] of Object.entries(COPY)) {
      const text = sample(value)
      for (const word of BANNED) {
        if (text.includes(word)) offenders.push(`${key}:${word}`)
      }
      if (text.includes('!')) offenders.push(`${key}:!`)
    }
    assert.deepEqual(offenders, [])
  })

  it('客户端设置页的文案也过一遍（去掉注释再扫）', () => {
    const file = new URL('../lib/client.js', import.meta.url).pathname
    const path = process.platform === 'win32' ? file.replace(/^\//, '') : file
    if (!existsSync(path)) {
      assert.ok(true, '客户端设置页还没写，这一条等它落地后生效')
      return
    }
    const source = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ')
    const offenders = []
    for (const word of BANNED) if (source.includes(word)) offenders.push(word)
    assert.deepEqual(offenders, [])
  })
})

describe('目录选择', () => {
  function makePickerCtx(picker) {
    const base = makeCtx()
    const asked = []
    base.ctx.inject = (services, callback) => {
      asked.push([...services])
      return callback({ directoryPicker: picker })
    }
    return { ...base, asked }
  }

  it('宿主没 compose 选择器时 /pick 回 503，人话照旧', async () => {
    const { ctx, asked } = makePickerCtx(null)
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    // 只锁「有没有为选择器问宿主要过一次」：别的服务（投影）也会走可选注入，
    // 拿整张表下来比会跟着无关的接线一起红。
    assert.deepEqual(asked.filter((one) => one[0] === 'directoryPicker'), [['directoryPicker']])

    const picked = await callRoute(surface.handler, {
      url: '/api/whale-pal/pick',
      method: 'POST',
    })
    assert.equal(picked.status, 503)
    assert.equal(picked.json.error, 'picker-unavailable')
    assert.equal(picked.json.message, COPY.pickerUnavailable)

    const info = await callRoute(surface.handler, { url: '/api/whale-pal/picker' })
    assert.equal(info.status, 200)
    assert.equal(info.json.available, false)
  })

  it('选到目录回路径，用户关窗口回 null（不算错）', async () => {
    let answer = 'D:\笔记\鲸'
    const picker = {
      capability: () => ({ kind: 'native', pick: async () => answer }),
    }
    const { ctx } = makePickerCtx(picker)
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    const info = await callRoute(surface.handler, { url: '/api/whale-pal/picker' })
    assert.equal(info.json.available, true)
    assert.equal(info.json.kind, 'native')

    const chosen = await callRoute(surface.handler, {
      url: '/api/whale-pal/pick',
      method: 'POST',
    })
    assert.equal(chosen.status, 200)
    assert.equal(chosen.json.path, 'D:\笔记\鲸')

    answer = null
    const cancelled = await callRoute(surface.handler, {
      url: '/api/whale-pal/pick',
      method: 'POST',
    })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.json.path, null)
  })

  it('调 pick 时带 signal，不带会 TypeError（native 的 win32 第一行就读它）', async () => {
    const seen = []
    const picker = {
      capability: () => ({
        kind: 'native',
        pick: async (signal) => {
          seen.push(signal)
          return 'D:\\笔记\\鲸'
        },
      }),
    }
    const { ctx } = makePickerCtx(picker)
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    const chosen = await callRoute(surface.handler, {
      url: '/api/whale-pal/pick',
      method: 'POST',
    })
    assert.equal(chosen.status, 200)
    assert.equal(seen.length, 1)
    assert.equal(typeof seen[0]?.aborted, 'boolean')
    assert.equal(seen[0].aborted, false)
  })

  it('capability 不是 native 就当没有，选目录不抛错', async () => {
    const picker = { capability: () => ({ kind: 'browse', pick: async () => '/x' }) }
    const { ctx } = makePickerCtx(picker)
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    const info = await callRoute(surface.handler, { url: '/api/whale-pal/picker' })
    assert.equal(info.json.available, false)

    const picked = await callRoute(surface.handler, {
      url: '/api/whale-pal/pick',
      method: 'POST',
    })
    assert.equal(picked.status, 503)
  })

  it('pick 抛错时回 500 和一句人话，不把栈给页面', async () => {
    const picker = {
      capability: () => ({
        kind: 'native',
        pick: async () => {
          throw new Error('dialog crashed at 0x1234')
        },
      }),
    }
    const { ctx } = makePickerCtx(picker)
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    const picked = await callRoute(surface.handler, {
      url: '/api/whale-pal/pick',
      method: 'POST',
    })
    assert.equal(picked.status, 500)
    assert.equal(picked.json.error, 'picker-failed')
    assert.equal(picked.json.message, COPY.pickerFailed)
    assert.equal(JSON.stringify(picked.json).includes('0x1234'), false)
  })

  it('/status 带上 picker 这一格，页面才知道按钮能不能点', async () => {
    const picker = { capability: () => ({ kind: 'native', pick: async () => null }) }
    const { ctx } = makePickerCtx(picker)
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const result = await callRoute(surface.handler, { url: '/api/whale-pal/status' })
    assert.equal(result.status, 200)
    assert.equal(result.json.picker.available, true)
    assert.equal(result.json.picker.kind, 'native')
  })
})

describe('一键回滚工具', () => {
  function setup() {
    const api = makeApi()
    const { ctx, tools } = makeCtx()
    const root = join(api.paths.config, '..')
    registerSurface({ ctx, api, paths: { ...api.paths, root }, log: () => {} })
    return { root, tool: tools.find((item) => item.name === COPY.rollbackToolName) }
  }

  it('退回最近一份备份，并说清退到哪一份', async () => {
    const { root, tool } = setup()
    const target = join(root, 'notes.md')
    writeFileSync(target, '好的版本', 'utf8')
    writeFileSync(`${target}.bak-2026-01-01T00-00-00-000Z`, '好的版本', 'utf8')
    writeFileSync(target, '被写坏了', 'utf8')
    const result = await tool.execute({ path: target })
    assert.equal(result.ok, true)
    assert.equal(result.message, COPY.rollbackDone)
    assert.ok(result.backup.endsWith('2026-01-01T00-00-00-000Z'))
    assert.equal(readFileSync(target, 'utf8'), '好的版本')
  })

  it('范围外的路径一律拒：这是能删人东西的动作', async () => {
    const { tool } = setup()
    const result = await tool.execute({ path: 'C:/Windows/System32/drivers/etc/hosts' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'path-not-allowed')
    assert.equal(result.message, COPY.rollbackOutside)
  })

  it('相对路径也拒，不靠当前目录猜', async () => {
    const { tool } = setup()
    const result = await tool.execute({ path: 'notes.md' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'path-required')
  })

  it('没有备份就不动，也不假装退了', async () => {
    const { root, tool } = setup()
    const target = join(root, 'fresh.md')
    writeFileSync(target, '只有一份', 'utf8')
    const result = await tool.execute({ path: target })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-backup')
    assert.equal(result.message, COPY.rollbackNoBackup)
    assert.equal(readFileSync(target, 'utf8'), '只有一份')
  })
})

describe('笔记库接线', () => {
  function setup(extra = {}) {
    const api = makeApi()
    const { ctx, routes, tools } = makeCtx()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const handler = routes[0].handler
    return { api, handler, surface, tool: tools.find((item) => item.name === COPY.ctxToolName), ...extra }
  }

  it('GET /status 带上笔记库那一格：装没装、接没接、库名、有没有路径', async () => {
    const { handler } = setup()
    const result = await callRoute(handler, { url: `${SETTINGS_ROUTE}/status` })
    assert.equal(result.status, 200)
    const info = result.json.obsidian
    assert.equal(typeof info.enabled, 'boolean')
    assert.equal(info.enabled, false)
    assert.equal(info.hasVault, false)
    assert.equal(info.vaultName, '记忆空间')
    assert.ok(['installed', 'absent', 'ready', 'installed-no-vault', 'running-no-config'].includes(info.state))
    assert.equal(typeof info.label, 'string')
  })

  it('whale_ctx 的 open：有库就回深链，路径里带编码', async () => {
    const { api, tool } = setup()
    api.setConfig({ ...api.getConfig(), knowledge: { vaultPath: api.paths.config, vaultName: '记忆空间' } })
    const result = await tool.execute({ action: 'open', relPath: '日记/2026-11-03.md' })
    assert.equal(result.ok, true)
    assert.equal(
      result.link,
      'obsidian://open?vault=%E8%AE%B0%E5%BF%86%E7%A9%BA%E9%97%B4&file=%E6%97%A5%E8%AE%B0%2F2026-11-03',
    )
  })

  it('whale_ctx 的 open：没库就拒，不拼一个必然打不开的链接', async () => {
    const { tool } = setup()
    const result = await tool.execute({ action: 'open', relPath: '日记/2026-11-03.md' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'vaultPath-required')
    assert.equal(result.message, '还没填笔记库路径，库相关的事都做不了')
  })

  it('whale_ctx 的 open：路径空着也拒，不打开库根目录', async () => {
    const { api, tool } = setup()
    api.setConfig({ ...api.getConfig(), knowledge: { vaultPath: api.paths.config } })
    const result = await tool.execute({ action: 'open', relPath: '   ' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'relPath-required')
    assert.equal(result.message, COPY.relPathRequired)
  })
})
