import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { backupsOf, copyVerified, moveMany, moveVerified, sameVolume, stash, volumeKey } from '../lib/backup.js'

const roots = []

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-backup-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('复制要逐字校验：成功了才说成功', () => {
  const dir = scratch()
  const from = join(dir, 'a.md')
  const to = join(dir, 'sub', 'b.md')
  writeFileSync(from, '内容', 'utf8')
  const result = copyVerified(from, to)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(to, 'utf8'), '内容')
})

test('复制源不存在：回 copy-failed，不假装成功', () => {
  const dir = scratch()
  const result = copyVerified(join(dir, '没有.md'), join(dir, 'x.md'))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'copy-failed')
  assert.equal(existsSync(join(dir, 'x.md')), false)
})

test('搬运：同卷也是复制校验后删源，源确实没了、目标内容对', () => {
  const dir = scratch()
  const from = join(dir, 'a.md')
  const to = join(dir, 'b.md')
  writeFileSync(from, '搬过去', 'utf8')
  const result = moveVerified(from, to)
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'copy-then-remove')
  assert.equal(existsSync(from), false)
  assert.equal(readFileSync(to, 'utf8'), '搬过去')
})

test('搬运源不存在：直接回 source-missing', () => {
  const dir = scratch()
  const result = moveVerified(join(dir, '空.md'), join(dir, '目标.md'))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'source-missing')
})

test('卷判定：同一目录同卷，不同盘符不同卷', () => {
  const dir = scratch()
  assert.equal(sameVolume(dir, join(dir, 'x.md')), true)
  assert.notEqual(volumeKey(dir), '')
  if (process.platform === 'win32') {
    const other = 'Z:\\'
    if (existsSync(other) === false) {
      assert.equal(sameVolume(dir, other), false)
    }
  }
})

test('多份一起搬：中途失败要停下，并报出已经搬过的', () => {
  const dir = scratch()
  const a = join(dir, 'a.md')
  const b = join(dir, 'b.md')
  writeFileSync(a, 'A', 'utf8')
  const result = moveMany([
    [a, join(dir, 'a2.md')],
    [b, join(dir, 'b2.md')],
  ])
  assert.equal(result.ok, false)
  assert.equal(result.error, 'source-missing')
  assert.equal(result.failedAt, b)
  assert.equal(result.moved.length, 1)
  assert.equal(readFileSync(join(dir, 'a2.md'), 'utf8'), 'A')
})

test('做备份：拿到的备份能判定，内容与原文件一致', () => {
  const dir = scratch()
  const file = join(dir, 'notes.md')
  writeFileSync(file, '原样', 'utf8')
  const result = stash(file)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(result.backup, 'utf8'), '原样')
  assert.equal(backupsOf(file).length, 1)
})

test('做备份：源不存在就不编，回 source-missing', () => {
  const dir = scratch()
  const result = stash(join(dir, '没有.md'))
  assert.equal(result.ok, false)
  assert.equal(result.error, 'source-missing')
})

test('做备份时给 keep，会顺手修剪到那么多份', () => {
  const dir = scratch()
  const file = join(dir, 'notes.md')
  writeFileSync(file, 'v', 'utf8')
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 4; i += 1) {
    writeFileSync(`${file}.bak-2026-0${i + 1}-01T00-00-00-000Z`, `旧${i}`, 'utf8')
  }
  const result = stash(file, { keep: 2 })
  assert.equal(result.ok, true)
  assert.equal(backupsOf(file).length, 2)
})
