import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveDataPaths } from '../lib/paths.js'
import { applyPersona } from '../lib/persona/index.js'

// 15 个顶层键：迁移口径就是「一个不多、一个不少」。
// 2026-11-07 第四批加 memorySeq（记忆发号器，只增不回收）。
// 2026-11-15 加 memoryTombstones（淘汰留痕，只记编号/时间/原因，不留正文）。
// 2026-11-20 记忆分层 P0 加 scenes（场景树），P3 加 sceneRequests（通用层满了的请求）。
const STATE_KEYS = [
  'stateVersion', 'createdAt', 'updatedAt', 'revision', 'sessionOrdinal',
  'selfName', 'titleName', 'memory', 'scenes', 'sceneRequests', 'longMemory', 'memoryTombstones', 'memorySeq',
  'commitments', 'audit',
]

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'whale-pal-host-'))
}

function fakeContext() {
  const sections = []
  const routes = []
  const offs = []
  const ctx = {
    llm: { stream: async () => ({}) },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') offs.push(dispose)
    },
    on() {
      return () => {}
    },
    systemPrompt: {
      section(spec) {
        sections.push(spec)
        return () => {}
      },
    },
    webServer: {
      register(spec) {
        routes.push(spec)
        return () => {}
      },
    },
  }
  return { ctx, sections, routes }
}

function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

function setup() {
  const home = tempHome()
  const resolved = resolveDataPaths({ dshHome: home, profile: 'desktop' })
  const { ctx, sections, routes } = fakeContext()
  const api = applyPersona(ctx, { paths: resolved.paths, log: () => {} })
  return { home, resolved, ctx, sections, routes, api }
}

test('注入仍是两段，名字与顺序不变', () => {
  const { home, sections, api } = setup()
  try {
    assert.ok(api, '人格内核应当装配成功')
    // P1.5 之后多了模式段与首次设置段，人格那两段的位置与内容不许变。
    const persona = sections.filter((s) => s.name === 'whale-pal/kernel' || s.name === 'whale-pal/state')
    assert.deepEqual(persona.map((s) => s.name), ['whale-pal/kernel', 'whale-pal/state'])
    assert.deepEqual(persona.map((s) => s.order), [90, 91])
    for (const section of persona) assert.equal(section.interpolate, false)
    assert.equal(typeof persona[0].text(), 'string')
    assert.equal(typeof persona[1].text(), 'string')
    assert.equal(new Set(sections.map((s) => s.name)).size, sections.length, '同一段不该注册两次')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('人格开关关掉：内核与状态摘要两段都不出字，注册还在', () => {
  const { home, sections, api } = setup()
  try {
    const persona = sections.filter((s) => s.name === 'whale-pal/kernel' || s.name === 'whale-pal/state')
    assert.notEqual(persona[0].text(), '', '开着时内核那段该有字')
    api.setConfig({ ...api.getConfig(), persona: { enabled: false } }, 'test')
    assert.equal(persona[0].text(), '')
    assert.equal(persona[1].text(), '')
    // 数据一条没删：把开关拨回去，字立刻回来。
    api.setConfig({ ...api.getConfig(), persona: { enabled: true } }, 'test')
    assert.notEqual(persona[0].text(), '')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('状态落在 whale-pal 根，20 个顶层键一个不少', () => {
  const { home, resolved } = setup()
  try {
    assert.match(resolved.paths.root.replaceAll('\\', '/'), /\/whale-pal\/desktop$/)
    const state = JSON.parse(readFileSync(resolved.paths.state, 'utf8'))
    assert.deepEqual(Object.keys(state).sort(), [...STATE_KEYS].sort())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('HTTP 只剩 /ping 与 /state，写路由回 404', async () => {
  const { home, routes } = setup()
  try {
    assert.equal(routes.length, 1)
    const { path, handler } = routes[0]
    assert.equal(routes[0].kind, 'prefix')

    const ping = fakeRes()
    await handler({ url: `${path}/ping`, method: 'GET' }, ping)
    assert.equal(ping.statusCode, 200)
    assert.equal(JSON.parse(ping.body).ok, true)

    const state = fakeRes()
    await handler({ url: `${path}/state`, method: 'GET' }, state)
    assert.equal(state.statusCode, 200)
    assert.ok(JSON.parse(state.body).state)

    for (const [method, route] of [
      ['PUT', '/config'],
      ['POST', '/reset-state'],
      ['POST', '/rollback'],
      ['GET', '/history'],
      ['POST', '/trait/remove'],
    ]) {
      const res = fakeRes()
      await handler({ url: `${path}${route}`, method }, res)
      assert.equal(res.statusCode, 404, `${method} ${route} 应当已撤掉`)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('进程内入口带得动写能力，不靠 HTTP', () => {
  const { home, api } = setup()
  try {
    for (const key of ['getState', 'getConfig', 'setConfig', 'setState', 'buildView', 'settleCommitment', 'removeMemory']) {
      assert.equal(typeof api[key], 'function', `api.${key} 应当是函数`)
    }
    const before = api.getConfig()
    const result = api.setConfig({ ...before, bot_name: '六二' }, 'test')
    assert.equal(result.ok, true)
    assert.equal(result.config.bot_name, '六二')
    assert.equal(api.getConfig().bot_name, '六二')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
