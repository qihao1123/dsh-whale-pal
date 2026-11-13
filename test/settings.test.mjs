/**
 * 设置层：六个身份槽位（空白可填一次、填过只读）、设施四项、白名单、路径校验。
 *
 * 这里用假的 api（真读写临时目录里的 config.json / state.json），
 * 不碰人格内核，也不碰真的 ~/.dsh。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { COPY } from '../lib/copy.js'
import { CARD_KEYS } from '../lib/persona-card.js'
import {
  DEFAULT_VAULT_NAME,
  IDENTITY_KEYS,
  applyIdentityChange,
  applySettings,
  describeAccounting,
  describeCard,
  describeEditable,
  describeIdentity,
  describeStatus,
  normalizeExtras,
  validateVaultPath,
  workspaceKey,
} from '../lib/settings.js'

function makeApi(initialConfig = { bot_name: 'whale', language_baseline: '自然口语' }) {
  const dir = mkdtempSync(join(tmpdir(), 'whale-settings-'))
  const configPath = join(dir, 'config.json')
  const statePath = join(dir, 'state.json')
  let config = { ...initialConfig }
  let state = {
    revision: 7,
    selfName: { current: 'whale', history: [{ name: 'whale', from: 0, to: null, trigger: 'initial' }] },
    titleName: { current: '用户', history: [{ name: '用户', from: 0, to: null, trigger: 'initial' }] },
    memory: { facts: ['a', 'b'], preferences: ['p'], events: [], openTopics: ['t'] },
    longMemory: [{ text: 'x' }, { text: 'y' }],
    commitments: [{ status: 'open' }, { status: 'lapsed' }],
  }
  writeFileSync(configPath, JSON.stringify(config), 'utf8')
  writeFileSync(statePath, JSON.stringify(state), 'utf8')
  return {
    paths: { config: configPath, state: statePath },
    getConfig: () => config,
    getState: () => state,
    setConfig(next) {
      config = next
      writeFileSync(configPath, JSON.stringify(config), 'utf8')
      return { ok: true, config, warnings: [] }
    },
    setState(next) {
      state = next
      writeFileSync(statePath, JSON.stringify(state), 'utf8')
      return state
    },
    buildView: () => ({ ok: true }),
  }
}

describe('normalizeExtras', () => {
  it('空配置回默认值：鲸鲸名单是空的、库名有默认、链接档是 wiki、三个含义都空', () => {
    const extras = normalizeExtras({})
    assert.deepEqual(extras.whaleWorkspaces, [])
    assert.equal(extras.knowledge.vaultName, DEFAULT_VAULT_NAME)
    assert.equal(extras.knowledge.vaultPath, '')
    assert.equal(extras.obsidian.enabled, false)
    assert.equal(extras.obsidian.linkMode, 'wiki')
    assert.deepEqual(extras.identity, { nameMeaning: '', selfNameMeaning: '', titleMeaning: '' })
    assert.equal(extras.onboarding, undefined)
  })

  it('写坏的值回到默认，不抛错', () => {
    const extras = normalizeExtras({
      whaleWorkspaces: '不是数组',
      knowledge: { vaultName: 42, vaultPath: null },
      obsidian: { enabled: 'yes', linkMode: 'pdf' },
      identity: { nameMeaning: 9 },
    })
    assert.deepEqual(extras.whaleWorkspaces, [])
    assert.equal(extras.knowledge.vaultName, DEFAULT_VAULT_NAME)
    assert.equal(extras.obsidian.enabled, false)
    assert.equal(extras.obsidian.linkMode, 'wiki')
    assert.equal(extras.identity.nameMeaning, '')
  })

  it('旧的 identity.meaning 还能兜底到名称的含义', () => {
    const extras = normalizeExtras({ identity: { meaning: '旧键留下的' } })
    assert.equal(extras.identity.nameMeaning, '旧键留下的')
  })
})

describe('原文存档里的段落', () => {
  it('没进十项的段落从原文现拆：不落盘，也不算进内核', () => {
    const raw = ['名称：六一', '【外貌】', '黑色短发', '【和不同的人相处】', '熟人可以更放松'].join('\n')
    const card = describeCard({ personaCard: { raw, at: '2026-11-13T00:00:00.000Z' } })
    assert.equal(card.chars, raw.length)
    assert.deepEqual(card.sections.map((item) => item.title), ['外貌', '和不同的人相处'])
    assert.equal(card.sections[0].text, '黑色短发')
    assert.equal(card.sectionChars, '黑色短发'.length + '熟人可以更放松'.length)
  })

  it('还没存过原文：空数组，不是 null', () => {
    const card = describeCard({})
    assert.equal(card.raw, '')
    assert.deepEqual(card.sections, [])
    assert.equal(card.sectionChars, 0)
  })
})

describe('人格卡十一项', () => {
  it('顺序固定，十一项全部可写', () => {
    const api = makeApi({ bot_name: 'whale' })
    const rows = describeIdentity(api.getConfig(), api.getState())
    assert.deepEqual(rows.map((row) => row.key), CARD_KEYS)
    assert.deepEqual(rows.map((row) => row.label), [
      '名称',
      '名称的含义',
      '自称',
      '自称的含义',
      '称呼',
      '称呼的含义',
      '底色',
      '价值观',
      '边界',
      '说话风格',
      '总结',
    ])
    assert.equal(rows[0].value, 'whale')
    assert.equal(rows[0].writable, true)
    assert.equal(rows[0].hint, COPY.identityHint)
    // 自称只有一条 initial 记录 → 内核的占位，不算人选过
    assert.equal(rows[2].value, '')
    assert.equal(rows[2].writable, true)
    assert.equal(rows[2].hint, COPY.identityHint)
    // 称呼同理，没填过就还空着
    assert.equal(rows[4].value, '')
    assert.equal(rows[4].writable, true)
    assert.equal(rows[3].writable, true)
    assert.equal(rows[3].hint, COPY.identityHint)
    // 另外两个含义都没值 → 可填
    for (const key of ['nameMeaning', 'titleMeaning']) {
      const row = rows.find((entry) => entry.key === key)
      assert.equal(row.value, '')
      assert.equal(row.writable, true)
      assert.equal(row.hint, COPY.identityHint)
      assert.equal(row.action, COPY.actionFill)
    }
  })

  it('设置页填过的称呼仍然可改（内核会把空名那条过滤掉，只剩一条）', () => {
    const api = makeApi({ bot_name: 'whale' })
    api.setState({
      ...api.getState(),
      titleName: {
        current: '老王',
        history: [{ name: '老王', from: 1793575165678, to: null, trigger: 'settings-page' }],
      },
    })
    const title = describeIdentity(api.getConfig(), api.getState()).find((row) => row.key === 'title')
    assert.equal(title.value, '老王')
    assert.equal(title.writable, true)
  })

  it('改过名字之后仍然可改', () => {
    const api = makeApi({ bot_name: 'whale' })
    const state = api.getState()
    api.setState({
      ...state,
      titleName: {
        current: '老王',
        history: [
          { name: '用户', from: 0, to: 10, trigger: 'initial' },
          { name: '老王', from: 10, to: null, trigger: 'settings-page' },
        ],
      },
    })
    const rows = describeIdentity(api.getConfig(), api.getState())
    const title = rows.find((row) => row.key === 'title')
    assert.equal(title.value, '老王')
    assert.equal(title.writable, true)
    assert.equal(title.hint, COPY.identityHint)
  })

  it('全空的新装状态：十一项都可填', () => {
    const api = makeApi({})
    api.setState({
      revision: 1,
      selfName: { current: '', history: [] },
      titleName: { current: '', history: [] },
      memory: { facts: [], preferences: [], events: [], openTopics: [] },
      longMemory: [],
      commitments: [],
    })
    const rows = describeIdentity(api.getConfig(), api.getState())
    assert.equal(rows.filter((row) => row.writable).length, 11)
    assert.deepEqual(rows.filter((row) => row.writable).map((row) => row.key), CARD_KEYS)
    for (const row of rows) {
      // 十一项都不垫默认值：说话风格以前会兜一句「自然口语…」，现在空就是空，
      // 界面写「还没写」、内核也写「（未填写）」，两边同一份事实。
      assert.equal(row.value, '')
    }
    // 底色 / 价值观 / 边界 是块，说话风格也是一块：界面按行数不同的控件渲染。
    const blockKeys = rows.filter((row) => row.multiline).map((row) => row.key)
    assert.deepEqual(blockKeys, ['temperament', 'values', 'boundaries', 'language', 'summary'])
  })
})

describe('设施项可改', () => {
  it('路径永不给预填值；库名已经不在可改项里', () => {
    const editable = describeEditable({ knowledge: { vaultName: '记忆空间' } })
    assert.equal(editable.vaultPath.value, '')
    // 2026-11-11 撤掉：库名在设置页里看不到落点，也不再收写。
    assert.equal(editable.vaultName, undefined)
    assert.deepEqual(editable.whaleWorkspaces.value, [])
  })

  it('链接记法固定双链：设置页没有这一项，配置里存过别的也归一成 wiki', () => {
    // 只接个人库，双链一种就够，所以这一项从设置页撤掉，也不再收写。
    assert.equal(describeEditable({}).linkMode, undefined)
    assert.equal(normalizeExtras({ obsidian: { linkMode: 'markdown' } }).obsidian.linkMode, 'wiki')

    const api = makeApi()
    const before = readFileSync(api.paths.config, 'utf8')
    const rejected = applySettings(api, api.paths, { linkMode: 'wiki' })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.status, 403)
    assert.equal(rejected.error, 'key-not-allowed')
    assert.equal(readFileSync(api.paths.config, 'utf8'), before)
  })

  it('含义超长拒收：回一句带上限，一个字节都不落盘', () => {
    const api = makeApi({})
    const before = readFileSync(api.paths.config, 'utf8')
    const result = applySettings(api, api.paths, { nameMeaning: '一'.repeat(201) })
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.equal(result.error, 'card-field-too-long')
    assert.match(result.message, /最多 200 字/)
    assert.equal(readFileSync(api.paths.config, 'utf8'), before)

    // 正好 200 字照收
    const ok = applySettings(api, api.paths, { nameMeaning: '一'.repeat(200) })
    assert.equal(ok.ok, true)
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).identity.nameMeaning.length, 200)
  })

  it('白名单外的键一律拒：改不动人格底稿', () => {
    const api = makeApi()
    // 评估器开关只能改配置，设置页没有这一项。
    const result = applySettings(api, api.paths, { assessor_mode: 'every-turn' })
    assert.equal(result.ok, false)
    assert.equal(result.status, 403)
    assert.equal(result.error, 'key-not-allowed')
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.equal(saved.language_baseline, '自然口语')
    assert.equal(saved.selfName, undefined)
  })

  it('合法目录写进 knowledge.vaultPath，其它配置原样留着', () => {
    const api = makeApi()
    const result = applySettings(api, api.paths, { vaultPath: api.paths.config.replace(/config\.json$/, '') })
    assert.equal(result.ok, true)
    assert.deepEqual(result.applied, ['vaultPath'])
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.equal(saved.bot_name, 'whale')
    assert.equal(saved.language_baseline, '自然口语')
    assert.ok(saved.knowledge.vaultPath.length > 0)
    assert.deepEqual(saved.whaleWorkspaces, [])
  })

  it('路径不存在就拒，并给一句人话', () => {
    const api = makeApi()
    const missing = join(tmpdir(), 'whale-not-here-9f3a')
    assert.equal(existsSync(missing), false)
    const result = applySettings(api, api.paths, { vaultPath: missing })
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.match(result.message, /不存在/)
    assert.equal(result.error, 'vaultPath-not-a-directory')
    assert.equal(validateVaultPath(missing).ok, false)
  })

  it('文件不是目录也拒', () => {
    const api = makeApi()
    const file = api.paths.config
    const result = applySettings(api, api.paths, { vaultPath: file })
    assert.equal(result.ok, false)
    assert.match(result.message, /不是文件夹/)
    assert.equal(result.error, 'vaultPath-not-a-directory')
  })

  it('换库：台账和上下文搬过去，配置指向新库，源不动', () => {
    const api = makeApi()
    const oldVault = mkdtempSync(join(tmpdir(), 'whale-vault-old-'))
    mkdirSync(join(oldVault, '台账'), { recursive: true })
    writeFileSync(join(oldVault, '台账', '事件.md'), '| 时间 |\n| --- |\n| 11-11 |\n', 'utf8')
    mkdirSync(join(oldVault, '_上下文'), { recursive: true })
    writeFileSync(join(oldVault, '_上下文', '索引.md'), '| C001 |\n', 'utf8')
    // 人的笔记：跟着库走的是插件自己那两块，这份不该过去
    writeFileSync(join(oldVault, '我的笔记.md'), '人的', 'utf8')

    assert.equal(applySettings(api, api.paths, { vaultPath: oldVault }).ok, true)

    const newVault = mkdtempSync(join(tmpdir(), 'whale-vault-new-'))
    const result = applySettings(api, api.paths, { vaultPath: newVault })

    assert.equal(result.ok, true)
    assert.ok(result.migrated, '应该带一份迁移结果')
    assert.equal(result.migrated.total.files, 2)
    assert.deepEqual(result.migrated.moved.map((item) => item.dir).sort(), ['_上下文', '台账'].sort())

    assert.equal(readFileSync(join(newVault, '台账', '事件.md'), 'utf8'), '| 时间 |\n| --- |\n| 11-11 |\n')
    assert.equal(existsSync(join(newVault, '_上下文', '索引.md')), true)
    assert.equal(existsSync(join(newVault, '我的笔记.md')), false)
    assert.equal(existsSync(join(oldVault, '台账', '事件.md')), true, '源库原样留着')

    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.equal(saved.knowledge.vaultPath, newVault)
    // 开关本身不是配置项，不许写进盘里
    assert.equal(saved.migrateVault, undefined)
  })

  it('换库：新库里已有非空台账就整单拒，配置还指旧库', () => {
    const api = makeApi()
    const oldVault = mkdtempSync(join(tmpdir(), 'whale-busy-old-'))
    mkdirSync(join(oldVault, '台账'), { recursive: true })
    writeFileSync(join(oldVault, '台账', '事件.md'), '旧账', 'utf8')
    assert.equal(applySettings(api, api.paths, { vaultPath: oldVault }).ok, true)

    const newVault = mkdtempSync(join(tmpdir(), 'whale-busy-new-'))
    mkdirSync(join(newVault, '台账'), { recursive: true })
    writeFileSync(join(newVault, '台账', '事件.md'), '新库自己的账', 'utf8')

    const result = applySettings(api, api.paths, { vaultPath: newVault })
    assert.equal(result.ok, false)
    assert.equal(result.status, 409)
    assert.equal(result.error, 'target-busy')
    assert.match(result.message, /不合并/)
    assert.equal(readFileSync(join(newVault, '台账', '事件.md'), 'utf8'), '新库自己的账')
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).knowledge.vaultPath, oldVault)
  })

  it('换库：说 migrateVault:false 就只改指向，不搬', () => {
    const api = makeApi()
    const oldVault = mkdtempSync(join(tmpdir(), 'whale-skip-old-'))
    mkdirSync(join(oldVault, '台账'), { recursive: true })
    writeFileSync(join(oldVault, '台账', '事件.md'), '旧账', 'utf8')
    assert.equal(applySettings(api, api.paths, { vaultPath: oldVault }).ok, true)

    const newVault = mkdtempSync(join(tmpdir(), 'whale-skip-new-'))
    const result = applySettings(api, api.paths, { vaultPath: newVault, migrateVault: false })

    assert.equal(result.ok, true)
    assert.equal(result.migrated, undefined)
    assert.equal(existsSync(join(newVault, '台账')), false)
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).knowledge.vaultPath, newVault)
  })

  it('换库：搬成了但配置没写进去，新库那份副本撤掉，旧库照旧用', () => {
    const api = makeApi()
    const oldVault = mkdtempSync(join(tmpdir(), 'whale-failland-old-'))
    mkdirSync(join(oldVault, '台账'), { recursive: true })
    writeFileSync(join(oldVault, '台账', '事件.md'), '旧账', 'utf8')
    mkdirSync(join(oldVault, '_上下文'), { recursive: true })
    writeFileSync(join(oldVault, '_上下文', '索引.md'), '| C001 |\n', 'utf8')
    assert.equal(applySettings(api, api.paths, { vaultPath: oldVault }).ok, true)

    const newVault = mkdtempSync(join(tmpdir(), 'whale-failland-new-'))
    writeFileSync(join(newVault, '人的笔记.md'), '人的', 'utf8')

    // 写配置这一步失败：搬完的副本必须撤回去，否则下次换库会撞自己的副本。
    api.setConfig = () => ({ ok: false })
    const result = applySettings(api, api.paths, { vaultPath: newVault })

    assert.equal(result.ok, false)
    assert.equal(result.status, 500)
    assert.equal(result.error, 'config-write-failed')
    assert.equal(result.message, COPY.settingsWriteFailed)
    assert.equal(existsSync(join(newVault, '台账')), false, '落地的副本要撤掉')
    assert.equal(existsSync(join(newVault, '_上下文')), false)
    assert.equal(existsSync(join(newVault, '人的笔记.md')), true, '新库里不是插件的东西，一件不动')
    assert.equal(readFileSync(join(oldVault, '台账', '事件.md'), 'utf8'), '旧账', '源一直没动')
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).knowledge.vaultPath, oldVault)
  })

  it('换库：旧库没东西可搬、写配置又抛错，不崩也不留副本', () => {
    const api = makeApi()
    const oldVault = mkdtempSync(join(tmpdir(), 'whale-throw-old-'))
    writeFileSync(join(oldVault, '只有人的笔记.md'), 'x', 'utf8')
    assert.equal(applySettings(api, api.paths, { vaultPath: oldVault }).ok, true)

    const newVault = mkdtempSync(join(tmpdir(), 'whale-throw-new-'))
    api.setConfig = () => {
      throw new Error('disk full')
    }
    const result = applySettings(api, api.paths, { vaultPath: newVault })

    assert.equal(result.ok, false)
    assert.equal(result.error, 'config-write-failed')
    assert.equal(existsSync(join(newVault, '台账')), false)
  })

  it('换库：写状态失败时配置一个字都不动，落地的副本也撤掉', () => {
    const api = makeApi()
    const oldVault = mkdtempSync(join(tmpdir(), 'whale-statefail-old-'))
    mkdirSync(join(oldVault, '台账'), { recursive: true })
    writeFileSync(join(oldVault, '台账', '事件.md'), '旧账', 'utf8')
    assert.equal(applySettings(api, api.paths, { vaultPath: oldVault }).ok, true)

    const newVault = mkdtempSync(join(tmpdir(), 'whale-statefail-new-'))
    // 状态写不进去（落盘那一步炸）：配置是这一单的提交点，轮到它之前失败必须整单退。
    api.setState = () => {
      throw new Error('disk full')
    }
    const result = applySettings(api, api.paths, { vaultPath: newVault, selfName: '新自称' })

    assert.equal(result.ok, false)
    assert.equal(result.status, 500)
    assert.equal(result.error, 'state-write-failed')
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).knowledge.vaultPath, oldVault, '配置还指旧库')
    assert.equal(existsSync(join(newVault, '台账')), false, '落地的副本要撤掉')
    assert.equal(readFileSync(join(oldVault, '台账', '事件.md'), 'utf8'), '旧账')
  })

  it('换库：状态写上去了但配置没写成，状态退回原样', () => {
    const api = makeApi()
    const oldVault = mkdtempSync(join(tmpdir(), 'whale-stateback-old-'))
    mkdirSync(join(oldVault, '台账'), { recursive: true })
    writeFileSync(join(oldVault, '台账', '事件.md'), '旧账', 'utf8')
    assert.equal(applySettings(api, api.paths, { vaultPath: oldVault }).ok, true)
    const before = JSON.parse(readFileSync(api.paths.state, 'utf8')).selfName.current

    const newVault = mkdtempSync(join(tmpdir(), 'whale-stateback-new-'))
    api.setConfig = () => ({ ok: false })
    const result = applySettings(api, api.paths, { vaultPath: newVault, selfName: '新自称' })

    assert.equal(result.ok, false)
    assert.equal(result.error, 'config-write-failed')
    assert.equal(result.message, COPY.settingsWriteFailed)
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).knowledge.vaultPath, oldVault)
    assert.equal(existsSync(join(newVault, '台账')), false)
    assert.equal(
      JSON.parse(readFileSync(api.paths.state, 'utf8')).selfName.current,
      before,
      '配置没落盘，刚写的自称得退回去',
    )
  })

  it('换库：状态退不回去时如实说，不假装整单干净', () => {
    const api = makeApi()
    const oldVault = mkdtempSync(join(tmpdir(), 'whale-statestuck-old-'))
    mkdirSync(join(oldVault, '台账'), { recursive: true })
    writeFileSync(join(oldVault, '台账', '事件.md'), '旧账', 'utf8')
    assert.equal(applySettings(api, api.paths, { vaultPath: oldVault }).ok, true)

    let calls = 0
    api.setState = (next) => {
      calls += 1
      if (calls === 2) throw new Error('第二次也写不进去')
      return next
    }
    api.setConfig = () => ({ ok: false })
    const newVault = mkdtempSync(join(tmpdir(), 'whale-statestuck-new-'))
    const result = applySettings(api, api.paths, { vaultPath: newVault, selfName: '新自称' })

    assert.equal(result.ok, false)
    assert.equal(result.error, 'config-write-failed')
    assert.equal(result.message, COPY.settingsStateKeepFailed)
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).knowledge.vaultPath, oldVault)
  })

  it('鲸鲸工作区只收路径列表，收得进去也读得回来', () => {
    const api = makeApi()
    const ok = applySettings(api, api.paths, { whaleWorkspaces: ['D:\\聊天'] })
    assert.equal(ok.ok, true)
    assert.deepEqual(JSON.parse(readFileSync(api.paths.config, 'utf8')).whaleWorkspaces, ['D:\\聊天'])

    const notArray = applySettings(api, api.paths, { whaleWorkspaces: 'D:\\聊天' })
    assert.equal(notArray.ok, false)
    assert.equal(notArray.status, 400)
    assert.equal(notArray.error, 'whaleWorkspaces-not-array')

    const bad = applySettings(api, api.paths, { whaleWorkspaces: [42] })
    assert.equal(bad.ok, false)
    assert.equal(bad.error, 'whaleWorkspaces-not-string')

    const tooMany = applySettings(api, api.paths, {
      whaleWorkspaces: Array.from({ length: 21 }, (_, index) => `D:\\w${index}`),
    })
    assert.equal(tooMany.ok, false)
    assert.equal(tooMany.error, 'whaleWorkspaces-too-many')
  })

  it('同一个目录写两种写法只留一条', () => {
    const api = makeApi()
    const result = applySettings(api, api.paths, { whaleWorkspaces: ['D:\\聊天', 'd:/聊天/', 'D:\\别的'] })
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(readFileSync(api.paths.config, 'utf8')).whaleWorkspaces, ['D:\\聊天', 'D:\\别的'])
  })

  it('目录比较：分隔符、尾斜杠归一，Windows 上大小写不敏感', () => {
    assert.equal(workspaceKey('D:\\a\\b\\'), workspaceKey('d:/a/b'))
    assert.equal(workspaceKey(''), '')
    assert.equal(workspaceKey(null), '')
  })

  it('打开联动却没有库路径：不存，回一句缺什么', () => {
    // 判据原文：路径为空时设置页不能保存，依赖库的功能不可用。
    const api = makeApi({})
    const before = readFileSync(api.paths.config, 'utf8')
    const result = applySettings(api, api.paths, { obsidianEnabled: true })
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.equal(result.error, 'vaultPath-required')
    assert.equal(result.message, COPY.vaultPathRequiredForObsidian)
    assert.equal(readFileSync(api.paths.config, 'utf8'), before)
  })

  it('同一个请求里先给路径再开开关，就存得下', () => {
    const api = makeApi({})
    const dir = api.paths.config.replace(/config\.json$/, '')
    const result = applySettings(api, api.paths, { obsidianEnabled: true, vaultPath: dir })
    assert.equal(result.ok, true)
    assert.deepEqual(result.applied, ['vaultPath', 'obsidianEnabled'])
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.equal(saved.obsidian.enabled, true)
    assert.ok(saved.knowledge.vaultPath.length > 0)
  })
})

describe('身份槽位写入：空白填一次、填过就拒', () => {
  it('名称填进 bot_name，含义填进 identity', () => {
    const api = makeApi({})
    api.setState({
      revision: 1,
      selfName: { current: '', history: [] },
      titleName: { current: '', history: [] },
      memory: { facts: [], preferences: [], events: [], openTopics: [] },
      longMemory: [],
      commitments: [],
    })
    const result = applySettings(api, api.paths, { name: '小六', nameMeaning: '随手起的' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.applied, ['name', 'nameMeaning'])
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.equal(saved.bot_name, '小六')
    assert.equal(saved.identity.nameMeaning, '随手起的')
    assert.equal(saved.identity.selfNameMeaning, '')
  })

  it('自称可以直接从设置页填', () => {
    const api = makeApi({})
    api.setState({
      revision: 1,
      selfName: { current: '', history: [] },
      titleName: { current: '', history: [] },
      memory: { facts: [], preferences: [], events: [], openTopics: [] },
      longMemory: [],
      commitments: [],
    })
    const result = applySettings(api, api.paths, { selfName: '六一' })
    assert.equal(result.ok, true)
    assert.equal(api.getState().selfName.current, '六一')
  })

  it('称呼写进 state 并留 history，trigger 记 settings-page', () => {
    const api = makeApi({})
    api.setState({
      revision: 1,
      selfName: { current: '', history: [] },
      titleName: { current: '', history: [] },
      memory: { facts: [], preferences: [], events: [], openTopics: [] },
      longMemory: [],
      commitments: [],
    })
    const result = applySettings(api, api.paths, { title: '老王' })
    assert.equal(result.ok, true)
    const state = api.getState()
    assert.equal(state.titleName.current, '老王')
    assert.equal(state.titleName.history.at(-1).trigger, 'settings-page')
  })

  it('已有值的槽位也能改，新值落盘', () => {
    const api = makeApi({ bot_name: 'whale' })
    const result = applySettings(api, api.paths, { name: '小六' })
    assert.equal(result.ok, true)
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).bot_name, '小六')
  })

  it('超长拒收；空白照收（清空是一项合法改动）', () => {
    const api = makeApi({})
    assert.equal(applySettings(api, api.paths, { title: 'x'.repeat(41) }).error, 'card-field-too-long')

    // 2026-11-11：把称呼清空后点写入，页面上曾经什么都不发生（宿主 400 identity-empty）。
    const cleared = applySettings(api, api.paths, { title: '   ' })
    assert.equal(cleared.ok, true)
    assert.deepEqual(cleared.applied, ['title'])
    assert.equal(api.getState().titleName.current, '')
    assert.equal(describeIdentity(api.getConfig(), api.getState()).find((row) => row.key === 'title').value, '')
  })

  it('清空名称：bot_name 写成空串，内核回退到「助手」', () => {
    const api = makeApi({ bot_name: 'whale' })
    const result = applySettings(api, api.paths, { name: '' })
    assert.equal(result.ok, true)
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).bot_name, '')
    assert.equal(describeIdentity(api.getConfig(), api.getState()).find((row) => row.key === 'name').value, '')
  })

  it('清空含义、底色都照收，空字段不挡住同一个请求里的其他项', () => {
    const api = makeApi({ bot_name: 'whale', core_temperament: '自然' })
    const result = applySettings(api, api.paths, { nameMeaning: '', temperament: '' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.applied, ['nameMeaning', 'temperament'])
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.equal(saved.identity.nameMeaning, '')
    assert.equal(saved.core_temperament, '')
  })

  it('清空说话风格：交回内核默认那句', () => {
    const api = makeApi({ bot_name: 'whale', language_baseline: '自然口语' })
    const result = applySettings(api, api.paths, { language: '' })
    assert.equal(result.ok, true)
    // 配置层把空串兜回默认值：界面显示的就是真正生效的那句。
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.equal(saved.language_baseline, '')
  })

  it('多行字段保留换行：边界是一串条目，压成一行就读不出层次', () => {
    const api = makeApi({})
    const boundaries = '- 不主动骂人、不侮辱他人\n- 不接受被骂，被骂会还击'
    const result = applySettings(api, api.paths, { boundaries })
    assert.equal(result.ok, true)
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    // config 里存的是内核直接读的 extra_boundaries（config 层会顺手做清洗）。
    assert.equal(saved.core_temperament, '')
    assert.ok(saved.extra_boundaries.includes('\n'))
    assert.ok(saved.extra_boundaries.includes('被骂会还击'))
  })

  it('原文存档只留档，不进十项', () => {
    const api = makeApi()
    const raw = '## 名称\n六一\n\n## 价值观\n自由、公平'
    const result = applySettings(api, api.paths, { personaCard: raw })
    assert.equal(result.ok, true)
    assert.deepEqual(result.applied, ['personaCard'])
    const saved = JSON.parse(readFileSync(api.paths.config, 'utf8'))
    assert.equal(saved.personaCard.raw, raw)
    assert.equal(typeof saved.personaCard.at, 'string')
    // 只存档不改字段
    assert.equal(saved.bot_name, 'whale')

    const tooLong = applySettings(api, api.paths, { personaCard: 'x'.repeat(10001) })
    assert.equal(tooLong.ok, false)
    assert.equal(tooLong.error, 'personaCard-too-long')
  })
})

describe('对话里改身份：理由必填、可以覆盖', () => {
  it('没给理由不改', () => {
    const api = makeApi({ bot_name: 'whale' })
    const result = applyIdentityChange(api, api.paths, { key: 'name', value: '小六' })
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.equal(result.error, 'reason-required')
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).bot_name, 'whale')
  })

  it('给了理由就能覆盖已有值，理由进 audit detail', () => {
    const api = makeApi({ bot_name: 'whale' })
    const result = applyIdentityChange(api, api.paths, {
      key: 'name',
      value: '小六',
      reason: '用户说旧名字不合适',
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.applied, ['name'])
    assert.equal(JSON.parse(readFileSync(api.paths.config, 'utf8')).bot_name, '小六')
  })

  it('未知键拒', () => {
    const api = makeApi()
    const result = applyIdentityChange(api, api.paths, { key: 'mood', value: 'x', reason: 'y' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'key-not-allowed')
  })

  it('自称也能从对话里改，history 关旧开新', () => {
    const api = makeApi()
    const result = applyIdentityChange(api, api.paths, {
      key: 'selfName',
      value: '六一',
      reason: '用户想换个自称',
    })
    assert.equal(result.ok, true)
    const state = api.getState()
    assert.equal(state.selfName.current, '六一')
    assert.equal(state.selfName.history[0].to === null, false)
    assert.equal(state.selfName.history.at(-1).trigger, 'conversation')
  })

  it('清空也得给理由，给了就撤掉这一项', () => {
    const api = makeApi({ bot_name: 'whale' })
    assert.equal(applyIdentityChange(api, api.paths, { key: 'title', value: '' }).error, 'reason-required')
    const result = applyIdentityChange(api, api.paths, {
      key: 'title',
      value: '   ',
      reason: '用户说不用称呼了',
    })
    assert.equal(result.ok, true)
    assert.equal(api.getState().titleName.current, '')
  })
})

describe('页脚数字与状态体', () => {
  it('只数实测值', () => {
    const api = makeApi()
    const line = describeAccounting(api.getState())
    assert.deepEqual(line, {
      shortFacts: 2,
      shortPreferences: 1,
      shortEvents: 0,
      shortOpenTopics: 1,
      longMemory: 2,
      commitments: 1,
      revision: 7,
    })
  })

  it('/status 的四个块都在', () => {
    const api = makeApi()
    const dir = mkdtempSync(join(tmpdir(), 'whale-import-'))
    const importRecord = join(dir, 'import-record.json')
    writeFileSync(
      importRecord,
      JSON.stringify({ from: 'persona-framework', at: '2026-11-01T11:53:39+08:00', diff: [] }),
      'utf8',
    )
    const payload = describeStatus({ api, importRecord })
    assert.equal(payload.ok, true)
    assert.equal(payload.identity.length, 11)
    // 原文存档这一格：没存过就是空串，不是 undefined。
    assert.equal(payload.card.raw, '')
    assert.equal(payload.card.chars, 0)
    assert.equal(payload.readOnly, undefined)
    assert.ok(payload.editable.vaultPath)
    assert.equal(payload.imported.from, 'persona-framework')
    assert.deepEqual(payload.imported.diff, [])
    mkdirSync(dir, { recursive: true })
  })
})
