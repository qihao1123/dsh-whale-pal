/**
 * 换库迁移：只搬 `台账/` 和 `_上下文/`，只复制不删源，目标非空就停。
 *
 * 每个用例都在临时目录里造真文件，不用假 fs —— 这个功能的错法全在
 * 「复制少了、覆盖了、把人的东西也搬了」这几种，只有真读写才验得出来。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { migrateVault, realPathOf, undoMigrate } from '../lib/vault-migrate.js'

function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `whale-migrate-${name}-`))
}

function seedSource(root) {
  mkdirSync(join(root, '台账'), { recursive: true })
  writeFileSync(join(root, '台账', '事件.md'), '# 事件\n\n| 时间 |\n| --- |\n| 11-11 |\n', 'utf8')
  writeFileSync(join(root, '台账', '待交接.md'), '# 待交接\n', 'utf8')
  mkdirSync(join(root, '台账', '.bak-archive'), { recursive: true })
  writeFileSync(join(root, '台账', '.bak-archive', '事件.md.bak-旧'), 'old', 'utf8')

  mkdirSync(join(root, '_上下文', '压缩档案', '原文'), { recursive: true })
  writeFileSync(join(root, '_上下文', '索引.md'), '| C001 |\n', 'utf8')
  writeFileSync(join(root, '_上下文', '压缩档案', 'C001.md'), '# C001\n\n摘要\n', 'utf8')
  writeFileSync(join(root, '_上下文', '压缩档案', '原文', 'C001.txt'), '原文很长'.repeat(500), 'utf8')

  // 人的东西：一个字都不该出现在新库
  writeFileSync(join(root, '我的笔记.md'), '这是人的笔记', 'utf8')
  mkdirSync(join(root, '项目规划', '某项目'), { recursive: true })
  writeFileSync(join(root, '项目规划', '某项目', '计划.md'), '计划', 'utf8')
  return root
}

describe('migrateVault', () => {
  it('首次填库：旧路径是空的，没东西可搬，也不算失败', () => {
    const to = tempDir('first')
    assert.deepEqual(migrateVault({ from: '', to }), { ok: true, skipped: 'no-source' })
    assert.deepEqual(migrateVault({ from: '   ', to }), { ok: true, skipped: 'no-source' })
  })

  it('同一个库：realpath 一样就不搬', () => {
    const root = seedSource(tempDir('same'))
    const result = migrateVault({ from: root, to: root })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, 'same-vault')
    // 没留下临时目录
    assert.equal(readdirSync(root).filter((name) => name.startsWith('.whale-pal-migrating-')).length, 0)
  })

  it('源里那两个目录都不在：skipped，不建空壳', () => {
    const from = tempDir('empty-from')
    const to = tempDir('empty-to')
    writeFileSync(join(from, '只有人的笔记.md'), 'x', 'utf8')
    const result = migrateVault({ from, to })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, 'nothing-to-move')
    assert.equal(existsSync(join(to, '台账')), false)
    assert.equal(existsSync(join(to, '_上下文')), false)
  })

  it('正常搬：两个目录连子目录和备份一起过去，人的文件不动，源还在', () => {
    const from = seedSource(tempDir('ok-from'))
    const to = tempDir('ok-to')
    const result = migrateVault({ from, to })

    assert.equal(result.ok, true)
    assert.equal(result.skipped, undefined)
    assert.deepEqual(
      result.moved.map((item) => item.dir).sort(),
      ['_上下文', '台账'].sort(),
    )
    // 台账 3 个（含 .bak-archive 里那份），_上下文 3 个（索引 + 卡片 + 原文）
    assert.equal(result.total.files, 6)

    // 插件的两块：一个不少
    assert.equal(readFileSync(join(to, '台账', '事件.md'), 'utf8'), readFileSync(join(from, '台账', '事件.md'), 'utf8'))
    assert.equal(existsSync(join(to, '台账', '.bak-archive', '事件.md.bak-旧')), true)
    assert.equal(existsSync(join(to, '_上下文', '索引.md')), true)
    assert.equal(existsSync(join(to, '_上下文', '压缩档案', 'C001.md')), true)
    assert.equal(existsSync(join(to, '_上下文', '压缩档案', '原文', 'C001.txt')), true)

    // 人的地盘：一个都不能带过去
    assert.equal(existsSync(join(to, '我的笔记.md')), false)
    assert.equal(existsSync(join(to, '项目规划')), false)

    // 源没被删、没被改
    assert.equal(existsSync(join(from, '台账', '事件.md')), true)
    assert.equal(existsSync(join(from, '_上下文', '索引.md')), true)

    // 临时目录清干净了
    assert.equal(readdirSync(to).filter((name) => name.startsWith('.whale-pal-migrating-')).length, 0)
  })

  it('目标里已经有非空的台账：停下报 busy，目标一个字节都没动', () => {
    const from = seedSource(tempDir('busy-from'))
    const to = tempDir('busy-to')
    mkdirSync(join(to, '台账'))
    writeFileSync(join(to, '台账', '事件.md'), '新库自己的账', 'utf8')

    const result = migrateVault({ from, to })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'target-busy')
    assert.deepEqual(result.dirs, ['台账'])
    assert.equal(readFileSync(join(to, '台账', '事件.md'), 'utf8'), '新库自己的账')
    // 另一个目录也不许抢先搬过去
    assert.equal(existsSync(join(to, '_上下文')), false)
    assert.equal(readdirSync(to).filter((name) => name.startsWith('.whale-pal-migrating-')).length, 0)
  })

  it('目标里是空目录：让位后接管', () => {
    const from = seedSource(tempDir('emptyto-from'))
    const to = tempDir('emptyto-to')
    mkdirSync(join(to, '台账'))
    mkdirSync(join(to, '_上下文'))

    const result = migrateVault({ from, to })
    assert.equal(result.ok, true)
    assert.equal(existsSync(join(to, '台账', '事件.md')), true)
    assert.equal(existsSync(join(to, '_上下文', '索引.md')), true)
  })

  it('目标不存在：不替人建库', () => {
    const from = seedSource(tempDir('missing-to-from'))
    const missing = join(tmpdir(), 'whale-没这个库-77c1')
    assert.equal(existsSync(missing), false)
    const result = migrateVault({ from, to: missing })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'target-missing')
    assert.equal(existsSync(missing), false)
  })

  it('源不在了：当没东西可搬，不当失败', () => {
    const missing = join(tmpdir(), 'whale-旧库没啦-3d2e')
    const to = tempDir('gone-to')
    assert.equal(realPathOf(missing), null)
    const result = migrateVault({ from: missing, to })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, 'source-missing')
  })
})

describe('undoMigrate', () => {
  it('撤回落地的副本：新库干净如初，源还在，下次换库不再撞 busy', () => {
    const from = seedSource(tempDir('undo-from'))
    const to = tempDir('undo-to')
    writeFileSync(join(to, '人的笔记.md'), '人的', 'utf8')
    const done = migrateVault({ from, to })
    assert.equal(done.ok, true)
    assert.equal(existsSync(join(to, '台账')), true)

    const undone = undoMigrate(done)
    assert.equal(undone.ok, true)
    assert.deepEqual(undone.removed.slice().sort(), ['_上下文', '台账'].sort())
    assert.deepEqual(undone.left, [])
    assert.equal(existsSync(join(to, '台账')), false)
    assert.equal(existsSync(join(to, '_上下文')), false)
    assert.equal(existsSync(join(to, '人的笔记.md')), true, '新库里不是插件的东西，一件不动')
    assert.equal(existsSync(join(from, '台账', '事件.md')), true, '源从头到尾没动过')

    // 撤掉之后重来一次：不会被自己上一次的副本判成 target-busy
    const again = migrateVault({ from, to })
    assert.equal(again.ok, true)
    assert.equal(existsSync(join(to, '台账', '事件.md')), true)
  })

  it('没真搬过的东西：什么都不做，不报错', () => {
    assert.deepEqual(undoMigrate({ ok: true, skipped: 'same-vault' }), { ok: true, removed: [], left: [] })
    assert.deepEqual(undoMigrate(null), { ok: true, removed: [], left: [] })
    assert.deepEqual(undoMigrate({ ok: true, moved: [] }), { ok: true, removed: [], left: [] })
  })
})
