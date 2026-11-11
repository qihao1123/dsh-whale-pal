import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  ARCHIVE_DIR,
  ARCHIVE_KEEP,
  BACKUP_KEEP,
  writerGate,
  backupIsSound,
  backupNameOf,
  copyTree,
  listArchive,
  listBackups,
  pruneArchive,
  pruneBackups,
  restoreLatest,
  sameBytes,
  writeWithBackup,
} from '../lib/atomic.js'

const roots = []

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-atomic-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

test('新文件：写进去就是那串字，不产生备份', () => {
  const file = join(scratch(), 'notes.md')
  const result = writeWithBackup(file, '第一版')
  assert.equal(result.ok, true)
  assert.equal(result.backup, null)
  assert.equal(readFileSync(file, 'utf8'), '第一版')
  assert.deepEqual(listBackups(file), [])
})

test('覆盖已有文件：先留一份旧内容的备份，再换新内容', () => {
  const file = join(scratch(), 'notes.md')
  writeFileSync(file, '旧内容', 'utf8')
  const result = writeWithBackup(file, '新内容')
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '新内容')
  const backups = listBackups(file)
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(backups[0], 'utf8'), '旧内容')
  // 备份要能判定：字节相同、创建时间不早于源的最后修改。
  assert.equal(backupIsSound(file, backups[0]), false, '源已经改成新内容，旧备份不该被当成当前内容的备份')
})

test('读回不一致：用备份还原回去，并如实说回滚了', () => {
  const file = join(scratch(), 'notes.md')
  writeFileSync(file, '旧内容', 'utf8')
  const result = writeWithBackup(file, '新内容', { hooks: { readBack: () => '被别的东西改了' } })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'read-back-mismatch')
  assert.equal(result.rolledBack, true)
  assert.equal(readFileSync(file, 'utf8'), '旧内容')
})

test('rename 之前断电：原文件一个字节没动，也不留临时文件', () => {
  const dir = scratch()
  const file = join(dir, 'notes.md')
  writeFileSync(file, '旧内容', 'utf8')
  const result = writeWithBackup(file, '新内容', {
    hooks: {
      beforeRename: () => {
        throw new Error('模拟断电')
      },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'rename-failed')
  assert.equal(result.rolledBack, false)
  assert.equal(readFileSync(file, 'utf8'), '旧内容')
  const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('写到一半（只落了一半字节）：读回不一致，同样回滚', () => {
  const file = join(scratch(), 'notes.md')
  writeFileSync(file, '完整旧内容', 'utf8')
  const result = writeWithBackup(file, '完整新内容', { hooks: { write: (text) => text.slice(0, 3) } })
  assert.equal(result.ok, false)
  assert.equal(result.rolledBack, true)
  assert.equal(readFileSync(file, 'utf8'), '完整旧内容')
})

test('备份只留最近的 10 份，删的是最旧的', () => {
  const file = join(scratch(), 'notes.md')
  writeFileSync(file, 'v0', 'utf8')
  for (let i = 1; i <= 13; i += 1) {
    // 时间戳精度到毫秒，连着写会撞名，所以显式排一份时间。
    writeWithBackup(file, `v${i}`, { keep: BACKUP_KEEP, hooks: {} })
    const backups = listBackups(file)
    assert.ok(backups.length <= BACKUP_KEEP, `第 ${i} 次之后备份数 ${backups.length} 超了`)
  }
  assert.equal(listBackups(file).length, BACKUP_KEEP)
})

test('列备份新的在前，修剪只删自己的备份', () => {
  const dir = scratch()
  const file = join(dir, 'notes.md')
  writeFileSync(`${file}.bak-2026-01-01T00-00-00-000Z`, '最早的', 'utf8')
  writeFileSync(`${file}.bak-2026-06-01T00-00-00-000Z`, '中间的', 'utf8')
  writeFileSync(join(dir, '别人的.md'), '别动我', 'utf8')
  const backups = listBackups(file)
  assert.equal(backups.length, 2)
  assert.ok(backups[0].endsWith('2026-06-01T00-00-00-000Z'))
  const removed = pruneBackups(file, { keep: 1 })
  assert.equal(removed.length, 1)
  assert.equal(listBackups(file).length, 1)
  assert.equal(existsSync(join(dir, '别人的.md')), true)
  // 第二批之后：挤出去的备份**不硬删**，挪进 .bak-archive/ 还在盘上。
  assert.equal(existsSync(removed[0]), true)
  assert.ok(removed[0].includes(ARCHIVE_DIR))
  assert.equal(readFileSync(removed[0], 'utf8'), '最早的')
})

test('归档只留 ARCHIVE_KEEP 份：超了就删最旧的，同一个归档里别人的备份不动', () => {
  const dir = scratch()
  const file = join(dir, 'notes.md')
  writeFileSync(file, 'x', 'utf8')
  const archive = join(dir, ARCHIVE_DIR)
  mkdirSync(archive, { recursive: true })
  // 手工造一批老备份：戳记用递增序号，字典序就是时间序。
  const total = ARCHIVE_KEEP + 5
  const nameOf = (i) => join(archive, `notes.md.bak-2026-01-01T00-00-${String(i).padStart(3, '0')}Z`)
  for (let i = 0; i < total; i += 1) writeFileSync(nameOf(i), `v${i}`, 'utf8')
  const other = join(archive, '别人的.md.bak-2026-01-01T00-00-000Z')
  writeFileSync(other, '别人的', 'utf8')

  assert.equal(pruneArchive(file).length, total - ARCHIVE_KEEP)
  assert.equal(listArchive(file).length, ARCHIVE_KEEP)
  assert.equal(existsSync(nameOf(0)), false, '最旧的那份要删掉')
  assert.equal(existsSync(nameOf(total - 1)), true, '最新的那份必须留着')
  assert.equal(existsSync(other), true, '别的文件的备份不许碰')
})

test('写很多次之后归档不再无限长（每写一次最多挪一份进去，但总数封顶）', () => {
  const dir = scratch()
  const file = join(dir, 'ledger.md')
  writeFileSync(file, 'v0', 'utf8')
  for (let i = 1; i <= ARCHIVE_KEEP * 2; i += 1) {
    const result = writeWithBackup(file, `v${i}`, { keep: 1 })
    assert.equal(result.ok, true)
  }
  const archived = listArchive(file).length
  assert.ok(archived <= ARCHIVE_KEEP, `归档攒到了 ${archived} 份，超过上限 ${ARCHIVE_KEEP}`)
  assert.equal(readFileSync(file, 'utf8'), `v${ARCHIVE_KEEP * 2}`)
})

test('还原：从最近一份备份盖回去；没有备份就说没有', () => {
  const dir = scratch()
  const file = join(dir, 'notes.md')
  assert.deepEqual(restoreLatest(file), { ok: false, error: 'no-backup', backup: null })
  writeFileSync(file, '旧内容', 'utf8')
  writeFileSync(backupNameOf(file), '旧内容', 'utf8')
  writeFileSync(file, '被人改坏了', 'utf8')
  const result = restoreLatest(file)
  assert.equal(result.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '旧内容')
})

test('字节比较：同内容不同文件为真，长度不同为假', () => {
  const dir = scratch()
  const a = join(dir, 'a.txt')
  const b = join(dir, 'b.txt')
  writeFileSync(a, '一样', 'utf8')
  writeFileSync(b, '一样', 'utf8')
  assert.equal(sameBytes(a, b), true)
  writeFileSync(b, '不一样', 'utf8')
  assert.equal(sameBytes(a, b), false)
  assert.equal(sameBytes(a, join(dir, '不存在.txt')), false)
})

test('真进程在 rename 前退出：目标文件是完整的旧的，残留的 .tmp 由下一次写清掉', () => {
  const dir = scratch()
  const file = join(dir, 'notes.md')
  writeFileSync(file, '旧内容', 'utf8')
  const script = `
    import { writeWithBackup } from ${JSON.stringify(new URL('../lib/atomic.js', import.meta.url).href)}
    writeWithBackup(${JSON.stringify(file)}, '新内容', { hooks: { beforeRename: () => process.exit(1) } })
  `
  const scriptPath = join(dir, 'crash.mjs')
  writeFileSync(scriptPath, script, 'utf8')
  let failed = false
  try {
    execFileSync(process.execPath, [scriptPath], { stdio: 'pipe' })
  } catch {
    failed = true
  }
  assert.equal(failed, true, '子进程应当以非零码退出')
  // 判据是「没有半个文件」：目标文件要么是完整的旧的、要么是完整的新内容，绝不是半截。
  assert.equal(readFileSync(file, 'utf8'), '旧内容')
  // 崩溃确实会留下 .tmp（进程没机会收尾），这不是错，但下次写必须自己清掉。
  const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  assert.equal(leftovers.length, 1, '崩在 rename 之前会留一个 .tmp，如实记录这个事实')
  const again = writeWithBackup(file, '第三次')
  assert.equal(again.ok, true)
  assert.equal(readFileSync(file, 'utf8'), '第三次')
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [])
})

test('writerGate：盘上 revision 比内存新就拦，相等或更旧都放行', () => {
  const dir = scratch()
  const file = join(dir, 'state.json')

  // 盘上没有这份文件：第一次写，放行。
  assert.deepEqual(writerGate({ file, expectedRevision: 0 }), { ok: true, diskRevision: 0 })

  writeFileSync(file, JSON.stringify({ revision: 7 }), 'utf8')
  // 内存基线 7：一致，放行。
  assert.equal(writerGate({ file, expectedRevision: 7 }).ok, true)
  // 内存基线 5：盘上更新 = 有人从外面写过，拦。
  const blocked = writerGate({ file, expectedRevision: 5 })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'external-write')
  assert.equal(blocked.diskRevision, 7)
  // 内存基线 9：盘上更旧（文件被还原过），不该拿它当拦路理由。
  assert.equal(writerGate({ file, expectedRevision: 9 }).ok, true)

  // 坏 JSON：不拿坏文件当拦路理由，交给读回校验去发现。
  writeFileSync(file, '{ 坏的', 'utf8')
  assert.equal(writerGate({ file, expectedRevision: 0 }).ok, true)
})

test('copyTree：目录整棵搬过去，嵌套与空目录都在，同名文件能被覆盖', () => {
  const dir = scratch()
  const from = join(dir, 'from')
  mkdirSync(join(from, '台账', '子目录'), { recursive: true })
  mkdirSync(join(from, '空目录'), { recursive: true })
  writeFileSync(join(from, '台账', '事件.md'), '第一版', 'utf8')
  writeFileSync(join(from, '台账', '子目录', 'x.md'), '嵌套', 'utf8')

  const to = join(dir, 'to')
  copyTree(from, to)

  assert.equal(readFileSync(join(to, '台账', '事件.md'), 'utf8'), '第一版')
  assert.equal(readFileSync(join(to, '台账', '子目录', 'x.md'), 'utf8'), '嵌套')
  assert.equal(existsSync(join(to, '空目录')), true, '空目录也要建出来')
  assert.deepEqual(readdirSync(to).sort(), ['台账', '空目录'].sort())

  // 覆盖档：目标里已有同名文件，重搬一遍按新内容盖掉。
  writeFileSync(join(from, '台账', '事件.md'), '第二版', 'utf8')
  copyTree(from, to)
  assert.equal(readFileSync(join(to, '台账', '事件.md'), 'utf8'), '第二版')
})

test('copyTree：overwrite:false 遇到同名文件就抛 EEXIST，不悄悄盖', () => {
  const dir = scratch()
  const from = join(dir, 'from')
  mkdirSync(from, { recursive: true })
  writeFileSync(join(from, 'a.md'), '新', 'utf8')

  const to = join(dir, 'to')
  mkdirSync(to, { recursive: true })
  writeFileSync(join(to, 'a.md'), '旧', 'utf8')

  assert.throws(() => copyTree(from, to, { overwrite: false }), /EEXIST/u)
  assert.equal(readFileSync(join(to, 'a.md'), 'utf8'), '旧', '抛了就一个字节都不该动')
})
