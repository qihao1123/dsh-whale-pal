import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'
import { ensureStateImported } from '../lib/migrate.js'
import { resolveDataPaths } from '../lib/paths.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'whale-pal-migrate-'))
}

function fakeContext() {
  const sections = []
  return {
    sections,
    ctx: {
      llm: { stream: async () => ({}) },
      effect(fn) {
        fn()
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
        register() {
          return () => {}
        },
      },
    },
  }
}

// 旧插件留下的一份最小 state：够 normalizeState 走完，又能看出计数对不对。
function writeLegacy(home, { revision = 356, facts = 2 } = {}) {
  const root = join(home, 'persona-framework', 'desktop')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ bot_name: 'whale', core_temperament: '自然', values_ordering: [] }),
    'utf8',
  )
  const facts_ = Array.from({ length: facts }, (_, i) => ({ text: `事实 ${i}`, kind: 'fact', at: 1, session: 's1' }))
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      revision,
      sessionOrdinal: 176,
      selfName: { current: 'whale', history: [{ name: '六一', from: 1, to: 2, trigger: 'rename' }] },
      titleName: { current: '用户', history: [] },
      relationship: { stage: '熟识', trust: 0.8, familiarity: 0.7, boundaries: [], commitments: [{ text: '答应过', at: 1, session: 's1', status: 'open' }], address: {} },
      memory: { facts: facts_, preferences: [], events: [], openTopics: [] },
      longMemory: [{ text: '长记忆', kind: 'milestone', at: 1, session: 's1', hits: 0, pinned: false }],
      traits: [],
      values: [],
      audit: { lastSeq: 389 },
    }),
    'utf8',
  )
  return root
}

test('旧状态导入一次：计数对得上，第二次不再导', () => {
  const home = tempHome()
  try {
    writeLegacy(home)
    const resolved = resolveDataPaths({ dshHome: home, profile: 'desktop' })

    const first = ensureStateImported({ ...resolved, log: () => {} })
    assert.equal(first.imported, true)
    assert.deepEqual(first.diff, [])
    assert.equal(first.counts.revision, 356)
    assert.equal(first.counts.facts, 2)
    assert.equal(first.counts.longMemory, 1)
    assert.equal(first.counts.commitments, 1)

    const record = JSON.parse(readFileSync(resolved.importRecord, 'utf8'))
    assert.equal(record.revision, 356)
    assert.deepEqual(record.diff, [])

    const second = ensureStateImported({ ...resolved, log: () => {} })
    assert.equal(second.imported, false)
    assert.equal(second.reason, 'state-exists')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('导进来的状态是 v6 的 11 个顶层键', () => {
  const home = tempHome()
  try {
    writeLegacy(home)
    const resolved = resolveDataPaths({ dshHome: home, profile: 'desktop' })
    ensureStateImported({ ...resolved, log: () => {} })
    const state = JSON.parse(readFileSync(resolved.paths.state, 'utf8'))
    // v6：状态机拆掉后只剩身份 + 记忆 + 承诺 + 审计。
    // 12 = stateVersion / createdAt / updatedAt / revision / sessionOrdinal /
    //      selfName / titleName / memory / longMemory / memorySeq / commitments / audit
    assert.equal(Object.keys(state).length, 12)
    assert.equal(state.memorySeq > 0, true, '导入的记忆条目要补上编号')
    assert.equal(state.selfName.current, 'whale')
    assert.equal(state.commitments[0].text, '答应过')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有旧状态时不导、不写标记', () => {
  const home = tempHome()
  try {
    const resolved = resolveDataPaths({ dshHome: home, profile: 'desktop' })
    const result = ensureStateImported({ ...resolved, log: () => {} })
    assert.equal(result.imported, false)
    assert.equal(result.reason, 'no-legacy-state')
    assert.equal(existsSync(resolved.importRecord), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('旧插件还挂着时不启动，免得多说一遍人格', () => {
  const home = tempHome()
  try {
    writeLegacy(home)
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(
      join(profileDir, 'package.json'),
      JSON.stringify({
        dependencies: { 'dsh-persona-framework': 'link:whatever' },
        dsh: { profile: { bundles: ['dsh-persona-framework'] } },
      }),
      'utf8',
    )
    const { ctx, sections } = fakeContext()
    const api = apply(ctx, { dshHome: home, profile: 'desktop' })
    assert.equal(api, null)
    assert.equal(sections.length, 0)
    assert.equal(existsSync(join(home, 'whale-pal', 'desktop', 'state.json')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('旧插件卸掉后正常启动，注入两段', () => {
  const home = tempHome()
  try {
    writeLegacy(home)
    const profileDir = join(home, 'profiles', 'desktop')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: [] } } }), 'utf8')

    const { ctx, sections } = fakeContext()
    const api = apply(ctx, { dshHome: home, profile: 'desktop' })
    assert.ok(api)
    assert.ok(sections.some((s) => s.name === 'whale-pal/kernel'))
    assert.ok(sections.some((s) => s.name === 'whale-pal/state'))
    assert.ok(existsSync(join(home, 'whale-pal', 'desktop', 'state.json')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
