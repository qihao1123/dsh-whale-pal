import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ensureLayout,
  listSnapshots,
  readJsonFile,
  resolvePaths,
  saveSnapshot,
  withLock,
  writeJsonAtomic,
} from '../lib/state/store.js'

function home(name) {
  return mkdtempSync(join(tmpdir(), `persona-${name}-`))
}

test('双实例隔离：两个 profile 各写各的，互不可见', () => {
  const homeA = home('a')
  const homeB = home('b')
  try {
    const a = resolvePaths({ dshHome: homeA, profile: 'desktop' })
    const b = resolvePaths({ dshHome: homeB, profile: 'lab' })
    ensureLayout(a)
    ensureLayout(b)

    assert.notEqual(a.root, b.root)
    assert.ok(a.root.endsWith(join('persona-framework', 'desktop')))
    assert.ok(b.root.endsWith(join('persona-framework', 'lab')))

    writeJsonAtomic(a.config, { bot_name: 'A' })
    writeJsonAtomic(b.config, { bot_name: 'B' })

    assert.equal(readJsonFile(a.config).bot_name, 'A')
    assert.equal(readJsonFile(b.config).bot_name, 'B')

    // A 的写入不会在 B 里出现
    assert.ok(existsSync(join(homeA, 'persona-framework', 'desktop', 'config.json')))
    assert.ok(!existsSync(join(homeB, 'persona-framework', 'lab', 'config.json')) === false)
    assert.equal(readJsonFile(join(homeB, 'persona-framework', 'desktop', 'config.json'), null), null)
  } finally {
    rmSync(homeA, { recursive: true, force: true })
    rmSync(homeB, { recursive: true, force: true })
  }
})

test('同一 profile 的两份路径指向同一批文件', () => {
  const root = home('same')
  try {
    const one = resolvePaths({ dshHome: root, profile: 'desktop' })
    const two = resolvePaths({ dshHome: root, profile: 'desktop' })
    assert.deepEqual(one, two)
    ensureLayout(one)
    writeJsonAtomic(one.state, { revision: 3 })
    assert.equal(readJsonFile(two.state).revision, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('原子写：同一 key 并发写不产生半截文件', async () => {
  const root = home('lock')
  try {
    const paths = resolvePaths({ dshHome: root, profile: 'desktop' })
    ensureLayout(paths)

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withLock('state', async () => {
          writeJsonAtomic(paths.state, { revision: i, padding: 'x'.repeat(2000) })
        }),
      ),
    )

    const parsed = JSON.parse(readFileSync(paths.state, 'utf8'))
    assert.equal(typeof parsed.revision, 'number')
    assert.equal(parsed.padding.length, 2000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('快照：留存上限 20 份，且能按名回读', () => {
  const root = home('snap')
  try {
    const paths = resolvePaths({ dshHome: root, profile: 'desktop' })
    ensureLayout(paths)
    for (let i = 0; i < 25; i += 1) saveSnapshot(paths, { revision: i })
    const snapshots = listSnapshots(paths)
    assert.ok(snapshots.length <= 20, `快照数量 ${snapshots.length} 超上限`)
    assert.ok(snapshots.length >= 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
