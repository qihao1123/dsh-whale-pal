/**
 * 纯逻辑：装没装、库在哪、深链怎么拼。
 *
 * 这一层不碰磁盘，所以「开关关着时到底读没读」这种硬约束能直接数调用次数。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_VAULT_NAME,
  EXCLUDED,
  STATE,
  deepLink,
  describeState,
  detectObsidian,
  hasExcludedSegment,
  isExcluded,
  parseObsidianConfig,
  resolveVault,
} from '../lib/vault.js'

function spy(value) {
  const calls = []
  const fn = (...args) => {
    calls.push(args)
    return typeof value === 'function' ? value(...args) : value
  }
  fn.calls = calls
  return fn
}

describe('vault：开关关着时只回答装没装', () => {
  it('配置在 → installed，且一个字节都不解析、不查进程', () => {
    const readText = spy('')
    const processes = spy([])
    const info = detectObsidian({
      enabled: false,
      configFile: 'C:/x/obsidian.json',
      fileExists: () => true,
      readText,
      processes,
    })
    assert.equal(info.state, STATE.INSTALLED)
    assert.equal(info.source, 'existence')
    assert.equal(readText.calls.length, 0)
    assert.equal(processes.calls.length, 0)
  })

  it('配置不在 → absent，同样不查进程', () => {
    const processes = spy([])
    const info = detectObsidian({
      enabled: false,
      configFile: 'C:/x/obsidian.json',
      fileExists: () => false,
      processes,
    })
    assert.equal(info.state, STATE.ABSENT)
    assert.equal(processes.calls.length, 0)
  })
})

describe('vault：开关开着才读库列表', () => {
  const config = JSON.stringify({
    vaults: {
      old: { path: 'D:/旧库', ts: 100, open: false },
      new: { path: 'D:/新库', ts: 300, open: true },
      broken: { path: '   ', ts: 999 },
    },
  })

  it('拿到库、按 ts 倒序、空路径丢掉', () => {
    const info = detectObsidian({
      enabled: true,
      configFile: 'C:/x/obsidian.json',
      fileExists: () => true,
      readText: () => config,
    })
    assert.equal(info.state, STATE.READY)
    assert.deepEqual(
      info.vaults.map((vault) => vault.path),
      ['D:/新库', 'D:/旧库'],
    )
    assert.equal(info.vaults[0].open, true)
  })

  it('配置在但一个库都没有 → installed-no-vault', () => {
    const info = detectObsidian({
      enabled: true,
      configFile: 'C:/x/obsidian.json',
      fileExists: () => true,
      readText: () => JSON.stringify({ vaults: {} }),
    })
    assert.equal(info.state, STATE.INSTALLED_NO_VAULT)
  })

  it('配置缺失但进程活着 → running-no-config；进程不在 → absent', () => {
    const running = detectObsidian({
      enabled: true,
      configFile: 'C:/x/obsidian.json',
      fileExists: () => false,
      processes: () => ['Obsidian.exe', 'chrome.exe'],
    })
    assert.equal(running.state, STATE.RUNNING_NO_CONFIG)

    const idle = detectObsidian({
      enabled: true,
      configFile: 'C:/x/obsidian.json',
      fileExists: () => false,
      processes: () => ['chrome.exe'],
    })
    assert.equal(idle.state, STATE.ABSENT)
  })

  it('坏 JSON 不抛，当没有库', () => {
    assert.deepEqual(parseObsidianConfig('{not json'), { vaults: [] })
    assert.deepEqual(parseObsidianConfig(''), { vaults: [] })
    assert.deepEqual(parseObsidianConfig('{"vaults":[1,2]}'), { vaults: [] })
  })
})

describe('vault：库路径与深链', () => {
  it('路径空着就不可用', () => {
    assert.deepEqual(resolveVault({}), { ok: false, error: 'vaultPath-required' })
    assert.deepEqual(resolveVault({ knowledge: { vaultPath: '   ' } }), {
      ok: false,
      error: 'vaultPath-required',
    })
    assert.deepEqual(resolveVault({ knowledge: { vaultPath: ' D:/v ' } }), { ok: true, path: 'D:/v' })
  })

  it('深链：反斜杠转正斜杠、去 .md、两端编码', () => {
    const link = deepLink({ vaultName: '记忆空间', relPath: '日记\\2026-11-03.md' })
    assert.equal(link, 'obsidian://open?vault=%E8%AE%B0%E5%BF%86%E7%A9%BA%E9%97%B4&file=%E6%97%A5%E8%AE%B0%2F2026-11-03')
  })

  it('深链：开头的 ./ 与 / 都去掉；库名空着用默认名', () => {
    const link = deepLink({ relPath: './a/b.md' })
    assert.equal(link, `obsidian://open?vault=${encodeURIComponent(DEFAULT_VAULT_NAME)}&file=a%2Fb`)
    assert.equal(deepLink({ relPath: '/a.md' }), `obsidian://open?vault=${encodeURIComponent(DEFAULT_VAULT_NAME)}&file=a`)
  })

  it('深链：路径空着回空串，不拼半个链接', () => {
    assert.equal(deepLink({ relPath: '' }), '')
    assert.equal(deepLink({ relPath: '   ' }), '')
    assert.equal(deepLink({}), '')
  })

  it('排除目录只有三个，且认得出嵌在中间的', () => {
    assert.deepEqual([...EXCLUDED], ['.obsidian', '.trash', '.git'])
    assert.equal(isExcluded('.obsidian'), true)
    assert.equal(isExcluded('笔记'), false)
    assert.equal(hasExcludedSegment('.obsidian/workspace.json'), true)
    assert.equal(hasExcludedSegment('a\\.trash\\b.md'), true)
    assert.equal(hasExcludedSegment('a/b.md'), false)
  })

  it('每个状态都有一句人话，不空着', () => {
    for (const state of Object.values(STATE)) {
      assert.equal(typeof describeState(state), 'string')
      assert.notEqual(describeState(state), '')
    }
    assert.equal(describeState('weird'), '还没判过')
  })
})
