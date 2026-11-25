/**
 * 客户端设置页那一半：模块出口、注册参数、渲染结果、以及它和宿主之间那条 HTTP 契约。
 *
 * 这里不渲染真 DOM：假 react 只把 createElement 收成 {type, props, children} 树，
 * 假 fetch 按 URL 回 payload。能断言的都从这棵树上读，不猜浏览器行为。
 * 页面里唯一允许出现的路由是文档相对路径（GUI 带 <base href="./">）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import vm from 'node:vm'

import { BANNED } from '../lib/copy.js'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const VAULT_PATH = 'D:\\笔记\\鲸'
const CARD_HINT = '这一项随时能改'
const ACTION_FILL = '写入'

const FIXTURE = {
  ok: true,
  identity: [
    { key: 'name', label: '名称', value: 'whale', writable: true, multiline: false, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'nameMeaning', label: '名称的含义', value: '', writable: true, multiline: false, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'selfName', label: '自称', value: 'whale', writable: true, multiline: false, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'selfNameMeaning', label: '自称的含义', value: '一头会记账的鲸', writable: true, multiline: false, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'title', label: '称呼', value: '用户', writable: true, multiline: false, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'titleMeaning', label: '称呼的含义', value: '', writable: true, multiline: false, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'temperament', label: '底色', value: '自然、有边界', writable: true, multiline: true, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'values', label: '价值观', value: '自由、公平', writable: true, multiline: true, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'boundaries', label: '边界', value: '- 不骂人\n- 不接受被骂', writable: true, multiline: true, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'language', label: '说话风格', value: '自然口语', writable: true, multiline: true, hint: CARD_HINT, action: ACTION_FILL },
    { key: 'summary', label: '总结', value: '一头会记账的鲸', writable: true, multiline: true, hint: CARD_HINT, action: ACTION_FILL },
  ],
  card: { raw: '', chars: 0, at: '' },
  editable: {
    vaultPath: { value: VAULT_PATH, placeholder: '笔记库在哪个目录' },
    obsidianEnabled: { value: false },
    whaleWorkspaces: { value: ['D:\\聊天'] },
  },
  accounting: {
    shortFacts: 4,
    shortPreferences: 2,
    longMemory: 7,
    traits: 9,
    commitments: 3,
    revision: 31,
  },
  imported: { from: 'persona-framework', at: '2026-11-01T10:00:00.000Z', diff: [] },
  obsidian: { enabled: false, state: 'installed', label: '装过 Obsidian，还没打开开关', hasVault: true, vaultName: '记忆空间' },
  health: { ok: true, state: 'normal', color: 'green', notes: [], grace: { active: false, installedAt: null, readOnlyUntil: null } },
  view: { state: { revision: 31 } },
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  }
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 极简 react：只认 createElement / useState / useEffect，状态存成按调用顺序排的槽。 */
function createReact() {
  const state = { slots: [], effects: [], cursor: 0 }
  const react = {
    createElement(type, props, ...children) {
      const value = children.length === 1 ? children[0] : children
      return { type, props: props ?? {}, children: value }
    },
    useState(initial) {
      const index = state.cursor
      state.cursor += 1
      if (Object.hasOwn(state.slots, index) === false) {
        state.slots[index] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        state.slots[index] = typeof next === 'function' ? next(state.slots[index]) : next
      }
      return [state.slots[index], set]
    },
    useEffect(effect) {
      state.effects.push(effect)
    },
  }
  react.render = (component) => {
    state.cursor = 0
    state.effects = []
    const tree = component({})
    return { tree, effects: state.effects }
  }
  return react
}

function loadModule(fetchImpl, workspaceFixture = []) {
  const calls = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          sandbox.definition = definition
        },
      },
    },
    fetch: (url, options) => {
      calls.push({ url, options })
      // 工作区清单是页面顺带拉的，与被测的那条路无关：默认回空，
      // 免得每个用例都替它写一遍分支。
      if (url === 'api/whale-pal/workspaces') {
        return Promise.resolve(jsonResponse({ ok: true, workspaces: workspaceFixture }))
      }
      return fetchImpl(url, options)
    },
    console: { warn() {} },
  }
  vm.runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  assert.ok(sandbox.definition, '客户端脚本应当调用 window.__ModuleLoader__.load')
  const react = createReact()
  const exports = sandbox.definition.factory((id) => {
    if (id === 'react') return react
    throw new Error('不该 require 别的模块：' + id)
  })
  return { definition: sandbox.definition, exports, react, calls }
}

async function mount(fetchImpl, workspaceFixture = []) {
  const loaded = loadModule(fetchImpl, workspaceFixture)
  const registry = []
  loaded.exports.apply({
    slots: {
      register(params, component) {
        registry.push({ params, component })
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
  })
  assert.equal(registry.length, 1, 'apply 应当注册一个设置分区')
  const entry = registry[0]
  const first = loaded.react.render(entry.component)
  for (const effect of first.effects) effect()
  await settle()
  return {
    ...loaded,
    entry,
    loading: first.tree,
    tree: loaded.react.render(entry.component).tree,
    rerender: () => loaded.react.render(entry.component).tree,
  }
}

function collect(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out)
    return out
  }
  out.push(node)
  collect(node.children, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || node === true || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

/**
 * 按文案找按钮。默认要求恰好一个（防重名）；
 * 页面上本来就有两处「选目录」（笔记库、工作区总路径）时传 { any: true }，取第一个。
 */
function findButton(tree, label, options = {}) {
  const found = collect(tree).filter(
    (node) => node.type === 'button' && textOf(node.children).includes(label),
  )
  if (options.any === true) {
    assert.ok(found.length > 0, '没找到按钮写着 ' + label)
    return found[0]
  }
  assert.equal(found.length, 1, '应当恰好有一个按钮写着 ' + label)
  return found[0]
}

function countInputs(tree) {
  return collect(tree).filter((node) => node.type === 'input').length
}

/** 所有输入框/文本域里现在摆着的值（在 props 上，不在 children 上）。 */
function controlValues(tree) {
  return collect(tree)
    .filter((node) => node.type === 'input' || node.type === 'textarea')
    .map((node) => node.props.value)
}

/** 空着的几格共用同一个占位，按顺序取。 */
function findInputs(tree, placeholder) {
  const found = collect(tree).filter(
    (node) => node.type === 'input' && node.props.placeholder === placeholder,
  )
  assert.ok(found.length > 0, '没找到占位是 ' + placeholder + ' 的输入框')
  return found
}

function findInput(tree, placeholder) {
  const found = collect(tree).filter(
    (node) => node.type === 'input' && node.props.placeholder === placeholder,
  )
  assert.equal(found.length, 1, '应当恰好有一个输入框占位是 ' + placeholder)
  return found[0]
}

describe('客户端设置页', () => {
  it('模块出口：名字、inject 只等 slots、apply 是函数', () => {
    const { definition, exports } = loadModule(async () => jsonResponse(FIXTURE))
    assert.equal(definition.id, 'dsh-whale-pal')
    assert.equal(exports.name, 'dsh-whale-pal')
    assert.deepEqual([...exports.inject], ['slots'])
    assert.equal(typeof exports.apply, 'function')
  })

  it('注册参数：settings.section / whale-pal / 鲸鲸 / order 40', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE))
    const params = page.entry.params
    assert.equal(params.name, 'settings.section')
    assert.equal(params.id, 'whale-pal')
    assert.equal(typeof params.label, 'function')
    assert.equal(params.label(), '鲸鲸')
    assert.equal(params.order, 40)
    assert.equal(typeof page.entry.component, 'function')
  })

  it('没有 slots 的 ctx 直接退场，不抛也不请求', () => {
    const { exports, calls } = loadModule(async () => jsonResponse(FIXTURE))
    assert.doesNotThrow(() => exports.apply(undefined))
    assert.doesNotThrow(() => exports.apply(null))
    assert.doesNotThrow(() => exports.apply({}))
    assert.doesNotThrow(() => exports.apply({ slots: {} }))
    assert.deepEqual(calls, [])
  })

  it('状态走文档相对路径，四块都渲染出来', async () => {
    const page = await mount(async (url) => {
      assert.equal(url, 'api/whale-pal/status')
      return jsonResponse(FIXTURE)
    })
    // 工作区清单是顺带拉的，第一条就是它；状态那条在后面。
    assert.equal(page.calls.length, 2)
    assert.equal(page.calls[0].url, 'api/whale-pal/workspaces')
    assert.equal(page.calls[1].url, 'api/whale-pal/status')
    assert.equal(page.calls[1].url.startsWith('/'), false)
    assert.match(textOf(page.loading), /在读记录，等一下/)

    const text = textOf(page.tree)
    // 输入框里的现值在 props 上，不在 children 上。
    assert.ok(controlValues(page.tree).includes('whale'), '名称现值要显示出来')
    // 库名那一格 2026-11-11 撤掉了：页面上不该再有这个输入框。
    const inputsForName = collect(page.tree).filter(
      (node) => node.type === 'input' && node.props && node.props.placeholder === '记忆空间'
    )
    assert.equal(inputsForName.length, 0, '库名不该再有输入框')
    // 库路径只给「选目录」，不给输入框：现值当文字显示。
    const inputsForPath = collect(page.tree).filter(
      (node) => node.type === 'input' && node.props && node.props.placeholder === '笔记库在哪个目录'
    )
    assert.equal(inputsForPath.length, 0, '路径不该再有输入框')
    assert.ok(text.includes(VAULT_PATH), '库里现在的路径要显示出来')
    assert.ok(text.includes('鲸鲸工作区'), '工作区那一块要在')
    assert.ok(text.includes('D:\\聊天'), '已选的目录要摆出来')
    assert.match(text, /长期记忆 7/)
    assert.match(text, /修订号 31/)
  })

  it('渲染出来的文案过禁词表', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE))
    const text = textOf(page.tree)
    const offenders = BANNED.filter((word) => text.includes(word))
    if (text.includes('!')) offenders.push('!')
    assert.deepEqual(offenders, [])
  })

  it('保存只发被改的那一个键', async () => {
    const page = await mount(async (url, options) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/settings')
      assert.equal(options.method, 'POST')
      return jsonResponse({ ok: true, applied: ['obsidianEnabled'], warnings: [] })
    })
    findButton(page.tree, '打开这个开关').props.onClick()
    await settle()

    assert.equal(page.calls.length, 3)
    const post = page.calls[2]
    assert.equal(post.url, 'api/whale-pal/settings')
    assert.equal(post.options.headers['content-type'], 'application/json')
    assert.deepEqual(JSON.parse(post.options.body), { obsidianEnabled: true })
    assert.match(textOf(page.rerender()), /打开了/)
  })

  it('403 时页面显示宿主给的那句 message，不用本地对照表顶替', async () => {
    const hostMessage = '宿主那边说这一项不能从设置页改'
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      return jsonResponse(
        { ok: false, error: 'key-not-allowed', message: hostMessage, keys: ['name'] },
        403,
      )
    })
    findButton(page.tree, '打开这个开关').props.onClick()
    await settle()

    const text = textOf(page.rerender())
    assert.ok(text.includes(hostMessage))
    assert.equal(text.includes('这个键不在我能改的范围里'), false, '有 message 就不该回落到本地文案')
  })

  it('400 时同样优先显示宿主的 message', async () => {
    const hostMessage = '这个名字超过四十个字，我没存'
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      return jsonResponse(
        { ok: false, error: 'obsidianEnabled-not-boolean', message: hostMessage },
        400,
      )
    })
    findButton(page.tree, '打开这个开关').props.onClick()
    await settle()

    assert.ok(textOf(page.rerender()).includes(hostMessage))
  })

  it('状态接口 404 时给出「宿主还没有这个接口」并留一条重试', async () => {
    const page = await mount(async () => jsonResponse({ ok: false, error: 'not-found' }, 404))
    const text = textOf(page.tree)
    assert.ok(text.includes('宿主那边还没有这个接口，设置读不出来'))
    findButton(page.tree, '再读一次')
  })

  it('宿主没给 identity 时用骨架，十一项都在、值统一落到空值口径', async () => {
    const page = await mount(async () =>
      jsonResponse({ ...FIXTURE, identity: [], editable: {}, accounting: {}, imported: null }),
    )
    const text = textOf(page.tree)
    for (const label of ['名称', '名称的含义', '自称', '自称的含义', '称呼', '称呼的含义', '底色', '价值观', '边界', '说话风格', '总结']) {
      assert.ok(text.includes(label), '骨架里应当有 ' + label)
    }
    assert.ok(text.includes('还没写 · 想起来再说'))
    assert.equal(text.includes('链接记法'), false)
    assert.equal(text.includes('接手记录'), false)
    assert.ok(text.includes('记了多少'))
  })
})


describe('客户端设置页：人格卡十一项', () => {
  it('十一项都渲染，当前值就在控件里，每项一个写入按钮', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE))
    const text = textOf(page.tree)
    for (const label of ['名称', '名称的含义', '自称', '自称的含义', '称呼', '称呼的含义', '底色', '价值观', '边界', '说话风格', '总结']) {
      assert.ok(text.includes(label), '应当有 ' + label)
    }
    // 十格全部可改：值直接摆在控件里，不用先去对话里问。
    for (const value of ['whale', '用户', '一头会记账的鲸', '自然、有边界', '自由、公平']) {
      assert.ok(controlValues(page.tree).includes(value), '现值要显示出来：' + value)
    }
    const inputs = collect(page.tree).filter((node) => node.type === 'input' && node.props.type !== 'checkbox');
    const areas = collect(page.tree).filter((node) => node.type === 'textarea');
    // 六个单行槽位 + 工作区手填路径 = 7 个输入框；四个块用文本域（库名那一格已撤）。
    assert.equal(inputs.length, 7, '单行槽位 6 个 + 工作区路径')
    // 换库那条路：一个勾选框，默认要搬。
    const toggles = collect(page.tree).filter((node) => node.type === 'input' && node.props.type === 'checkbox');
    assert.equal(toggles.length, 1, '换库时搬不搬的勾选框')
    assert.equal(toggles[0].props.checked, true, '默认勾上：换库自动搬')
    assert.equal(areas.length, 6, '底色 / 价值观 / 边界 / 说话风格 / 总结五个块 + 粘贴区')
    const writes = collect(page.tree).filter(
      (node) => node.type === 'button' && textOf(node.children) === '写入',
    )
    assert.equal(writes.length, 11, '十一项各有一个写入按钮')
    assert.ok(text.includes(CARD_HINT))
  })

  it('改一格只发这一个键，写成功后整页重读', async () => {
    const page = await mount(async (url, options) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/settings')
      assert.equal(options.method, 'POST')
      return jsonResponse({ ok: true, applied: ['values'], warnings: [] })
    })
    const area = collect(page.tree).find(
      (node) => node.type === 'textarea' && node.props.value === '自由、公平',
    )
    area.props.onChange({ target: { value: '自由、公平、正义' } })
    await settle()

    const writes = collect(page.rerender()).filter(
      (node) => node.type === 'button' && textOf(node.children) === '写入',
    )
    // 十一项顺序固定，价值观是第 8 项。
    writes[7].props.onClick()
    await settle()

    assert.equal(page.calls.length, 5, '清单 + 一次读 + 一次写 + 写成功后清单一读一次')
    assert.deepEqual(JSON.parse(page.calls[2].options.body), { values: '自由、公平、正义' })
    assert.equal(page.calls[4].url, 'api/whale-pal/status')
    assert.ok(textOf(page.rerender()).includes('记下了'))
  })

  it('宿主拒了就把宿主那句话原样显示', async () => {
    const hostMessage = '这一项超过上限了，我存不下（边界最多 2000 字）'
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      return jsonResponse({ ok: false, error: 'card-field-too-long', message: hostMessage }, 400)
    })
    const area = collect(page.tree).find(
      (node) => node.type === 'textarea' && node.props.value === '自然、有边界',
    )
    area.props.onChange({ target: { value: '想改就改' } })
    await settle()
    const writes = collect(page.rerender()).filter(
      (node) => node.type === 'button' && textOf(node.children) === '写入',
    )
    writes[6].props.onClick()
    await settle()
    const text = textOf(page.rerender())
    assert.ok(text.includes(hostMessage))
    assert.equal(text.includes('这个键不在我能改的范围里'), false, '不许回落到本地文案')
  })

  // 2026-11-11：清空一格之后「写入」是灰的，点了什么都不发——用户看着像没保存。
  it('清空一格：写入按钮可点，发的是空串，回一句「清空了」', async () => {
    const page = await mount(async (url, options) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/settings')
      assert.equal(options.method, 'POST')
      return jsonResponse({ ok: true, applied: ['title'], warnings: [] })
    })
    const input = collect(page.tree).find(
      (node) => node.type === 'input' && node.props.value === '用户',
    )
    input.props.onChange({ target: { value: '' } })
    await settle()

    const writes = collect(page.rerender()).filter(
      (node) => node.type === 'button' && textOf(node.children) === '写入',
    )
    // 十一项顺序固定，称呼是第 5 项（索引 4）。
    assert.equal(writes[4].props.disabled, false, '清空是一次改动，按钮不能灰着')
    writes[4].props.onClick()
    await settle()

    const post = page.calls.find((call) => call.url === 'api/whale-pal/settings')
    assert.deepEqual(JSON.parse(post.options.body), { title: '' })
    assert.ok(textOf(page.rerender()).includes('清空了'))
  })

  it('没改动的时候写入按钮是灰的：不让人点一个空动作', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE))
    const writes = collect(page.tree).filter(
      (node) => node.type === 'button' && textOf(node.children) === '写入',
    )
    assert.equal(writes[4].props.disabled, true, '称呼没动过，不该可点')
  })

  it('全部写进去：草稿里清空的一项也发出去，空对空的项不发', async () => {
    const page = await mount(async (url, options) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/settings')
      return jsonResponse({ ok: true, applied: ['values'], warnings: [] })
    })
    const area = collect(page.tree).find(
      (node) => node.type === 'textarea' && node.props.value === '自由、公平',
    )
    area.props.onChange({ target: { value: '' } })
    await settle()
    findButton(page.rerender(), '全部写进去').props.onClick()
    await settle()

    const post = page.calls.find((call) => call.url === 'api/whale-pal/settings')
    assert.deepEqual(JSON.parse(post.options.body), { values: '' })
  })
})

describe('客户端设置页：粘贴拆解', () => {
  const CARD_TEXT = '名称：六一\n\n## 价值观\n自由、公平\n\n## 边界\n不骂人\n\n外貌：短发'
  const PARSED = {
    ok: true,
    fields: { name: '六一', values: '自由、公平', boundaries: '不骂人' },
    rest: '外貌：短发',
    sections: [{ title: '外貌', heading: '外貌：短发', text: '', chars: 0 }],
    hits: ['name', 'values', 'boundaries'],
    chars: CARD_TEXT.length,
    total: 20,
  }

  /** 粘贴区：四个块之外唯一一个占位文字写着「把整段人格设定粘进来」的文本域。 */
  function findPaste(tree) {
    const found = collect(tree).filter(
      (node) => node.type === 'textarea' && String(node.props.placeholder).includes('把整段人格设定粘进来'),
    )
    assert.equal(found.length, 1, '应当恰好有一个粘贴区')
    return found[0]
  }

  it('拆一下：只发原文，回来填进十一项，一个字都不写盘', async () => {
    const page = await mount(async (url, options) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/card/parse')
      assert.equal(options.method, 'POST')
      assert.equal(JSON.parse(options.body).raw, CARD_TEXT)
      return jsonResponse(PARSED)
    })
    findPaste(page.tree).props.onChange({ target: { value: CARD_TEXT } })
    await settle()
    findButton(page.rerender(), '拆一下').props.onClick()
    await settle()

    const tree = page.rerender()
    const values = controlValues(tree)
    assert.ok(values.includes('六一'), '名称应当被拆出来')
    assert.ok(values.includes('自由、公平'), '价值观应当被拆出来')
    assert.ok(values.includes('不骂人'), '边界应当被拆出来')
    // 认不出的那部分另开一段原样摆着：不吞，也不冒充进内核。
    const text = textOf(tree)
    assert.ok(text.includes('没进内核'))
    assert.ok(text.includes('外貌：短发'))
    assert.equal(text.includes('拆出 3 项'), true)
    // 只解析不写：这一路没有 /settings。
    assert.equal(
      page.calls.some((call) => call.url === 'api/whale-pal/settings'),
      false,
    )
  })

  it('没进内核的段落按标题分开摆，点开是原文', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      return jsonResponse({
        ok: true,
        fields: { name: '六一' },
        hits: ['name'],
        chars: 120,
        total: 2,
        rest: '【记忆与成长】\n只记真实的事\n开头那句',
        sections: [
          { title: '记忆与成长', heading: '【记忆与成长】', text: '只记真实的事', chars: 6 },
          { title: '', heading: '', text: '开头那句', chars: 4 },
        ],
      })
    })
    findPaste(page.tree).props.onChange({ target: { value: '名称：六一' } })
    await settle()
    findButton(page.rerender(), '拆一下').props.onClick()
    await settle()

    const text = textOf(page.rerender())
    assert.ok(text.includes('另有 2 段（10 字）没进内核'), '段数和字数要一起报')
    assert.ok(text.includes('记忆与成长 · 6 字'), '段落要有名字')
    assert.ok(text.includes('开头那段 · 4 字'), '开头没标题的那段也要有名字')
    assert.ok(text.includes('只记真实的事'), '点开要能看见原文')
  })

  it('全部写进去：拆出来的几项一次发完，原文一起存档', async () => {

    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      if (url === 'api/whale-pal/card/parse') return jsonResponse(PARSED)
      return jsonResponse({
        ok: true,
        applied: ['name', 'values', 'boundaries', 'personaCard'],
        warnings: [],
      })
    })
    findPaste(page.tree).props.onChange({ target: { value: CARD_TEXT } })
    await settle()
    findButton(page.rerender(), '拆一下').props.onClick()
    await settle()
    findButton(page.rerender(), '全部写进去').props.onClick()
    await settle()

    const write = page.calls.find((call) => call.url === 'api/whale-pal/settings')
    assert.ok(write, '应当打过一次 /settings')
    const body = JSON.parse(write.options.body)
    assert.equal(body.name, '六一')
    assert.equal(body.values, '自由、公平')
    assert.equal(body.boundaries, '不骂人')
    assert.equal(body.personaCard, CARD_TEXT)
    // 没拆出来的那几项不跟着发：空白不该覆盖盘上已有的值。
    assert.equal(Object.hasOwn(body, 'temperament'), false)
    assert.equal(Object.hasOwn(body, 'language'), false)
  })

  it('一个标签都没认出来：明说没认出来，不假装拆过', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      return jsonResponse({ ok: true, fields: {}, rest: '你就是我最好的朋友', hits: [], chars: 9, total: 0 })
    })
    findPaste(page.tree).props.onChange({ target: { value: '你就是我最好的朋友' } })
    await settle()
    findButton(page.rerender(), '拆一下').props.onClick()
    await settle()
    const text = textOf(page.rerender())
    assert.ok(text.includes('一行都没归到十一项里'))
    assert.ok(text.includes('让模型帮我拆'), '要给出下一步')
  })

  it('让模型帮我拆走另一条路由，失败时把宿主那句原样显示', async () => {
    const hostMessage = '这次没拆出来，模型那边没回话或者回的东西读不懂'
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/card/split')
      return jsonResponse({ ok: false, error: 'split-failed', message: hostMessage }, 503)
    })
    findPaste(page.tree).props.onChange({ target: { value: CARD_TEXT } })
    await settle()
    findButton(page.rerender(), '让模型帮我拆').props.onClick()
    await settle()
    assert.ok(textOf(page.rerender()).includes(hostMessage))
  })

  it('让模型帮我拆：回来也带段落，拆完段落不会凭空消失', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/card/split')
      return jsonResponse({
        ok: true,
        fields: { name: '六一' },
        hits: ['name'],
        total: 2,
        rest: '外貌：短发',
        sections: [{ title: '外貌', heading: '外貌：短发', text: '', chars: 0 }],
      })
    })
    findPaste(page.tree).props.onChange({ target: { value: CARD_TEXT } })
    await settle()
    findButton(page.rerender(), '让模型帮我拆').props.onClick()
    await settle()

    const text = textOf(page.rerender())
    assert.ok(text.includes('外貌 · 0 字'), '句段要跟着模型拆的结果一起摆出来')
    assert.ok(text.includes('拆出 1 项'))
  })

  it('只认出一两项、底下还挂着段落：直说没吃准，指向模型那条', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      return jsonResponse({
        ok: true,
        fields: { name: '六一' },
        hits: ['name'],
        total: 2,
        rest: '外貌：短发',
        sections: [{ title: '外貌', heading: '外貌：短发', text: '', chars: 0 }],
      })
    })
    findPaste(page.tree).props.onChange({ target: { value: CARD_TEXT } })
    await settle()
    findButton(page.rerender(), '拆一下').props.onClick()
    await settle()

    const text = textOf(page.rerender())
    assert.ok(text.includes('只认出 1 项'))
    assert.ok(text.includes('这份写法我没吃准'))
  })

  it('模型搬进十一项的段：标出去向，不再算「没进内核」', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/card/split')
      return jsonResponse({
        ok: true,
        fields: { name: '六一', language: '对普通网友保持边界' },
        hits: ['name', 'language'],
        total: 20,
        moves: [{ from: '和不同的人相处', to: 'language' }],
        unused: [{ from: '每次开口前快速自检', why: '是检查步骤，不是设定' }],
        rest: '【和不同的人相处】\n普通网友：保持边界\n【每次开口前快速自检】\n我是真的对它有过反应吗',
        sections: [
          { title: '和不同的人相处', heading: '【和不同的人相处】', text: '普通网友：保持边界', chars: 8 },
          { title: '每次开口前快速自检', heading: '【每次开口前快速自检】', text: '我是真的对它有过反应吗', chars: 11 },
        ],
      })
    })
    findPaste(page.tree).props.onChange({ target: { value: CARD_TEXT } })
    await settle()
    findButton(page.rerender(), '让模型帮我拆').props.onClick()
    await settle()

    const text = textOf(page.rerender())
    // 段落自己的标签上要写清去了哪一项，并且不再算进「还有几段没进内核」。
    assert.ok(text.includes('和不同的人相处 · 8 字 → 说话风格'), '被搬走的段要标去向')
    assert.ok(text.includes('模型把 1 段搬进了十一项'))
    assert.ok(text.includes('还有 1 段（11 字）没进内核'))
    // 搬运清单：哪段去了哪项，人拿它和原文核对。
    assert.ok(text.includes('模型说它这样搬的（1 段）'))
    assert.ok(text.includes('「和不同的人相处」→ 说话风格'))
    // 没归的单独列，原因照模型说的写，原文仍在。
    assert.ok(text.includes('模型没归进十一项的 1 段'))
    assert.ok(text.includes('每次开口前快速自检 —— 是检查步骤，不是设定'))
    assert.ok(text.includes('1 段没归进十一项'))
    // 字段框里是搬完的结果，没写盘。
    assert.ok(controlValues(page.rerender()).includes('对普通网友保持边界'))
    assert.equal(
      page.calls.some((call) => call.url === 'api/whale-pal/settings'),
      false,
    )
  })

  it('模型没回的项：规则拆到的照原文写进去；人加的旧句子只报被盖掉，不偷偷接回来', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/card/split')
      return jsonResponse({
        ok: true,
        fields: { name: '六一' },
        hits: ['name'],
        total: 2,
        ruleFields: { name: '六一', boundaries: '不骂人' },
        rest: '外貌：短发',
        sections: [{ title: '外貌', heading: '外貌：短发', text: '', chars: 0 }],
      })
    })
    findPaste(page.tree).props.onChange({ target: { value: CARD_TEXT } })
    await settle()
    findButton(page.rerender(), '让模型帮我拆').props.onClick()
    await settle()

    const tree = page.rerender()
    const text = textOf(tree)
    // 模型跳过一项，不等于原文没写：规则认出来的边界要写进草稿，并且说清是规则补的。
    assert.ok(text.includes('模型没回 边界，按规则拆的'))
    assert.ok(text.includes('拆出 2 项'))
    // 盘上那句「不接受被骂」原文里没有，是人加的：明说这次按原文盖掉了，不接回去。
    assert.ok(text.includes('边界原来那 1 句原文里没有，这次按原文重写了'))
    const values = controlValues(tree)
    assert.ok(values.includes('不骂人'), '规则拆到的边界要写进草稿')
    assert.equal(
      values.some((value) => typeof value === 'string' && value.includes('不接受被骂')),
      false,
      '旧句子不许被偷偷贴回来',
    )
  })

  it('草稿里填过别的：拆一次以这次结果为准，脏内容挡不住规则拆到的项', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/card/split')
      return jsonResponse({
        ok: true,
        fields: { name: '六一' },
        hits: ['name'],
        total: 2,
        ruleFields: { name: '六一', boundaries: '不骂人' },
        rest: '外貌：短发',
        sections: [{ title: '外貌', heading: '外貌：短发', text: '', chars: 0 }],
      })
    })
    findPaste(page.tree).props.onChange({ target: { value: CARD_TEXT } })
    await settle()
    const area = collect(page.rerender()).find(
      (node) => node.type === 'textarea' && node.props.value === '- 不骂人\n- 不接受被骂',
    )
    assert.ok(area, '要先找到边界那一格')
    area.props.onChange({ target: { value: '456456456' } })
    await settle()
    findButton(page.rerender(), '让模型帮我拆').props.onClick()
    await settle()

    const values = controlValues(page.rerender())
    assert.ok(values.includes('不骂人'), '草稿里的旧值不该挡住这次拆出来的边界')
    assert.equal(values.some((value) => typeof value === 'string' && value.includes('456456456')), false, '脏内容要被拆出来的结果换掉')
  })

  it('模型也没拆出来：不劝它自己再来一次，只说十一项要手填', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      return jsonResponse({
        ok: true,
        fields: {},
        hits: [],
        total: 0,
        rest: '你就是我最好的朋友',
        sections: [{ title: '', heading: '', text: '你就是我最好的朋友', chars: 9 }],
      })
    })
    findPaste(page.tree).props.onChange({ target: { value: '你就是我最好的朋友' } })
    await settle()
    findButton(page.rerender(), '让模型帮我拆').props.onClick()
    await settle()

    const text = textOf(page.rerender())
    assert.ok(text.includes('模型也没拆出能归到十一项的内容'))
    assert.ok(text.includes('十一项要手填'))
    assert.equal(text.includes('这份写法我没吃准'), false, '模型已经拆过了，不许再劝点自己')
    assert.equal(text.includes('要么点「让模型帮我拆」'), false)
  })
})

describe('客户端设置页：选目录', () => {
  const PICKED = 'D:\笔记\新库'

  it('点「选目录」把宿主弹回来的路径直接存下去', async () => {
    const page = await mount(async (url, options) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      if (url === 'api/whale-pal/pick') return jsonResponse({ ok: true, path: PICKED })
      if (url === 'api/whale-pal/settings') {
        const body = JSON.parse(options.body)
        return jsonResponse({ ok: true, applied: Object.keys(body), warnings: [] })
      }
      throw new Error('不该打这个路由：' + String(url))
    })

    const button = findButton(page.tree, '选目录', { any: true })
    await button.props.onClick()

    const picked = page.calls.filter((call) => call.url === 'api/whale-pal/pick')
    assert.equal(picked.length, 1)
    assert.equal(picked[0].options.method, 'POST')

    const settings = page.calls.filter((call) => call.url === 'api/whale-pal/settings')
    assert.equal(settings.length, 1)
    assert.deepEqual(JSON.parse(settings[0].options.body), { vaultPath: PICKED })

    const tree = page.rerender()
    assert.ok(textOf(tree).includes(PICKED), '选完路径要直接显示出来')
    assert.ok(textOf(tree).includes('路径存下了'))
  })

  it('换库时取消勾选：只改指向，请求里明确带 migrateVault:false', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      if (url === 'api/whale-pal/pick') return jsonResponse({ ok: true, path: PICKED })
      if (url === 'api/whale-pal/settings') return jsonResponse({ ok: true, applied: ['vaultPath'], warnings: [] })
      throw new Error('不该打这个路由：' + String(url))
    })

    const toggle = collect(page.tree).find(
      (node) => node.type === 'input' && node.props.type === 'checkbox',
    )
    toggle.props.onChange({ target: { checked: false } })
    await findButton(page.rerender(), '选目录', { any: true }).props.onClick()

    const settings = page.calls.filter((call) => call.url === 'api/whale-pal/settings')
    assert.deepEqual(JSON.parse(settings[0].options.body), { vaultPath: PICKED, migrateVault: false })
  })

  it('换库搬成功了：提示说清搬了几个文件，并交代旧库还在', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      if (url === 'api/whale-pal/pick') return jsonResponse({ ok: true, path: PICKED })
      if (url === 'api/whale-pal/settings') {
        return jsonResponse({
          ok: true,
          applied: ['vaultPath'],
          warnings: [],
          migrated: {
            ok: true,
            moved: [
              { dir: '台账', files: 2, bytes: 90 },
              { dir: '_上下文', files: 3, bytes: 120 },
            ],
            total: { files: 5, bytes: 210 },
          },
        })
      }
      throw new Error('不该打这个路由：' + String(url))
    })

    // 第一个「选目录」在笔记库那一组；工作区总路径那个排在它后面。
    await findButton(page.tree, '选目录', { any: true }).props.onClick()
    const text = textOf(page.rerender())
    assert.ok(text.includes('台账和上下文搬过来了（5 个文件）'), text)
    assert.ok(text.includes('旧库还在原地'), text)
  })

  it('用户关掉窗口：不写设置，只说一句没选', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      if (url === 'api/whale-pal/pick') return jsonResponse({ ok: true, path: null })
      throw new Error('不该打这个路由：' + String(url))
    })

    await findButton(page.tree, '选目录', { any: true }).props.onClick()

    assert.equal(
      page.calls.filter((call) => call.url === 'api/whale-pal/settings').length,
      0,
      '没选到路径就不该动设置',
    )
    assert.ok(textOf(page.rerender()).includes('没选，路径没变'))
  })

  it('宿主没有选择窗口：503 的那句中文原样显示，路径不动', async () => {
    const hostMessage = '这台机器没给我选目录的窗口，路径可以直接粘进来'
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      if (url === 'api/whale-pal/pick') {
        return jsonResponse({ ok: false, error: 'picker-unavailable', message: hostMessage }, 503)
      }
      throw new Error('不该打这个路由：' + String(url))
    })

    await findButton(page.tree, '选目录', { any: true }).props.onClick()

    assert.equal(page.calls.filter((call) => call.url === 'api/whale-pal/settings').length, 0)
    assert.ok(textOf(page.rerender()).includes(hostMessage))
  })
})

describe('客户端设置页：没有原生选择窗口时', () => {
  it('按钮置灰，并说明路径可以直接粘', async () => {
    const page = await mount(async () =>
      jsonResponse({ ...FIXTURE, picker: { ok: true, available: false, kind: null } }),
    )
    const button = findButton(page.tree, '选目录', { any: true })
    assert.equal(button.props.disabled, true)
    assert.ok(textOf(page.tree).includes('这台机器没给我选目录的窗口，路径可以直接粘进来'))
  })

  it('宿主给了可用时按钮正常，不显示那句提示', async () => {
    const page = await mount(async () =>
      jsonResponse({ ...FIXTURE, picker: { ok: true, available: true, kind: 'native' } }),
    )
    const button = findButton(page.tree, '选目录', { any: true })
    assert.equal(button.props.disabled, false)
    assert.equal(textOf(page.tree).includes('这台机器没给我选目录的窗口'), false)
  })
})

describe('客户端设置页：装载状态', () => {
  it('正常就写一行「正常」', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE))
    const text = textOf(page.tree)
    assert.ok(text.includes('装载状态'))
    assert.ok(text.includes('正常'))
  })

  it('只读时把原因说出来，不含糊', async () => {
    const status = {
      ...FIXTURE,
      health: { ok: false, state: 'readonly', color: 'yellow', notes: ['数据目录写不了：权限不让'], grace: { active: false } },
    }
    const page = await mount(async () => jsonResponse(status))
    const text = textOf(page.tree)
    assert.ok(text.includes('只读'))
    assert.ok(text.includes('数据目录写不了：权限不让'))
  })

  it('新装复核窗口开着就报到期时间', async () => {
    const status = {
      ...FIXTURE,
      health: {
        ok: true,
        state: 'normal',
        color: 'green',
        notes: [],
        grace: { active: true, installedAt: '2026-11-01T00:00:00.000Z', readOnlyUntil: '2026-11-04T00:00:00.000Z' },
      },
    }
    const page = await mount(async () => jsonResponse(status))
    assert.ok(textOf(page.tree).includes('新装只读复核到 2026-11-04T00:00:00.000Z'))
  })

  it('宿主没给这一格就整行不出现', async () => {
    const status = { ...FIXTURE }
    delete status.health
    const page = await mount(async () => jsonResponse(status))
    assert.equal(textOf(page.tree).includes('装载状态'), false)
  })
})

describe('客户端设置页：上次升级', () => {
  it('没升过版就写「还没升过版」', async () => {
    const status = { ...FIXTURE, upgrade: { ok: true, never: true, message: '还没升过版' } }
    const page = await mount(async () => jsonResponse(status))
    const text = textOf(page.tree)
    assert.ok(text.includes('上次升级'))
    assert.ok(text.includes('还没升过版'))
  })

  it('有标记就写版本与结果，文件名进提示', async () => {
    const status = {
      ...FIXTURE,
      upgrade: { ok: true, never: false, file: '升级完成-V4.6-2026-11-03-1010.md', done: true, vaultVersion: 'V4.6' },
    }
    const page = await mount(async () => jsonResponse(status))
    const text = textOf(page.tree)
    assert.ok(text.includes('V4.6'))
    assert.ok(text.includes('跑完了：升级完成-V4.6-2026-11-03-1010.md'))
  })

  it('没有这一格就整行不出现', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE))
    assert.equal(textOf(page.tree).includes('上次升级'), false)
  })
})

describe('客户端设置页：上下文档案', () => {
  it('有档案就写份数与最近一份', async () => {
    const status = { ...FIXTURE, ctx: { ok: true, ready: true, cards: 3, lastId: 'C003', lastTopic: '索引怎么排' } }
    const page = await mount(async () => jsonResponse(status))
    const text = textOf(page.tree)
    assert.ok(text.includes('上下文档案'))
    assert.ok(text.includes('3 份'))
    assert.ok(text.includes('最近：C003 · 索引怎么排'))
    assert.ok(text.includes('用法：敲 /whale ctx 看全部'), '命令名记不住，这一格得自己写出来')
  })

  it('库里还没档案就写「还没有档案」', async () => {
    const status = { ...FIXTURE, ctx: { ok: true, ready: true, cards: 0, lastId: '', lastTopic: '' } }
    const page = await mount(async () => jsonResponse(status))
    assert.ok(textOf(page.tree).includes('还没有档案'))
  })

  it('没选笔记库就明说没地方放', async () => {
    const status = { ...FIXTURE, ctx: { ok: true, ready: false, cards: 0 } }
    const page = await mount(async () => jsonResponse(status))
    assert.ok(textOf(page.tree).includes('还没选库'))
  })

  it('没有这一格就整行不出现', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE))
    assert.equal(textOf(page.tree).includes('上下文档案'), false)
  })
})

describe('客户端设置页：联动状态', () => {
  it('装没装照宿主说的写，不自己猜', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE))
    const text = textOf(page.tree)
    assert.ok(text.includes('联动状态'))
    assert.ok(text.includes('装过 Obsidian，还没打开开关'))
    assert.equal(text.includes('还没选笔记库'), false)
  })

  it('没有笔记库时明说联动缺什么', async () => {
    const status = { ...FIXTURE, obsidian: { ...FIXTURE.obsidian, hasVault: false } }
    const page = await mount(async () => jsonResponse(status))
    assert.ok(textOf(page.tree).includes('还没选笔记库，选好之后才能联动'))
  })

  it('宿主没给这一格就整行不出现，不编一句状态', async () => {
    const status = { ...FIXTURE }
    delete status.obsidian
    const page = await mount(async () => jsonResponse(status))
    const text = textOf(page.tree)
    assert.equal(text.includes('联动状态'), false)
    assert.equal(text.includes('还没选笔记库'), false)
  })
})

describe('客户端设置页：工作区候选收进下拉', () => {
  const THREE = [
    { id: 'w1', path: 'D:\\聊天', title: '聊天' },
    { id: 'w2', path: 'D:\\AI 项目\\甲', title: '甲' },
    { id: 'w3', path: 'D:\\AI 项目\\乙', title: '' },
  ]

  const selectsOf = (tree) => collect(tree).filter((node) => node.type === 'select')
  const optionsOf = (node) => collect(node).filter((item) => item.type === 'option')
  const addButtonsOf = (tree) =>
    collect(tree).filter((node) => node.type === 'button' && textOf(node.children) === '加入')

  it('工作区再多也只多一行下拉，不一个个铺开', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE), THREE)
    const selects = selectsOf(page.tree)
    assert.equal(selects.length, 1, '候选只占一个下拉')
    const options = optionsOf(selects[0])
    // 已选过的 D:\聊天 不再当候选：占位 + 甲 + 乙。
    assert.equal(options.length, 3)
    assert.equal(options[0].props.value, '')
    assert.deepEqual(
      options.slice(1).map((node) => node.props.value),
      ['D:\\AI 项目\\甲', 'D:\\AI 项目\\乙'],
    )
    assert.equal(addButtonsOf(page.tree).length, 2, '下拉旁一个 + 手填旁一个')
  })

  it('候选都加过了就不摆下拉，明说一句', async () => {
    const status = {
      ...FIXTURE,
      editable: {
        ...FIXTURE.editable,
        whaleWorkspaces: { value: ['D:\\聊天', 'D:\\AI 项目\\甲'] },
      },
    }
    const page = await mount(async () => jsonResponse(status), THREE.slice(0, 2))
    assert.equal(selectsOf(page.tree).length, 0)
    assert.ok(textOf(page.tree).includes('宿主认识的工作区都加进来了'))
  })

  it('读不到清单就给手填那条路，不给空下拉', async () => {
    const page = await mount(async () => jsonResponse(FIXTURE), [])
    assert.equal(selectsOf(page.tree).length, 0)
    assert.ok(textOf(page.tree).includes('读不到工作区列表'))
  })

  it('挑一条点加入：整张名单一起发', async () => {
    const page = await mount(async (url) => {
      if (url === 'api/whale-pal/status') return jsonResponse(FIXTURE)
      assert.equal(url, 'api/whale-pal/settings')
      return jsonResponse({ ok: true, applied: ['whaleWorkspaces'], warnings: [] })
    }, THREE)
    selectsOf(page.tree)[0].props.onChange({ target: { value: 'D:\\AI 项目\\甲' } })
    await settle()

    addButtonsOf(page.rerender())[0].props.onClick()
    await settle()

    const post = page.calls.find((call) => call.url === 'api/whale-pal/settings')
    assert.deepEqual(JSON.parse(post.options.body), {
      whaleWorkspaces: ['D:\\聊天', 'D:\\AI 项目\\甲'],
    })
  })
})
