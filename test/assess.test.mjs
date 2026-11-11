import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveDataPaths } from '../lib/paths.js'
import { applyPersona } from '../lib/persona/index.js'

const GOOD = '{"salience":0.5}'
const DEFAULT_MODEL = { provider: 'nezhai', model: 'deepseek-v4.1-flash' }

/**
 * 假 llm：按 provider 决定成败。
 * 真实事故里配置写死的是 `raccoon/sn-deepseek-v4-1-flash-1017`，供应商早就换成了 nezhai，
 * 于是 llm.stream 直接报错——这里用「raccoon 一律 yield 一个 finish error」复现同一件事。
 */
function fakeLlm(seen, failing) {
  return {
    async *stream(request) {
      seen.push(`${request.provider}/${request.model}`)
      if (failing.includes(request.provider)) {
        yield { type: 'finish', reason: { kind: 'error' } }
        return
      }
      yield { type: 'text-delta', text: GOOD }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function setup({ assessorModel = '', failing = ['raccoon'], defaultModel = DEFAULT_MODEL } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'whale-pal-assess-'))
  const resolved = resolveDataPaths({ dshHome: home, profile: 'desktop' })
  const seen = []
  const ctx = {
    llm: fakeLlm(seen, failing),
    agentDefaultModel: { currentSelection: () => defaultModel },
    effect(fn) {
      fn()
    },
    on() {
      return () => {}
    },
    systemPrompt: { section: () => () => {} },
    webServer: { register: () => () => {} },
  }
  const api = applyPersona(ctx, { paths: resolved.paths, log: () => {} })
  if (assessorModel) api.setConfig({ ...api.getConfig(), assessor_model: assessorModel }, 'test')
  return { home, api, seen }
}

test('配的模型挂了就退回默认模型，并且说清是从哪个退回的', async () => {
  const { home, api, seen } = setup({ assessorModel: 'raccoon/sn-deepseek-v4-1-flash-1017' })
  try {
    const result = await api.runSelfTest()
    assert.equal(result.ok, true)
    assert.equal(result.source, 'default')
    assert.equal(result.model, 'nezhai/deepseek-v4.1-flash')
    assert.equal(result.fellBackFrom, 'raccoon/sn-deepseek-v4-1-flash-1017')
    assert.deepEqual(seen, ['raccoon/sn-deepseek-v4-1-flash-1017', 'nezhai/deepseek-v4.1-flash'])
    assert.equal(result.assessment.salience, 0.5)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('配的模型没挂就照它跑，不看默认模型', async () => {
  const { home, api, seen } = setup({ assessorModel: 'nezhai/deepseek-v4.1-flash-1017' })
  try {
    const result = await api.runSelfTest()
    assert.equal(result.ok, true)
    assert.equal(result.source, 'config')
    assert.equal(result.fellBackFrom, null)
    assert.deepEqual(seen, ['nezhai/deepseek-v4.1-flash-1017'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('没配模型就直接用默认的，不做多余的一次请求', async () => {
  const { home, api, seen } = setup()
  try {
    const result = await api.runSelfTest()
    assert.equal(result.ok, true)
    assert.equal(result.source, 'default')
    assert.equal(result.fellBackFrom, null)
    assert.deepEqual(seen, ['nezhai/deepseek-v4.1-flash'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('配的就是默认模型时不重试：同一个模型不值得打两次', async () => {
  const { home, api, seen } = setup({
    assessorModel: 'nezhai/deepseek-v4.1-flash',
    failing: ['nezhai'],
  })
  try {
    const result = await api.runSelfTest()
    assert.equal(result.ok, false)
    assert.equal(result.error, 'stream-error')
    assert.equal(result.fellBackFrom, null)
    assert.deepEqual(seen, ['nezhai/deepseek-v4.1-flash'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('两个都挂时如实报错，但仍记下原本想用谁', async () => {
  const { home, api, seen } = setup({
    assessorModel: 'raccoon/sn-deepseek-v4-1-flash-1017',
    failing: ['raccoon', 'nezhai'],
  })
  try {
    const result = await api.runSelfTest()
    assert.equal(result.ok, false)
    assert.equal(result.error, 'stream-error')
    assert.equal(result.fellBackFrom, 'raccoon/sn-deepseek-v4-1-flash-1017')
    assert.deepEqual(seen, ['raccoon/sn-deepseek-v4-1-flash-1017', 'nezhai/deepseek-v4.1-flash'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('默认模型取不到时就用配置那个失败，不假装成功', async () => {
  const { home, api, seen } = setup({
    assessorModel: 'raccoon/sn-deepseek-v4-1-flash-1017',
    defaultModel: null,
  })
  try {
    const result = await api.runSelfTest()
    assert.equal(result.ok, false)
    assert.equal(result.error, 'stream-error')
    assert.equal(result.fellBackFrom, null)
    assert.equal(result.model, 'raccoon/sn-deepseek-v4-1-flash-1017')
    assert.deepEqual(seen, ['raccoon/sn-deepseek-v4-1-flash-1017'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
