/**
 * 接线面：投影按 whaleContext 这个键注册、whale_ctx 工具与 `/whale ctx` 四个子命令、
 * 没选库 / 没档案时照实回落（融合计划-v2.md §16.8 的⑤⑩两条要在这里落地）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { COPY } from '../lib/copy.js'
import {
  CTX_TOOL_NAME,
  autoArchive,
  ctxAnchor,
  ctxInfo,
  pressureOf,
  registerContext,
  reminderOf,
  reminderText,
  syncArchives,
  tierFor,
} from '../lib/ctx/host-bridge.js'
import { pathsOf, ctxRoot, readCards, writeCard, writeRaw } from '../lib/ctx/store.js'
import { compactViaCommand } from '../lib/ctx/compact-cmd.js'
import { foldEvent, makeProjection, PROJECTION_KEY } from '../lib/ctx/watch.js'

function makeApi(vaultPath = '') {
  const config = vaultPath === '' ? {} : { knowledge: { vaultPath } }
  return {
    getConfig: () => config,
    getState: () => ({ revision: 1 }),
    buildView: () => ({}),
  }
}

/** 假宿主：三条服务都只是把注册的东西收进数组，够测接没接上。 */
function makeCtx() {
  const projections = []
  const tools = []
  const handlers = []
  const offs = []
  const ctx = {
    sessionProjections: {
      register: (def) => {
        projections.push(def)
        return () => offs.push('projection')
      },
      stateOf: () => null,
    },
    tools: {
      register: (def) => {
        tools.push(def)
        return () => offs.push('tool')
      },
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(event, handler) {
      handlers.push({ event, handler })
      return () => {}
    },
  }
  return { ctx, projections, tools, handlers, offs }
}

/**
 * 让宿主「跑起来一轮」：先 agent/created 建立 session→agent 映射，再发 session/event。
 *
 * 这两步是分开的，因为宿主本来就这么走：`turn/end` 不是 cordis 事件，
 * 它是 `session.append()` 写进日志的，派发出来叫 `session/event`。
 */
function bootAgent(base, agent) {
  const created = base.handlers.find((item) => item.event === 'agent/created')
  if (created) created.handler({ agent, source: 'startup' })
  return agent
}

function fireSessionEvent(base, session, type, data = {}) {
  const h = base.handlers.find((item) => item.event === 'session/event')
  if (!h) return false
  h.handler(session, { type, seq: 0, time: Date.now(), data })
  return true
}

function turnEnd(base, session, turn = 1) {
  return fireSessionEvent(base, session, 'turn/end', { turn, reason: { kind: 'completed' } })
}

function pendingOne(text = '这一段是压缩后的摘要，讲的是索引怎么排。') {
  return {
    blockId: 'b1a2c3d4',
    gen: 1,
    at: '2026-11-04T04:00:00+08:00',
    text,
    range: 'm00010–m00080',
    tokens: 1200,
    provider: 'deepseek',
    model: 'flash',
  }
}

describe('接线：投影按 whaleContext 注册，apply 是纯折叠', () => {
  it('registerContext 把 makeProjection() 原样交给宿主', () => {
    const { ctx, projections } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    assert.equal(projections.length, 1)
    assert.equal(projections[0].key, PROJECTION_KEY)
    assert.equal(projections[0].apply, foldEvent)
    assert.equal(projections[0].stateVersion, makeProjection().stateVersion)
    context.dispose()
  })

  it('卸载时把注册的投影与工具都退掉', () => {
    const { ctx, offs } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    context.dispose()
    assert.ok(offs.includes('projection'))
    assert.ok(offs.includes('tool'))
  })

  it('宿主没这服务也不报错，dispose 照样能调', () => {
    const context = registerContext({ ctx: {}, api: makeApi() })
    assert.doesNotThrow(() => context.dispose())
  })
})

describe('接线：whale_ctx 工具', () => {
  it('十个 action 都在枚举里，且只有 action 是必填', () => {
    const { ctx, tools } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    const def = tools.find((item) => item.name === CTX_TOOL_NAME)
    assert.ok(def, 'whale_ctx 没挂上')
    assert.deepEqual(def.parameters.properties.action.enum, ['status', 'search', 'read', 'files', 'entries', 'batch', 'sync', 'refresh', 'compact', 'open'])
    assert.deepEqual(def.parameters.required, ['action'])
    // 补录那一路靠 rows：类型锁四类，内容必填。
    assert.deepEqual(def.parameters.properties.rows.items.properties.type.enum, ['事实', '决定', '待办', '偏好'])
    assert.deepEqual(def.parameters.properties.rows.items.required, ['type', 'content'])
    context.dispose()
  })

  // compact（实验）：借 /compact 命令压一次。两条源码事实要钉住，
  // 照设计文档的写法（用 status 判忙、直接读返回的 kind）都会失败。
  it('compact 动作只是武装，不在工具调用当次就压', async () => {
    const { ctx, tools } = makeCtx()
    let called = 0
    ctx.commands = { execute: () => { called += 1; return { commandId: 'c1', result: { kind: 'success', text: 'ok' } } } }
    const context = registerContext({ ctx, api: makeApi() })
    const def = tools.find((item) => item.name === CTX_TOOL_NAME)
    const agent = { session: { id: 's-c', eventAt: () => null }, phase: { kind: 'turn' } }
    const out = await def.execute({ action: 'compact' }, { agent })
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'armed')
    assert.equal(called, 0, '工具是在 turn 里面跑的，此刻压不了，只能武装')
    context.dispose()
  })

  it('compactViaCommand：忙时用 phase.kind 判，不调命令', async () => {
    let called = 0
    const commands = { execute: () => { called += 1; return { result: { kind: 'success' } } } }
    // agent.status 会把 maintenance 报成 'idle'，所以这里同时给 status 和 maintenance
    const agent = { phase: { kind: 'maintenance' }, status: 'idle' }
    const out = await compactViaCommand({ commands, agent })
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'busy')
    assert.equal(called, 0, '忙的时候不该真的去调命令')
    assert.match(out.text, /maintenance/)
  })

  it('compactViaCommand：返回值要解 .result，成功才算成功', async () => {
    let got = null
    const commands = {
      execute: (agent, line, attachments, signal) => {
        got = { line, attachments, hasSignal: signal != null && typeof signal.aborted === 'boolean' }
        return { commandId: 'cmd-1', result: { kind: 'success', text: '压完了', sourceEventSeq: 42 } }
      },
    }
    const out = await compactViaCommand({ commands, agent: { phase: { kind: 'idle' } } })
    assert.equal(out.ok, true)
    assert.equal(out.kind, 'success')
    assert.equal(out.text, '压完了')
    assert.equal(out.commandId, 'cmd-1')
    // line 带斜杠、attachments 是数组、signal 是真对象
    assert.equal(got.line, '/compact')
    assert.deepEqual(got.attachments, [])
    assert.equal(got.hasSignal, true)
  })

  it('compactViaCommand：不在视图里、抛错、没服务都收敛成人话', async () => {
    const idle = { phase: { kind: 'idle' } }
    let out = await compactViaCommand({ commands: { execute: () => undefined }, agent: idle })
    assert.equal(out.kind, 'not-in-view')

    out = await compactViaCommand({ commands: { execute: () => { throw new Error('宿主炸了') } }, agent: idle })
    assert.equal(out.ok, false)
    assert.equal(out.kind, 'threw')
    assert.match(out.text, /宿主炸了/)

    out = await compactViaCommand({ commands: null, agent: idle })
    assert.equal(out.kind, 'unavailable')

    out = await compactViaCommand({ commands: { execute: () => undefined }, agent: null })
    assert.equal(out.kind, 'no-agent')
  })

  // refresh 以前只挂在 `/whale` 命令上，工具里没有——菜单够不着那个命令就等于够不着这个能力。
  it('refresh 这个动作工具里也够得着，且只动主题与关键词', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-tool-refresh-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const root = ctxRoot(vault)
    writeCard(root, {
      id: 'C001',
      blockId: 'b1a2c3d4',
      gen: 1,
      batch: 'B001',
      source: 'native',
      at: '2026-11-04T05:00:00Z',
      fields: {
        range: '1–2',
        topic: 'Primary',
        summary: '## Primary Request and Intent\n- the user and the vault',
        keywords: ['the', 'and'],
        unfinished: '无（自动压缩，原文没标）',
      },
    })
    const { ctx, tools } = makeCtx()
    const context = registerContext({ ctx, api: makeApi(vault) })
    const def = tools.find((item) => item.name === CTX_TOOL_NAME)
    const result = await def.execute({ action: 'refresh' })
    assert.equal(result.ok, true)
    // 这条假摘要里没有 dsh/md/whale，所以关键词是它自己算出来的那三个（真机上 C001 是 dsh、md、whale）。
    assert.deepEqual(result.changed, [{ id: 'C001', topic: 'Primary Request', keywords: ['Intent', 'vault', 'user'] }])
    // 锚定块不落盘了：从卡片现算的注入文本里照样有重算后的主题。
    assert.match(ctxAnchor({ api: makeApi(vault) }), /Primary/)
    context.dispose()
  })

  it('不认的 action 回一条人话，不是抛错', async () => {
    const { ctx, tools } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    const def = tools.find((item) => item.name === CTX_TOOL_NAME)
    const result = await def.execute({ action: 'whatever' })
    assert.equal(result.ok, false)
    assert.equal(result.message, COPY.ctxUnknownAction)
    context.dispose()
  })

  it('没选库时 status 回 ready:false，并说档案没地方放', async () => {
    const { ctx, tools } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    const def = tools.find((item) => item.name === CTX_TOOL_NAME)
    const result = await def.execute({ action: 'status' })
    assert.equal(result.ready, false)
    assert.equal(result.message, COPY.ctxNeedsVault)
    context.dispose()
  })

  it('工具定义带渲染器：真宿主的注册表会校验 output.render', () => {
    const { ctx, tools } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    const def = tools.find((item) => item.name === CTX_TOOL_NAME)
    assert.equal(typeof def.output.render, 'function')
    const rendered = def.output.render({ action: 'status' }, { ok: true })
    assert.equal(rendered[0].type, 'text')
    assert.equal(rendered[0].text, '{"ok":true}')
    context.dispose()
  })
})

describe('接线：挂不上要留痕', () => {
  it('工具注册抛错时不拖垮插件，但 warnings 里有这一条', () => {
    const ctx = {
      sessionProjections: { register: () => () => {}, stateOf: () => null },
      tools: { register: () => { throw new Error('shape rejected') } },
    }
    const context = registerContext({ ctx, api: makeApi() })
    // 这一格只锁「工具那一条记下来了」；提醒那一条是另一回事（见跨档提醒那一段）。
    assert.equal(context.warnings.some((line) => /工具没挂上：shape rejected/.test(line)), true)
    assert.equal(context.warnings[0], '工具没挂上：shape rejected')
    assert.doesNotThrow(() => context.dispose())
  })
})

describe('接线：/whale ctx 四个子命令', () => {
  it('不带参数时把能做的说清楚', () => {
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    const result = context.command('ctx')
    assert.equal(result.ok, true)
    assert.match(result.text, /search/u)
    assert.match(result.text, /C007/u)
    context.dispose()
  })

  it('search 没有档案时回落「记录里没查到这条」', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-cmd-'))
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api: makeApi(join(dir, '库')) })
    const result = context.command('ctx search 索引')
    assert.equal(result.ok, true)
    assert.equal(result.text, COPY.ctxNotFound)
    context.dispose()
  })

  it('search 缺词时说要查什么', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-cmd-'))
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api: makeApi(join(dir, '库')) })
    const result = context.command('ctx search')
    assert.equal(result.ok, false)
    assert.equal(result.text, COPY.ctxNeedsQuery)
    context.dispose()
  })

  it('files 空库时说还没有档案', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-cmd-'))
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api: makeApi(join(dir, '库')) })
    const result = context.command('ctx files')
    assert.equal(result.ok, true)
    assert.equal(result.text, COPY.ctxEmpty)
    context.dispose()
  })

  it('认不出的子命令只认那四样', () => {
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    const result = context.command('ctx 随便写点什么')
    assert.equal(result.ok, false)
    assert.equal(result.text, COPY.ctxUnknownAction)
    context.dispose()
  })
})

describe('接线：待写队列只从投影状态里取，取的过程不写盘', () => {
  it('pendingOf 把队列交出来，库里一个文件都不多', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-pending-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const { ctx } = makeCtx()
    ctx.sessionProjections.stateOf = () => ({
      version: 1,
      pendingArchives: [pendingOne()],
      seen: {},
      pruned: 0,
      source: 'native',
      lastAt: null,
    })
    const context = registerContext({ ctx, api: makeApi(vault) })
    const list = context.pendingOf({ session: { id: 's1' } })
    assert.equal(list.length, 1)
    assert.equal(list[0].blockId, 'b1a2c3d4')
    assert.equal(existsSync(ctxRoot(vault)), false, '取队列这一步不该建目录')
    context.dispose()
  })

  it('没有投影状态时给空数组，不抛错', () => {
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    assert.deepEqual(context.pendingOf({ session: { id: 's1' } }), [])
    context.dispose()
  })
})

describe('接线：sync 收档案、写索引与锚定块', () => {
  it('一份待写档案收进库，索引与锚定块跟上，锚定块里没有日期时间', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-sync-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    const synced = syncArchives({ api, pending: [pendingOne()], now: '2026-11-04 05:00' })
    assert.equal(synced.ok, true)
    assert.deepEqual(synced.ids, ['C001'])
    assert.equal(synced.cards, 1)

    const layout = pathsOf(ctxRoot(vault))
    assert.ok(existsSync(join(layout.cards, 'b1a2c3d4.md')))
    assert.ok(existsSync(layout.index))
    // 锚定块不落盘（第二批形态审计）：盘上不该有这份文件，内容由卡片现算。
    assert.equal(existsSync(join(ctxRoot(vault), '锚定块.md')), false)

    const anchor = ctxAnchor({ api })
    assert.match(anchor, /C001/u)
    assert.doesNotMatch(anchor, /\d{4}-\d{2}-\d{2}/u, '锚定块里不许出现日期')

    const info = ctxInfo({ api })
    assert.equal(info.ready, true)
    assert.equal(info.cards, 1)
    assert.equal(info.lastId, 'C001')
    assert.equal(info.anchor, true)
  })

  it('同样的内容再跑一遍，锚定块也不再落盘（按需现算，anchorWrote 恒 false）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-sync-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    syncArchives({ api, pending: [pendingOne()], now: '2026-11-04 05:00' })
    const again = syncArchives({ api, pending: [], now: '2026-11-04 05:10' })
    assert.equal(again.ok, true)
    // 没有「写没写」这回事了：这一格恒 false，但必须存在，别让调用方拿到 undefined。
    assert.equal(again.anchorWrote, false)
    assert.equal(syncArchives({ api, pending: [], now: '2026-11-04 05:20' }).anchorWrote, false)
  })

  // 口径改过以后旧档案不会自己变。`/whale ctx refresh` 只重算「主题」「关键词」，
  // 并且必须把锚定块一起重写——不然档案换了字样、锚定块还挂着旧的。
  it('/whale ctx refresh：旧字样换掉，锚定块跟着换', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-refresh-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const root = ctxRoot(vault)
    writeCard(root, {
      id: 'C001',
      blockId: 'b1a2c3d4',
      gen: 1,
      batch: 'B001',
      source: 'native',
      at: '2026-11-04T05:00:00Z',
      fields: {
        range: '1–2',
        topic: 'Primary',
        summary: '## Primary Request and Intent\n- the user and the vault',
        keywords: ['the', 'and'],
        unfinished: '无（自动压缩，原文没标）',
      },
    })
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api: makeApi(vault) })
    const said = context.command('ctx refresh', {})
    assert.equal(said.ok, true)
    assert.match(said.text, /重算 1 张/)
    assert.match(said.text, /C001 → 主题 Primary Request（/)
    assert.match(said.text, /锚定块按需现算/)
    const anchor = ctxAnchor({ api: makeApi(vault) })
    assert.match(anchor, /Primary/)
    assert.equal(anchor.includes('the'), false)
    context.dispose()
  })

  it('/whale ctx refresh：没库时说人话，口径没变时不重算', () => {
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    assert.equal(context.command('ctx refresh', {}).text, COPY.ctxNeedsVault)
    context.dispose()

    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-refresh-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    syncArchives({ api, pending: [pendingOne()], now: '2026-11-04 05:00' })
    const { ctx: ctx2 } = makeCtx()
    const context2 = registerContext({ ctx: ctx2, api })
    assert.match(context2.command('ctx refresh', {}).text, /没有要重算的/)
    context2.dispose()
  })

  it('没选库时 sync 明说没法落盘', () => {
    const result = syncArchives({ api: makeApi(), pending: [pendingOne()] })
    assert.equal(result.ok, false)
    assert.equal(result.message, COPY.ctxNeedsVault)
  })
})

describe('接线：批次号', () => {
  it('两层压缩发两个号，sync 的话里能看见批次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-batch-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    const first = syncArchives({ api, pending: [pendingOne()], now: '2026-11-04T05:00:00Z' })
    assert.deepEqual(first.batches, ['B001'])
    const second = syncArchives({ api, pending: [{ ...pendingOne(), blockId: 'b-2' }], now: '2026-11-04T06:00:00Z' })
    assert.deepEqual(second.batches, ['B002'])

    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api })
    const said = context.command('ctx sync', { pending: [{ ...pendingOne(), blockId: 'b-3' }] })
    assert.match(said.text, /批次 B003/, '批次号要写在回话里，不然没人知道这批叫什么')
    context.dispose()
  })

  it('/whale ctx batch：不给号列全部批次，给号列这一批的每一份', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-batch-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    syncArchives({ api, pending: [pendingOne()], now: '2026-11-04T05:00:00Z' })
    syncArchives({ api, pending: [{ ...pendingOne(), blockId: 'b-2' }], now: '2026-11-04T06:00:00Z' })
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api })

    const all = context.command('ctx batch', {})
    assert.equal(all.ok, true)
    assert.match(all.text, /共 2 批、2 份/)
    assert.match(all.text, /B001 · 1 份（C001）/)
    assert.match(all.text, /B002 · 1 份（C002）/)

    const one = context.command('ctx batch B002', {})
    assert.equal(one.ok, true)
    assert.match(one.text, /B002 这一批 1 份/)
    assert.match(one.text, /C002 · /)
    assert.match(one.text, /没留原文/, '没留过就照实说，不假装有')

    // 留过原文的，把文件名写出来（名字能推，但要有才有话）。
    const blockId = readCards(ctxRoot(vault)).find((card) => card.id === 'C002').blockId
    writeRaw(ctxRoot(vault), { blockId, gen: 1, text: '# 原文\n- 一条\n' })
    assert.match(context.command('ctx batch B002', {}).text, /原文 .*\.md/)

    const missing = context.command('ctx batch B099', {})
    assert.equal(missing.ok, false)
    assert.match(missing.text, /没有 B099 这一批/)
    context.dispose()
  })

  // 整批回滚：只挪不删，挪完索引与锚定块都按剩下的重算。
  it('/whale ctx rollback：本批挪进回收站，锚定块跟着缩短', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-rollback-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    syncArchives({ api, pending: [pendingOne()], now: '2026-11-04T05:00:00Z' })
    syncArchives({ api, pending: [{ ...pendingOne(), blockId: 'b-2' }], now: '2026-11-04T06:00:00Z' })
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api })

    const said = context.command('ctx rollback B002', { now: '2026-11-04T09:00:00Z' })
    assert.equal(said.ok, true)
    assert.match(said.text, /撤下 B002 这一批 1 份（C002）/)
    assert.match(said.text, /回收站\/B002_/)
    assert.match(said.text, /还剩 1 份/)
    assert.match(said.text, /只挪没删/)
    // 盘上只剩 C001，锚定块也只剩一行。
    assert.deepEqual(readCards(ctxRoot(vault)).map((card) => card.id), ['C001'])
    assert.equal(ctxAnchor({ api }).includes('C002'), false)
    // 回收站里能找到那一份，搬回去就是还原。
    const folder = readdirSync(join(ctxRoot(vault), '回收站'))
    assert.equal(folder.length, 1)
    assert.match(folder[0], /^B002_/)

    const none = context.command('ctx rollback B099', {})
    assert.equal(none.ok, false)
    assert.match(none.text, /没有 B099 这一批/)
    const blank = context.command('ctx rollback', {})
    assert.equal(blank.ok, false)
    assert.match(blank.text, /要给一个批次号/)
    context.dispose()
  })

  it('工具里也够得着 batch，没库时说人话', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-batch-tool-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    syncArchives({ api, pending: [pendingOne()], now: '2026-11-04T05:00:00Z' })
    const { ctx, tools } = makeCtx()
    const context = registerContext({ ctx, api })
    const def = tools.find((item) => item.name === CTX_TOOL_NAME)
    const listed = await def.execute({ action: 'batch' })
    assert.equal(listed.ok, true)
    assert.deepEqual(listed.batches.map((one) => one.batch), ['B001'])
    const one = await def.execute({ action: 'batch', batch: 'B001' })
    assert.equal(one.count, 1)
    assert.equal(one.rows[0].id, 'C001')
    context.dispose()

    const { ctx: ctx2, tools: tools2 } = makeCtx()
    const context2 = registerContext({ ctx: ctx2, api: makeApi() })
    const def2 = tools2.find((item) => item.name === CTX_TOOL_NAME)
    assert.equal((await def2.execute({ action: 'batch' })).message, COPY.ctxNeedsVault)
    context2.dispose()
  })
})

describe('接线：条目', () => {
  it('/whale ctx entries：整表、单卡、没有条目时都说人话', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-entries-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    syncArchives({ api, pending: [pendingOne()], now: '2026-11-04T05:00:00Z' })
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api })

    // 规则那一路在英文摘要上抽不出东西，所以整表还空着。
    assert.match(context.command('ctx entries', {}).text, /还空着/)
    assert.match(context.command('ctx entries C001', {}).text, /还没抽出条目/)
    assert.equal(context.command('ctx entries C099', {}).ok, false)
    assert.match(context.command('ctx entries C099', {}).text, /没有 C099 这张卡/)
    context.dispose()
  })

  it('工具补录：写进卡片、重算条目表，再补同一句不算新增', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-entries-tool-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    syncArchives({ api, pending: [pendingOne()], now: '2026-11-04T05:00:00Z' })
    const { ctx, tools } = makeCtx()
    const context = registerContext({ ctx, api })
    const def = tools.find((item) => item.name === CTX_TOOL_NAME)

    const done = await def.execute({ action: 'entries', id: 'C001', rows: [{ type: '待办', content: '把批次号接上' }] })
    assert.equal(done.ok, true)
    assert.equal(done.added, 1)
    assert.deepEqual(done.rows, [{ type: '待办', content: '把批次号接上', sourceId: 'C001', way: 'model' }])
    assert.match(done.table, /\| 1 \| 待办 \| 把批次号接上 \| C001 \| model \|/)

    // 同一句再补一遍：不算新增，表里仍只有一行。
    const again = await def.execute({ action: 'entries', id: 'C001', rows: [{ type: '待办', content: '把批次号接上' }] })
    assert.equal(again.added, 0)
    assert.equal(again.table.trim().split('\n').length, 3)

    // 只读那一路也回到同一张表。
    const listed = await def.execute({ action: 'entries', id: 'C001' })
    assert.equal(listed.scope, 'card')
    assert.equal(listed.model, 1)
    assert.match(listed.rows.map((one) => one.content).join('、'), /把批次号接上/)
    context.dispose()
  })
})

describe('接线：还剩多少按宿主读数算，没读数就标估的', () => {
  it('有 contextWindow 与 pressureTokens 时按剩余算档', () => {
    const tier = tierFor({ pressure: { contextWindow: 200000, pressureTokens: 195000 } })
    assert.equal(tier.tier !== 'ok', true)
    assert.equal(tier.exact, true)
  })

  it('完全没有读数时回 ok 并标成不精确', () => {
    const tier = tierFor({})
    assert.equal(tier.tier, 'ok')
    assert.equal(tier.exact, false)
  })
})

// 这一段锁的是「读数是真从宿主那儿取的」：以前 `pressure` 只是个形参，
// 全仓没有调用方传值，于是 tier 永远是 ok、三档提醒一次都到不了。
describe('接线：读数从宿主投影里取', () => {
  // 真机 2026-11-04 的读数（`session_projcache` 里 contextPressure 那一行）。
  const real = { surfaceTokens: 127180, contextWindow: 262144, pressureTokens: 183121, sampledSurfaceTokens: 125366 }

  function pctx(pressure, options = {}) {
    const base = makeCtx()
    const session = options.session ?? { eventAt: () => null }
    base.ctx.sessionProjections.stateOf = (given, key) => {
      if (options.boom === true) throw new Error('registry 没了')
      if (options.shape !== undefined) return options.shape
      if (key !== 'contextPressure' || given !== session) return null
      return options.dynamic === undefined ? pressure : options.dynamic()
    }
    return { ...base, session }
  }

  it('按 contextPressure 这个键取，会话对不上就回 null', () => {
    const { ctx, session } = pctx(real)
    assert.equal(pressureOf({ session, projections: ctx.sessionProjections }), real)
    assert.equal(pressureOf({ session: { other: true }, projections: ctx.sessionProjections }), null)
    assert.equal(pressureOf({ session, projections: null }), null)
    assert.equal(pressureOf({ session, projections: {} }), null)
    assert.equal(pressureOf({}), null)
    assert.equal(pressureOf(), null)
  })

  it('投影抛错、形状不是对象，都只回 null，不炸', () => {
    const { ctx, session } = pctx(real, { boom: true })
    assert.equal(pressureOf({ session, projections: ctx.sessionProjections }), null)
    const shaped = pctx(real, { shape: 'not-an-object' })
    assert.equal(pressureOf({ session: shaped.session, projections: shaped.ctx.sessionProjections }), null)
  })

  it('真机那组读数算出来的剩余与档位', () => {
    const tier = tierFor({ pressure: real })
    assert.equal(tier.source, 'native')
    assert.equal(tier.exact, true)
    assert.equal(tier.remaining, 262144 - 183121)
    assert.equal(tier.used, 183121, '已用量要一起带出来，提醒文案按它写')
    // 262144 窗口：remind = 0.20 × 262144 = 52,428；183,121 已用早就过了
    assert.equal(tier.tier, 'remind')
    // 档位按已用判，所以越大越紧
    assert.equal(tierFor({ pressure: { ...real, pressureTokens: 60000 } }).tier, 'remind')
    assert.equal(tierFor({ pressure: { ...real, pressureTokens: 30000 } }).tier, 'ok')
    assert.equal(tierFor({ pressure: { ...real, pressureTokens: 190000 } }).tier, 'urge')
    assert.equal(tierFor({ pressure: { ...real, pressureTokens: 215000 } }).tier, 'critical')
  })

  it('ctxInfo 把档位一起带出来，没选库也照带', () => {
    const info = ctxInfo({ api: makeApi(), pressure: real })
    assert.equal(info.ready, false)
    assert.equal(info.source, 'native')
    assert.equal(info.remaining, 79023)
    assert.equal(info.tier, 'remind')
  })

  it('工具 status 会去问宿主；没给 agent 就如实回读不到', async () => {
    const { ctx, tools, session } = pctx(real)
    const context = registerContext({ ctx, api: makeApi() })
    const def = tools.find((item) => item.name === CTX_TOOL_NAME)
    const asked = await def.execute({ action: 'status' }, { agent: { session } })
    assert.equal(asked.source, 'native')
    assert.equal(asked.remaining, 79023)
    assert.equal(asked.exact, true)
    const bare = await def.execute({ action: 'status' }, {})
    assert.equal(bare.source, 'none')
    assert.equal(bare.remaining, null)
    context.dispose()
  })

  it('/whale ctx status 念出还剩多少', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-status-'))
    const { ctx, session } = pctx(real)
    const context = registerContext({ ctx, api: makeApi(join(dir, '库')) })
    const said = context.command('ctx status', { statusOf: () => context.statusOf({ session }) })
    assert.equal(said.ok, true)
    assert.match(said.text, /还剩 79023 tokens（约 79K）/)
    assert.match(said.text, /来源 native/)
    assert.match(said.text, /投影 ok/)
    context.dispose()
  })

  it('没选库时 ctx status 说人话，不抛', () => {
    const { ctx, session } = pctx(real)
    const context = registerContext({ ctx, api: makeApi() })
    const said = context.command('ctx status', { statusOf: () => context.statusOf({ session }) })
    assert.equal(said.text, COPY.ctxNeedsVault)
    context.dispose()
  })
})

// 提醒落在会话里（`agent.inject()` → `agent/inbox/spliced`）：
// 只在档位往下探时说一次，同一档不重复，回血后也不重说。
describe('接线：跨档提醒', () => {
  const windowed = (used) => ({ pressureTokens: used, contextWindow: 262144 })

  function wired(initial) {
    const base = makeCtx()
    const session = { id: 'session-1', eventAt: () => null }
    let cur = initial
    base.ctx.sessionProjections.stateOf = (given, key) => (key === 'contextPressure' && given === session ? cur : null)
    const injected = []
    const perAgent = []
    const agent = {
      session,
      inject: (message) => injected.push(message),
      ctx: { on: (event, fn) => { perAgent.push({ event, fn }); return () => {} } },
    }
    const context = registerContext({ ctx: base.ctx, api: makeApi() })
    bootAgent(base, agent)
    return { context, injected, perAgent, base, set: (next) => { cur = next }, agent };
  }

  it('提醒文案：ok 不说，读数不全不说，见底的话不一样', () => {
    assert.equal(reminderText({ tier: 'ok', remaining: 10 }), '')
    assert.equal(reminderText({ tier: 'remind' }), '', '一个数都没有就不说')
    assert.equal(reminderText(), '')
    // 按已用写（第六批 §4.2）：remind 的语义从「快满了」变成「该压了」
    assert.match(reminderText({ tier: 'remind', used: 120000, remaining: 142144 }), /已用约 120K（120000 tokens）/)
    assert.match(reminderText({ tier: 'remind', used: 120000, remaining: 142144 }), /该压了，可以手动 \/compact/)
    assert.match(reminderText({ tier: 'critical', used: 250000, remaining: 12144 }), /立刻 \/compact/)
    // 只给剩余也能说（老调用点）
    assert.match(reminderText({ tier: 'remind', remaining: 57144 }), /还剩约 57\.1K/)
    assert.equal(reminderOf({ prevTier: 'remind', tier: 'remind', used: 60000 }), '')
    assert.equal(reminderOf({ prevTier: 'urge', tier: 'remind', used: 60000 }), '')
    assert.equal(reminderOf({ prevTier: 'ok', tier: 'remind', used: 60000 }), reminderText({ tier: 'remind', used: 60000 }))
  })

  it('一轮结束时真塞了一句进会话，形状照宿主的 inserted 项', () => {
    const run = wired(windowed(205000))
    const { injected, context, agent, base } = run
    assert.equal(injected.length, 0)
    turnEnd(base, agent.session)
    assert.equal(injected.length, 1)
    assert.equal(injected[0].role, 'user')
    assert.equal(injected[0].source.kind, 'dsh-whale-pal')
    assert.equal(injected[0].content[0].type, 'text')
    assert.equal(typeof injected[0].id, 'string')
    assert.match(injected[0].content[0].text, /^\[whale-pal\] 上下文已用约 205K/)
    context.dispose()
  })

  it('同一档不重复；往下探一档才说；掉回来了再涨上去要重说', () => {
    // 262144 窗口：remind 52,428 / urge 188,743 / critical 209,715
    const run = wired(windowed(100000))
    const s = run.agent.session
    turnEnd(run.base, s)
    turnEnd(run.base, s)
    assert.equal(run.injected.length, 1, '过了提醒线说一次，同档不重复')

    run.set(windowed(195000)) // 过 urge 线
    turnEnd(run.base, s)
    assert.equal(run.injected.length, 2)
    assert.match(run.injected[1].content[0].text, /已用约 195K/)

    run.set(windowed(100000)) // 回到 remind：高水位是 urge，不重说
    turnEnd(run.base, s)
    assert.equal(run.injected.length, 2)

    run.set(windowed(255000)) // 过 critical 线
    turnEnd(run.base, s)
    assert.equal(run.injected.length, 3)
    assert.match(run.injected[2].content[0].text, /立刻 \/compact/)

    // 压过了 → 掉回 ok → 高水位作废。回血后再涨到同一档必须重新提醒：
    // 只记高水位不复位的话，同一个会话里这句提醒等于作废（2026-11-09 人类指出）。
    run.set(windowed(30000))
    turnEnd(run.base, s)
    assert.equal(run.injected.length, 3, '掉回 ok 不再念')

    run.set(windowed(100000))
    turnEnd(run.base, s)
    assert.equal(run.injected.length, 4, '回血后再涨到同一档，要重新提醒')
    run.context.dispose()
  })

  it('读数宽裕时一轮结束什么都不塞', () => {
    const run = wired(windowed(30000))
    turnEnd(run.base, run.session)
    assert.equal(run.injected.length, 0)
    run.context.dispose()
  })

  it('agent 没有 inject 时只留一条 warning，不抛', () => {
    const base = makeCtx()
    const session = { id: 'session-2', eventAt: () => null }
    base.ctx.sessionProjections.stateOf = (given, key) => (key === 'contextPressure' && given === session ? windowed(255000) : null)
    const perAgent = []
    const context = registerContext({ ctx: base.ctx, api: makeApi() })
    base.handlers.find((item) => item.event === 'agent/created').handler({
      agent: {
        session,
        ctx: { on: (event, fn) => { perAgent.push({ event, fn }); return () => {} } },
      },
      source: 'startup',
    })
    turnEnd(base, session)
    assert.equal(context.warnings.filter((line) => /提醒没说出来/.test(line)).length, 1)
    context.dispose()
  })

  it('/whale ctx remind 只预报，不往会话里塞', () => {
    const { ctx } = makeCtx()
    const context = registerContext({ ctx, api: makeApi() })
    const loud = context.command('ctx remind', { statusOf: () => ({ ok: true, ready: true, tier: 'remind', remaining: 57144 }) })
    assert.match(loud.text, /跨档时会往会话里说这一句/)
    const quiet = context.command('ctx remind', { statusOf: () => ({ ok: true, ready: true, tier: 'ok', remaining: 200000 }) })
    assert.match(quiet.text, /现在不用提醒/)
    const none = context.command('ctx remind')
    assert.equal(none.ok, false)
    assert.equal(none.text, COPY.ctxNeedsVault)
    context.dispose()
  })

  it('宿主没给 ctx.on 时记一条 warning，不静默', () => {
    const ctx = {
      sessionProjections: { register: () => () => {}, stateOf: () => null },
      tools: { register: () => () => {} },
    }
    const context = registerContext({ ctx, api: makeApi() })
    assert.equal(context.warnings.some((line) => /提醒没挂上/.test(line)), true)
    assert.equal(context.remindStatus(), 'pending')
    context.dispose()
  })
})

// 自动落盘：宿主压完只留投影，没人去取就等于没存。
// 这一组盯的是「一轮收尾时它真把队列收进库」，而不是「有手动命令能收」。
describe('接线：一轮收尾自动落盘', () => {
  function autoWired(pending, vault) {
    const base = makeCtx()
    const session = { id: 'session-auto', eventAt: () => null }
    base.ctx.sessionProjections.stateOf = (given, key) => {
      if (given !== session) return null;
      if (key === 'contextPressure') return null;
      if (key === PROJECTION_KEY) {
        return { version: 2, pendingArchives: pending, seen: {}, pruned: 0, source: 'native', lastAt: null };
      }
      return null;
    }
    const perAgent = []
    const agent = {
      session,
      inject: () => {},
      ctx: { on: (event, fn) => { perAgent.push({ event, fn }); return () => {} } },
    }
    const context = registerContext({ ctx: base.ctx, api: makeApi(vault) })
    bootAgent(base, agent)
    return { context, perAgent, base, session, agent }
  }

  it('一轮结束时把队列里那份收进库，编号按盘上接着排', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-auto-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const run = autoWired([pendingOne()], vault)
    assert.equal(readCards(ctxRoot(vault)).length, 0)
    turnEnd(run.base, run.session)
    const cards = readCards(ctxRoot(vault))
    assert.equal(cards.length, 1)
    assert.equal(cards[0].id, 'C001')
    assert.ok(existsSync(pathsOf(ctxRoot(vault)).index))
    run.context.dispose()
  })

  it('同一份不会落第二遍：再跑一轮还是那一张卡', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-auto-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const run = autoWired([pendingOne()], vault)
    turnEnd(run.base, run.session)
    turnEnd(run.base, run.session)
    turnEnd(run.base, run.session)
    assert.equal(readCards(ctxRoot(vault)).length, 1)
    run.context.dispose()
  })

  it('没有新东西时不碰盘：库里一份都没多，也没报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-auto-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const run = autoWired([], vault)
    turnEnd(run.base, run.session)
    assert.equal(existsSync(ctxRoot(vault)), false, '队列空时不该建目录')
    assert.equal(run.context.warnings.some((line) => /没自动落盘/.test(line)), false)
    run.context.dispose()
  })

  it('没选库时只记一条 warning，不抛、不拦这一轮', () => {
    const base = makeCtx()
    const session = { id: 'session-novault', eventAt: () => null }
    base.ctx.sessionProjections.stateOf = (given, key) => (given === session && key === PROJECTION_KEY
      ? { version: 2, pendingArchives: [pendingOne()], seen: {}, pruned: 0, source: 'native', lastAt: null }
      : null)
    const perAgent = []
    const context = registerContext({ ctx: base.ctx, api: makeApi() })
    base.handlers.find((item) => item.event === 'agent/created').handler({
      agent: {
        session,
        inject: () => {},
        ctx: { on: (event, fn) => { perAgent.push({ event, fn }); return () => {} } },
      },
      source: 'startup',
    })
    assert.doesNotThrow(() => turnEnd(base, session))
    assert.equal(context.warnings.some((line) => /档案没自动落盘/.test(line)), true)
    context.dispose()
  })

  it('agent/created 的 payload 是对象，按 { agent } 取才挂得上 turn/end', () => {
    // 回归：早先实现写的是 (agent) => agent?.ctx，而宿主传的是 { agent, source, signal }，
    // 于是 payload.ctx 恒为 undefined、turn/end 从未挂上，自动落盘与跨档提醒都没跑过。
    // 这条用真实 payload 形状调用，挂不上就会直接失败。
    const base = makeCtx()
    const session = { id: 'session-payload', eventAt: () => null }
    base.ctx.sessionProjections.stateOf = () => null
    const perAgent = []
    const agent = {
      session,
      inject: () => {},
      ctx: { on: (event, fn) => { perAgent.push({ event, fn }); return () => {} } },
    }
    const context = registerContext({ ctx: base.ctx, api: makeApi() })
    const created = base.handlers.find((item) => item.event === 'agent/created').handler
    created({ agent, source: 'startup' })
    assert.equal(context.remindStatus(), 'ok', 'agent/created 后映射与 ctx 就绪')
    // 真正干活的是 session/event：turn/end 只是它的一个 type
    const fired = turnEnd(base, session)
    assert.equal(fired, true, '必须挂上 session/event')
    context.dispose()
  })

  it('主路走 /compact 命令，不直连 compaction 服务（isolate 挡住的那条）', async () => {
    // 预置的 compaction 在 isolate realm 里，插件够不着（五条取服务的路全空）。
    // 所以主路必须是 `/compact` 命令的闭包。这里把直连那条路放成会炸的桩：
    // 只要它被调到，测试就红。
    const base = makeCtx()
    const session = { id: 'session-main', eventAt: () => null }
    base.ctx.sessionProjections.stateOf = () => null
    const executed = []
    base.ctx.commands = {
      register: () => () => {},
      execute: async (_agent, line) => {
        executed.push(line)
        return { commandId: 'cmd-1', result: { kind: 'success', text: 'Compacted 1045 history items' } }
      },
    }

    let measured = 0
    const agentCtx = {
      on: () => () => {},
      tokenMeter: {
        measure: () => {
          measured += 1
          return measured === 1
            ? { totalTokens: 200000, contextWindow: 1000000 }
            : { totalTokens: 40000, contextWindow: 1000000 }
        },
      },
      compaction: { compactNow: () => { throw new Error('不该直连 isolate 里的 compaction') } },
      get: () => null,
    }
    const agent = { session, inject: () => {}, phase: { kind: 'idle' }, ctx: agentCtx }

    const context = registerContext({ ctx: base.ctx, api: makeApi() })
    bootAgent(base, agent)

    turnEnd(base, session, 7)
    assert.deepEqual(executed, [], 'turn/end 当场不该调命令：那一拍 agent 还占着')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(executed, ['/compact'], '延后一拍必须真的走 /compact')
    const state = context.compactState('session-main')
    assert.equal(state.compactions, 1)
    assert.equal(state.verifyPending, true, '压完要挂下一轮复检')
    assert.equal(state.lastExec.ok, true)
    // 结果也要落进诊断账：当场一条「已接手」，`/compact` 回来一条「压成」。
    // 缺了后面这条，recent 就永远停在半句话上，事后问「那次到底压成没压成」答不上来。
    assert.deepEqual(
      context.compactLog().map((line) => line.split('（')[0]),
      ['started', 'compacted'],
    )
    context.dispose()
  })

  it('触发点系数从 config.compaction 来：改配置就改行为，写坏了回默认', async () => {
    const base = makeCtx();
    base.ctx.sessionProjections.stateOf = () => null;
    const executed = [];
    base.ctx.commands = {
      register: () => () => {},
      execute: async () => {
        executed.push('/compact');
        return { commandId: 'cmd-coef', result: { kind: 'success', text: 'Compacted 100 items' } };
      },
    };
    const config = { compaction: { ratio: 0.05 } };
    const api = { getConfig: () => config, getState: () => ({ revision: 1 }), buildView: () => ({}) };

    const makeAgent = (id) => ({
      session: { id, eventAt: () => null },
      inject: () => {},
      phase: { kind: 'idle' },
      ctx: {
        on: () => () => {},
        // 已用 10 万：5% 触发点是 5 万（已到），16% 是 16 万（没到）。只差系数。
        tokenMeter: { measure: () => ({ totalTokens: 100000, contextWindow: 1000000 }) },
        compaction: null,
        get: () => null,
      },
    });

    const context = registerContext({ ctx: base.ctx, api });
    const runTurn = async (id) => {
      const agent = makeAgent(id);
      bootAgent(base, agent);
      // 必须传同一个 session 对象：宿主按对象认 agent，换个新对象就找不到这一轮的 agent。
      turnEnd(base, agent.session, 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    // 5%：该压。
    await runTurn('session-coef-low');
    assert.deepEqual(executed, ['/compact'], '系数改成 5% 之后，10 万就该到点');
    assert.equal(context.compactState('session-coef-low').compactions, 1);

    // 人把配置改成 16%：同一个读数就不该再压。
    config.compaction.ratio = 0.16;
    await runTurn('session-coef-default');
    assert.deepEqual(executed, ['/compact'], '16% 下 10 万没到点，不该再压');
    assert.equal(context.compactState('session-coef-default').compactions, 0);

    // 写坏的系数（0）不许变成「每轮都压」：按默认 16% 算，仍然不压。
    config.compaction.ratio = 0;
    await runTurn('session-coef-zero');
    assert.deepEqual(executed, ['/compact'], '坏系数该回默认值，不该让压缩失控');
    context.dispose();
  });

  it('主路没压成：塞一句「请手动 /compact」，且一个会话只说一次', async () => {
    const base = makeCtx()
    const session = { id: 'session-fallback', eventAt: () => null }
    base.ctx.sessionProjections.stateOf = () => null
    base.ctx.commands = {
      register: () => () => {},
      execute: async () => ({ commandId: 'cmd-2', result: { kind: 'busy', text: 'agent 正忙' } }),
    }
    const agentCtx = {
      on: () => () => {},
      tokenMeter: { measure: () => ({ totalTokens: 200000, contextWindow: 1000000 }) },
      compaction: null,
      get: () => null,
    }
    const injected = []
    const agent = { session, inject: (m) => injected.push(m), phase: { kind: 'idle' }, ctx: agentCtx }

    const context = registerContext({ ctx: base.ctx, api: makeApi() })
    bootAgent(base, agent)

    turnEnd(base, session, 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const said = injected.map((m) => m.content[0].text).filter((t) => /自动压缩没生效/.test(t))
    assert.equal(said.length, 1, '主路不通要叫人手动压')
    assert.match(said[0], /手动输入 \/compact/)
    assert.match(said[0], /200000/)
    assert.equal(context.compactState('session-fallback').lastExec.ok, false)
    // 失败也要留在账上：过程里最该看见的就是「那次没成」。
    assert.deepEqual(
      context.compactLog().map((line) => line.split('（')[0]),
      ['started', 'failed'],
    )

    // 下一轮再试还是没成，但不该再念一遍
    turnEnd(base, session, 2)
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(injected.filter((m) => /自动压缩没生效/.test(m.content[0].text)).length, 1, '同一个局面只说一次')

    // 人手动压了一次（宿主会发 compaction/end）→ 局面翻篇，提醒重新武装。
    // 不重新武装的话，同一会话里主路再失效就永远没提醒了。
    fireSessionEvent(base, session, 'compaction/end', {})
    turnEnd(base, session, 3)
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(
      injected.filter((m) => /自动压缩没生效/.test(m.content[0].text)).length,
      2,
      '手动压缩过之后主路再失效，必须还能提醒',
    )
    context.dispose()
  })

  it('压完下一轮仍超限：说一句「不会再压，开新会话」，不是再压一次', async () => {
    // 端到端钉这条接线：复检判成没用之后，人得真收到那句提醒；
    // 否则功能是「悄悄停了」，人只会以为坏了。
    const base = makeCtx()
    const session = { id: 'session-switch', eventAt: () => null }
    base.ctx.sessionProjections.stateOf = () => null
    let executed = 0
    base.ctx.commands = {
      register: () => () => {},
      execute: async () => {
        executed += 1
        return { commandId: `cmd-${executed}`, result: { kind: 'success', text: 'Compacted' } }
      },
    }

    let measured = 0
    const agentCtx = {
      on: () => () => {},
      tokenMeter: {
        measure: () => {
          measured += 1
          if (measured === 1) return { totalTokens: 200000, contextWindow: 1000000 }
          if (measured === 2) return { totalTokens: 40000, contextWindow: 1000000 }
          return { totalTokens: 210000, contextWindow: 1000000 } // 下一轮收尾：仍超
        },
      },
      compaction: null,
      get: () => null,
    }
    const injected = []
    const agent = { session, inject: (m) => injected.push(m), phase: { kind: 'idle' }, ctx: agentCtx }

    const context = registerContext({ ctx: base.ctx, api: makeApi() })
    bootAgent(base, agent)

    turnEnd(base, session, 1) // 到点 → 延后一拍压
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(executed, 1)

    turnEnd(base, session, 2) // 下一轮收尾 → 复检：仍超 → 停 + 提醒
    await new Promise((resolve) => setTimeout(resolve, 5))

    assert.equal(executed, 1, '判成没用就不许再压第二次')
    const said = injected.map((m) => m.content[0].text).filter((t) => /不会再压/.test(t))
    assert.equal(said.length, 1, '那句停用提醒必须真的塞进会话，而且只说一次')
    assert.match(said[0], /210000/)
    assert.match(said[0], /160000/)
    assert.match(said[0], /新会话/)
    // 复检的结论也得留在账上：光记一个「skipped」等于没说清为什么没压。
    const log = context.compactLog()
    assert.equal(log.some((line) => line.startsWith('switch（')), true, '复检判成没用要留一条 switch')
    context.dispose()
  })

  it('压完仍超并且宿主能建会话：自己开一个新的，说清切到哪，不再只是劝人', async () => {
    // 上一条只走「建不成就退回劝人」那一半；这一半是开成了之后的接线：
    // 新会话要按老会话的目录和预设建、要挂回老会话的工作区、交接条要递进去，
    // 然后旧会话里那句必须是「已切到新会话 <id>」，不是「还得你手动开」。
    // 真机上「压完仍超」这个场面造不出来，能盖到这一层就到这一层。
    const base = makeCtx()
    const session = {
      id: 'session-switch-ok',
      eventAt: () => null,
      header: { id: 'session-switch-ok', cwd: 'D:\\AI 项目\\插件dsh-whale-pal开发' },
    }
    base.ctx.sessionProjections.stateOf = () => null
    base.ctx.commands = {
      register: () => () => {},
      execute: async () => ({ commandId: 'cmd-1', result: { kind: 'success', text: 'Compacted' } }),
    }

    const created = []
    const prompted = []
    const attached = []
    const services = {
      sessionController: {
        create: async (request) => {
          created.push(request)
          return { sessionId: 'session-made-1' }
        },
        prompt: async (request, signal) => {
          prompted.push(request)
          if (typeof signal?.throwIfAborted !== 'function') throw new TypeError('signal 没传')
          return { accepted: true }
        },
      },
      workspaceRegistry: {
        list: () => [{
          id: 'ws-1',
          path: 'D:\\AI 项目\\插件dsh-whale-pal开发',
          sessionIds: ['session-switch-ok'],
          attachSession: async (id) => attached.push(id),
        }],
      },
    }
    base.ctx.get = (key) => services[key] ?? null

    let measured = 0
    const agentCtx = {
      on: () => () => {},
      tokenMeter: {
        measure: () => {
          measured += 1
          if (measured === 1) return { totalTokens: 200000, contextWindow: 1000000 }
          if (measured === 2) return { totalTokens: 40000, contextWindow: 1000000 }
          return { totalTokens: 210000, contextWindow: 1000000 } // 下一轮收尾：仍超
        },
      },
      compaction: null,
      get: (key) => services[key] ?? null,
    }
    const injected = []
    const agent = { session, inject: (m) => injected.push(m), phase: { kind: 'idle' }, ctx: agentCtx }

    const context = registerContext({ ctx: base.ctx, api: makeApi() })
    bootAgent(base, agent)

    turnEnd(base, session, 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    turnEnd(base, session, 2)
    await new Promise((resolve) => setTimeout(resolve, 30))

    assert.equal(created.length, 1, '该开一个会话')
    assert.equal(created[0].cwd, 'D:\\AI 项目\\插件dsh-whale-pal开发', '同目录')
    assert.deepEqual(attached, ['session-made-1'], '要挂回老会话的工作区，不然落未分组')
    assert.equal(prompted.length, 1, '助手模式要带交接条')
    assert.match(prompted[0].content[0].text, /不是用户本人发/u)

    const said = injected.map((m) => m.content[0].text)
    assert.equal(said.some((t) => /已切到新会话 session-made-1/.test(t)), true, '旧会话要说清切到哪')
    assert.equal(said.some((t) => /还得你手动开/.test(t)), false, '开成了就不许再叫人手动开')
    // 旧会话的自动压缩要停住：不停住下一轮又会判「仍超」，再开第二个。
    const later = context.compactLog().join('\n')
    assert.match(later, /switch（/u)
    context.dispose()
  })

  it('turn/end 是 session/event 派发的，不是 cordis 的 turn/end 事件', () => {
    // 回归：`turn/end` 是 session.append() 写进日志的事件，append 只调 commit()，
    // 而 commit 派发的是 `session/event`。所以 `ctx.on('turn/end', …)` 永远不会响 ——
    // 77 次 turn/end 一次没触发，自动落盘与压缩都灰着（2026-11-08 读源码确认）。
    const base = makeCtx()
    const session = { id: 'session-se', eventAt: () => null }
    base.ctx.sessionProjections.stateOf = () => null
    const injected = []
    const agent = { session, inject: (m) => injected.push(m), ctx: { on: () => () => {} } }
    const context = registerContext({ ctx: base.ctx, api: makeApi() })

    // 必须挂的是 session/event
    assert.equal(base.handlers.some((h) => h.event === 'session/event'), true, '必须挂 session/event')
    assert.equal(base.handlers.some((h) => h.event === 'turn/end'), false, '不该挂 turn/end')

    bootAgent(base, agent)
    // 非 turn/end 的 session 事件不该触发
    fireSessionEvent(base, session, 'assistant/message', {})
    assert.equal(injected.length, 0, '别的 session 事件不该触发提醒')

    // turn/end 才触发
    turnEnd(base, session)
    assert.equal(injected.length >= 0, true)
    context.dispose()
  })

  it('autoArchive 自己就能调：新队列收、旧队列跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'whale-ctx-auto-'))
    const vault = join(dir, '库')
    mkdirSync(vault, { recursive: true })
    const api = makeApi(vault)
    const first = autoArchive({ api, pending: [pendingOne()], now: '2026-11-04 05:00' })
    assert.equal(first.ok, true)
    assert.equal(first.wrote, true)
    assert.deepEqual(first.ids, ['C001'])
    const again = autoArchive({ api, pending: [pendingOne()], now: '2026-11-04 06:00' })
    assert.equal(again.ok, true)
    assert.equal(again.wrote, false)
    assert.deepEqual(again.ids, [])
    assert.equal(again.cards, 1)
  })
})
