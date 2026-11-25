/**
 * 客户端那一半的源码契约：清单入口、路由字符串、禁词与转义，
 * 以及宿主设置路由的挂法。最后两条是真的装配后打一次请求。
 *
 * 只读文件，不碰运行中的 profile。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'

import { BANNED } from '../lib/copy.js'
import { SETTINGS_ROUTE, registerSurface } from '../lib/host.js'
import { EDITABLE_KEYS, IDENTITY_KEYS } from '../lib/settings.js'

const read = (path) => readFileSync(new URL(path, new URL('../', import.meta.url)), 'utf8')
const manifest = JSON.parse(read('package.json'))
const client = read('lib/client.js')
const host = read('lib/host.js')
const entry = read('index.js')

/** 去掉注释，只留下会被执行的那部分。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')
}

function makeApi() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-contract-'))
  const configPath = join(dir, 'config.json')
  const config = { bot_name: 'whale' }
  const state = {
    revision: 5,
    selfName: { current: 'whale', history: [] },
    titleName: { current: '用户', history: [] },
    memory: { facts: [{ text: '一条事实' }], preferences: [], events: [], openTopics: [] },
    longMemory: [],
    traits: [],
    relationship: { commitments: [] },
  }
  writeFileSync(configPath, JSON.stringify(config), 'utf8')
  return {
    paths: { config: configPath },
    getConfig: () => config,
    getState: () => state,
    setConfig: () => ({ ok: true, config, warnings: [] }),
    buildView: () => ({ state: { revision: 5 } }),
  }
}

function makeCtx() {
  const routes = []
  const sections = []
  const ctx = {
    webServer: { register: (route) => (routes.push(route), () => {}) },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
    systemPrompt: { section: (spec) => (sections.push(spec), () => {}) },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  return { ctx, routes, sections }
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

describe('客户端清单与源码契约', () => {
  it('package.json 有 client 入口、web 平台和 bundle patch', () => {
    assert.equal(manifest.exports['./client'], './lib/client.js')
    assert.equal(manifest.exports['.'], './index.js')
    assert.equal(manifest.dsh.client.platform, 'web')
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
    assert.ok(Array.isArray(manifest.dsh.client.inject))
    for (const item of manifest.dsh.client.inject) assert.equal(typeof item, 'string')
  })

  // 这条是踩过坑的：靠 `if (ctx.x && ...)` 兜不住未注入的服务，
  // Cordis 的属性访问是 Proxy 抛错，守卫自己就会抛、后面几样全挂不上。
  it('入口 inject 声明了实际用到的五个服务', () => {
    const match = entry.match(/export const inject = \[([^\]]*)\]/)
    assert.ok(match, 'index.js 应该有 export const inject = [...]')
    const declared = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1])
    assert.deepEqual([...declared].sort(), ['commands', 'systemPrompt', 'tools', 'webServer', 'workspaceController'])
  })

  it('客户端只打七条文档相对路由，旧名字一个都不留', () => {
    const routes = [...client.matchAll(/["'](api\/[^"']+)["']/g)].map((match) => match[1])
    assert.deepEqual([...new Set(routes)].sort(), [
      'api/whale-pal/card/parse',
      'api/whale-pal/card/split',
      'api/whale-pal/pick',
      'api/whale-pal/scene',
      'api/whale-pal/settings',
      'api/whale-pal/status',
      'api/whale-pal/workspaces',
    ])
    for (const legacy of ['dsh-persona-framework', 'api/undo', 'PUT /config', '/api/whale-pal']) {
      assert.equal(client.includes(legacy), false, '客户端不该出现 ' + legacy)
    }
  })

  it('客户端没有 JSX、没有 \\u 转义、字符串里没有感叹号', () => {
    assert.equal(/<[A-Z]/.test(client), false, '不应该有 JSX')
    assert.equal(client.includes('react.createElement'), true, '应该走 createElement')
    assert.equal(/\\u[0-9a-fA-F]{4}/.test(client), false, '不应该有 \\u 转义')

    const code = stripComments(client)
    const literals = [...code.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)].map(
      (match) => match[1] ?? match[2],
    )
    assert.ok(literals.length > 20, '字符串字面量应当能扫出内容')
    const offenders = literals.filter((item) => item.includes('!') || item.includes('！'))
    assert.deepEqual(offenders, [])
    assert.deepEqual(
      BANNED.filter((word) => code.includes(word)),
      [],
    )
  })

  it('白名单只有一份来源，客户端那份和 settings.js 对齐', () => {
    assert.deepEqual([...EDITABLE_KEYS], [
      'vaultPath',
      'workRoot',
      'obsidianEnabled',
      'personaEnabled',
      'rejectServileAddress',
      'whaleWorkspaces',
      'name',
      'nameMeaning',
      'selfName',
      'selfNameMeaning',
      'title',
      'titleMeaning',
      'temperament',
      'values',
      'boundaries',
      'language',
      'summary',
      'personaCard',
    ])
    // 对话里那条改身份的路仍然只认六个身份键：价值观和边界不是它能动的。
    assert.deepEqual([...IDENTITY_KEYS], ['name', 'nameMeaning', 'selfName', 'selfNameMeaning', 'title', 'titleMeaning'])

    const declared = /const ALLOWED_KEYS = \[([^\]]*)\]/.exec(client)
    assert.ok(declared, '客户端应当把可改键列成一份名单')
    const keys = [...declared[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
    assert.deepEqual(keys, [...EDITABLE_KEYS])

    // 宿主不自带第二份名单：body 原样交给 settings.js 的白名单判。
    assert.equal(/EDITABLE_KEYS\s*=/.test(host), false)
    assert.equal(/ALLOWED_KEYS|WRITABLE_KEYS/.test(host), false)
    assert.match(host, /from '\.\/settings\.js'/)
    assert.match(host, /applySettings\(api, paths, body\)/)
  })

  it('前缀路由只挂 status / group / workspaces / health / settings / scene / card 两路 / picker / pick / ping 十一个分支', () => {
    assert.equal(SETTINGS_ROUTE, '/api/whale-pal')
    const branches = [...host.matchAll(/rest === '([^']+)'/g)].map((match) => match[1])
    assert.deepEqual(branches, [
      '/status',
      '/group',
      '/workspaces',
      '/health',
      '/settings',
      '/scene',
      '/card/parse',
      '/card/split',
      '/picker',
      '/pick',
      '/ping',
    ])
    assert.match(host, /return json\(res, 404, \{ ok: false, error: 'not-found' \}\)/)
  })
})

describe('装配后冒烟', () => {
  it('GET /status 200，六条只读 key 固定', async () => {
    const { ctx, routes } = makeCtx()
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    assert.equal(routes[0].path, SETTINGS_ROUTE)
    assert.equal(routes[0].kind, 'prefix')

    const result = await callRoute(surface.handler, { url: '/api/whale-pal/status' })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.deepEqual(
      result.json.identity.map((item) => item.key),
      [
        'name',
        'nameMeaning',
        'selfName',
        'selfNameMeaning',
        'title',
        'titleMeaning',
        'temperament',
        'values',
        'boundaries',
        'language',
        'summary',
      ],
    )
    assert.deepEqual(Object.keys(result.json.editable), [
      'vaultPath',
      'workRoot',
      'obsidianEnabled',
      'personaEnabled',
      'rejectServileAddress',
      'whaleWorkspaces',
    ])
    assert.equal(result.json.view.state.revision, 5)
  })

  it('POST {name} 改已填的槽位：200，回执带 applied', async () => {
    const { ctx } = makeCtx()
    const api = makeApi()
    const surface = registerSurface({ ctx, api, paths: api.paths, log: () => {} })

    const result = await callRoute(surface.handler, {
      url: '/api/whale-pal/settings',
      method: 'POST',
      body: { name: '鲸鲸' },
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.deepEqual(result.json.applied, ['name'])
  })

  it('人格开关关掉：模式与进度两段不出字，档案锚定块照旧注册', () => {
    const { ctx, sections } = makeCtx()
    const api = makeApi()
    registerSurface({ ctx, api, paths: api.paths, log: () => {} })
    const section = (name) => sections.find((item) => item.name === name)
    const mode = section('whale-pal/mode')
    const progress = section('whale-pal/progress')
    const anchor = section('whale-pal/anchor')
    assert.ok(mode && progress && anchor, '三段都该注册上')

    // 开着：模式段有字（助手模式下也至少给一句口径）。
    assert.notEqual(mode.text({}).trim(), '')

    // 关掉：配置一改，下一轮渲染立刻空。锚定块属于上下文压缩，不跟着关。
    api.getConfig().persona = { enabled: false }
    assert.equal(mode.text({}), '')
    assert.equal(progress.text(), '')
    assert.equal(typeof anchor.text(), 'string')
  })
})
