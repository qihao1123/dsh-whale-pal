import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { inspectImport, runImport } from '../lib/import/run.js'
import { inspectRollback, rollbackImport, undoRollback } from '../lib/import/rollback.js'
import { defaultSnapshotDir, listSnapshots } from '../lib/import/snapshot.js'
import { resolveDataPaths } from '../lib/paths.js'

// 端到端：旧根 → 新根，中间要有快照、有核对、有台账那一行，而且要能退回导入前。
// 全程临时目录，真机（~/.dsh/persona-framework、~/.dsh/whale-pal）一个字节都不碰。

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

/** 一套临时的新旧根：`withLegacy` 决定旧根里放不放状态。 */
function workspace({ withLegacy = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'whale-import-'))
  const legacyDir = join(home, 'old')
  mkdirSync(legacyDir, { recursive: true })
  if (withLegacy === true) {
    writeFileSync(join(legacyDir, 'state.json'), `${JSON.stringify(LEGACY_STATE)}\n`, 'utf8')
    writeFileSync(join(legacyDir, 'config.json'), '{}\n', 'utf8')
  }
  const resolved = resolveDataPaths({ dshHome: home, profile: 'test', dataDir: join(home, 'new'), legacyDir })
  return { home, resolved, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

describe('旧状态导入：一遍走完', () => {
  it('全新机器：不导、不留快照、不算失败', () => {
    const made = workspace({ withLegacy: false })
    try {
      const done = runImport({ resolved: made.resolved, at: '2026-11-05T00:00:00Z' })
      assert.equal(done.ok, true)
      assert.equal(done.imported, false)
      assert.equal(done.reason, 'no-legacy-state')
      assert.equal(existsSync(made.resolved.paths.state), false)
      assert.equal(existsSync(defaultSnapshotDir(made.resolved.base)), false, '不该为空机器留快照')
    } finally {
      made.cleanup()
    }
  })

  it('首次导入：写入新根、留下导入记录、存了导入前快照、旧文件置只读、台账那一行被调到', () => {
    const made = workspace()
    const records = []
    try {
      const done = runImport({ resolved: made.resolved, at: '2026-11-05T00:00:00Z', record: (report) => records.push(report) })
      assert.equal(done.imported, true, '该导就得导')
      assert.equal(existsSync(made.resolved.paths.state), true, '新根要落下状态')
      assert.equal(existsSync(made.resolved.importRecord), true, '要留下导入记录')

      // 导入前的新根是空的 → empty 快照；这是回滚要退回的那一状态。
      assert.equal(done.snapshot.ok, true)
      assert.equal(done.snapshot.empty, true)
      assert.deepEqual(listSnapshots({ dir: defaultSnapshotDir(made.resolved.base) }).map((one) => one.empty), [true])

      // 逐项核对有清单。
      assert.ok(done.checked.rows.length >= 4, '要有逐项清单')
      assert.ok(done.lines.join('\n').includes('短记忆合计'))

      // 旧文件只读：Windows 上 chmod 只认写位。
      assert.equal(done.froze.ok, true)
      assert.ok(done.froze.frozen.length >= 1)
      for (const file of done.froze.frozen) {
        assert.equal((statSync(file).mode & 0o200) === 0, true, `${file} 应已只读`)
      }

      // 台账那一行：注入的回调收到报告，且有落点可写。
      assert.equal(records.length, 1)
      assert.equal(records[0].imported, true)
      assert.equal(records[0].legacyRoot, made.resolved.legacy.root)
    } finally {
      made.cleanup()
    }
  })

  it('再导一次：不导，理由是新根已经有状态', () => {
    const made = workspace()
    try {
      runImport({ resolved: made.resolved, at: '2026-11-05T00:00:00Z', freeze: false })
      const again = runImport({ resolved: made.resolved, at: '2026-11-05T01:00:00Z', freeze: false })
      assert.equal(again.imported, false)
      assert.equal(again.reason, 'state-exists')
      assert.equal(listSnapshots({ dir: defaultSnapshotDir(made.resolved.base) }).length, 1, '第二次不该再存快照')
    } finally {
      made.cleanup()
    }
  })

  it('台账那一行写崩了也不把导入判成失败', () => {
    const made = workspace()
    try {
      const done = runImport({
        resolved: made.resolved,
        at: '2026-11-05T00:00:00Z',
        freeze: false,
        record: () => {
          throw new Error('台账写不进去')
        },
      })
      assert.equal(done.ok, true)
      assert.equal(done.imported, true)
      assert.equal(done.recordFailed, '台账写不进去')
    } finally {
      made.cleanup()
    }
  })
})

describe('旧状态导入：只读体检', () => {
  it('inspectImport 一个字节都不写', () => {
    const made = workspace()
    try {
      const seen = inspectImport({ resolved: made.resolved, at: '2026-11-05T00:00:00Z' })
      assert.equal(seen.ok, true)
      assert.equal(seen.plan.action, 'import')
      assert.equal(existsSync(made.resolved.paths.state), false, '体检不该写新根')
      assert.equal(existsSync(defaultSnapshotDir(made.resolved.base)), false, '体检不该留快照')
      assert.deepEqual(seen.legacyCounts.facts, 1)
      assert.equal(seen.lines.length > 0, true)
    } finally {
      made.cleanup()
    }
  })

  it('坏入参回 ok:false，不抛', () => {
    assert.deepEqual(inspectImport({}), { ok: false, reason: 'no-paths' })
    assert.deepEqual(runImport({}), { ok: false, reason: 'no-paths' })
    assert.deepEqual(inspectRollback({}), { ok: false, reason: 'no-paths' })
    assert.deepEqual(rollbackImport({}), { ok: false, reason: 'no-paths' })
    assert.deepEqual(undoRollback({}), { ok: false, reason: 'no-paths' })
  })
})

describe('旧状态导入：回滚', () => {
  it('导入后新根住下了：不给确认就只报「会丢什么」，不动盘', () => {
    const made = workspace()
    try {
      runImport({ resolved: made.resolved, at: '2026-11-05T00:00:00Z', freeze: false })
      const seen = inspectRollback({ resolved: made.resolved })
      assert.equal(seen.ok, true)
      assert.equal(seen.needsForce, true)
      assert.ok(seen.wouldRemove.includes('state.json'), `会丢的清单里应有 state.json，实际 ${seen.wouldRemove.join('、')}`)
      assert.ok(seen.signals.length > 0)

      const refused = rollbackImport({ resolved: made.resolved, force: false })
      assert.equal(refused.ok, false)
      assert.equal(refused.reason, 'needs-force')
      assert.equal(existsSync(made.resolved.paths.state), true, '没确认就不许动盘')
    } finally {
      made.cleanup()
    }
  })

  it('确认后回滚：新根退回导入前（空的），当前那份另存 pre-rollback', () => {
    const made = workspace()
    try {
      runImport({ resolved: made.resolved, at: '2026-11-05T00:00:00Z', freeze: false })
      const done = rollbackImport({ resolved: made.resolved, at: '2026-11-05T02:00:00Z', force: true })
      assert.equal(done.ok, true)
      assert.equal(done.restored, false, '导入前的快照是空的，所以回到空')
      assert.ok(done.removed.includes('state.json'))
      assert.equal(existsSync(made.resolved.paths.state), false)
      assert.equal(existsSync(made.resolved.importRecord), false, '导入记录也要退掉，否则下次不敢导')

      const snaps = listSnapshots({ dir: defaultSnapshotDir(made.resolved.base) })
      assert.ok(snaps.some((one) => one.label === 'pre-rollback'), '回滚本身也要可回滚')

      // 退回导入前后的样子：新根空了，于是又「该导」了。
      assert.equal(inspectImport({ resolved: made.resolved }).plan.action, 'import')
    } finally {
      made.cleanup()
    }
  })

  it('回滚错了还能退回来：undoRollback 用 pre-rollback 快照', () => {
    const made = workspace()
    try {
      runImport({ resolved: made.resolved, at: '2026-11-05T00:00:00Z', freeze: false })
      rollbackImport({ resolved: made.resolved, at: '2026-11-05T02:00:00Z', force: true })
      assert.equal(existsSync(made.resolved.paths.state), false)

      const back = undoRollback({ resolved: made.resolved, at: '2026-11-05T03:00:00Z' })
      assert.equal(back.ok, true)
      assert.equal(existsSync(made.resolved.paths.state), true, 'pre-rollback 里那份要回来')
      assert.ok(JSON.parse(readFileSync(made.resolved.paths.state, 'utf8')).revision >= 7)
    } finally {
      made.cleanup()
    }
  })

  it('没有快照时回滚明说没有，不猜', () => {
    const made = workspace({ withLegacy: false })
    try {
      assert.deepEqual(inspectRollback({ resolved: made.resolved }), {
        ok: false,
        reason: 'no-snapshot',
        snapshotDir: defaultSnapshotDir(made.resolved.base),
      })
      assert.deepEqual(undoRollback({ resolved: made.resolved }), { ok: false, reason: 'no-pre-rollback' })
    } finally {
      made.cleanup()
    }
  })
})
