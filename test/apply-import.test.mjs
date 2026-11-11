import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { apply } from '../index.js'

// 这条测的是**接线**：启动那一步（`apply`）真的会把旧状态搬过来、留导入前快照、
// 把旧文件锁成只读。搬运本身由 test/import-run.test.mjs 管，这里只管「挂上了没有」。

const LEGACY_STATE = {
  revision: 7,
  memory: {
    facts: [{ text: '甲', at: 1, session: 1, lastSeenAt: 1, lastSeenSession: 1, salience: 0.5, hits: 1, resolved: false, promoted: false }],
    preferences: [],
    events: [],
    openTopics: [],
  },
  longMemory: [{ text: '乙', kind: 'commitments', at: 1, session: 1, lastSeenAt: 1, lastSeenSession: 1, hits: 1, pinned: false }],
  traits: [],
  relationship: { commitments: [{ text: '丙', at: 1, session: 1, status: 'open', doneAt: 0, doneSession: 0 }] },
}

/** 宿主给的那几样：够人格内核与接线层起来就行。 */
function fakeContext() {
  const ctx = {
    llm: { stream: async () => ({}) },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') dispose()
    },
    on() {
      return () => {}
    },
    systemPrompt: { section: () => () => {} },
    webServer: { register: () => () => {} },
    commands: { register: () => () => {} },
    tools: { register: () => () => {} },
  }
  return ctx
}

function workspace() {
  const home = mkdtempSync(join(tmpdir(), 'whale-apply-'))
  const legacyDir = join(home, 'old')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'state.json'), `${JSON.stringify(LEGACY_STATE)}\n`, 'utf8')
  writeFileSync(join(legacyDir, 'config.json'), '{}\n', 'utf8')
  const config = { dshHome: home, profile: 'test', dataDir: join(home, 'new'), legacyDir }
  return { home, config, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

describe('启动那一步：旧状态导入的接线', () => {
  it('第一次启动就把状态搬进新根，还留下快照与只读的旧文件', () => {
    const made = workspace()
    try {
      apply(fakeContext(), made.config)

      assert.equal(existsSync(join(made.home, 'new', 'state.json')), true, '状态要搬进新根')
      assert.equal(existsSync(join(made.home, 'new', 'import-record.json')), true, '要留下导入记录')
      assert.equal(existsSync(join(made.home, 'whale-pal', 'import-snapshots', 'test')), true, '要留下导入前快照')
      assert.equal((statSync(join(made.home, 'old', 'state.json')).mode & 0o200) === 0, true, '旧文件要锁成只读')
    } finally {
      made.cleanup()
    }
  })

  it('第二次启动不再搬（新根已经有状态），也不再多留快照', () => {
    const made = workspace()
    try {
      apply(fakeContext(), made.config)
      apply(fakeContext(), made.config)
      const snapshots = join(made.home, 'whale-pal', 'import-snapshots', 'test')
      assert.equal(existsSync(snapshots), true)
      // 只有第一次那一份：重复启动不该一遍遍存快照。
      assert.equal(readdirSync(snapshots).length, 1)
      assert.equal(existsSync(join(made.home, 'new', 'state.json')), true)
    } finally {
      made.cleanup()
    }
  })
})
