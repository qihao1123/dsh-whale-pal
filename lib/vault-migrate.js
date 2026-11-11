/**
 * 换库路径时，把插件自己的那两个目录搬到新库去。
 *
 * 边界先说清楚：
 *   - 只搬 `台账/` 和 `_上下文/`。库里的其它东西（人的笔记、项目规划、.obsidian）
 *     一概不碰 —— 库是人的，插件只认自己写的那两块。
 *   - 只复制，不删除源。旧库原样留着，删不删由人决定。
 *   - 目标里已经有同名目录且非空，就停下来说清楚，不合并、不覆盖。
 *   - 先整份复制到库内临时目录，逐文件比哈希，全过了才改名落地。
 *     任何一步失败：临时目录清掉，源一个字节没动，配置也没写 —— 插件继续用旧库。
 *
 * 为什么不直接 `rename` 源目录：跨盘 rename 会失败，而且挪走源之后人想回头
 * 就没有回头路了。复制 + 校验 + 落地，最坏情况是白忙一场，不是丢数据。
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { copyTree } from './atomic.js'
import { CTX_DIR_NAME } from './ctx/store.js'
import { LEDGER_DIR } from './ledger/store.js'

/** 只在库根下搬这两个目录；其余是人的地盘。 */
export const MOVE_DIRS = Object.freeze([LEDGER_DIR, CTX_DIR_NAME])

/** 临时目录名：落在目标库里，落地完成后删掉。 */
export const TEMP_PREFIX = '.whale-pal-migrating-'

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 真实路径；不存在或读不到就 null。用来判「是不是同一个库」。 */
export function realPathOf(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * 递归列出目录下的所有文件，`rel` 用 `/` 拼，方便两边比对。
 * 空目录不算内容 —— 库里的目录结构靠文件带过去，没有文件的空壳不搬。
 */
function walkFiles(root) {
  const files = []
  const visit = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) visit(abs, next)
      else if (entry.isFile()) files.push({ rel: next, abs })
    }
  }
  visit(root, '')
  return files
}

function digestOf(file) {
  const bytes = readFileSync(file)
  return { size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * 逐文件比：文件数、每个文件的相对路径、字节数、sha256。
 * 只比大小不够 —— 复制中断留下的半截文件和原文件可能同大小。
 */
export function compareTrees(source, target) {
  const left = walkFiles(source)
  const right = walkFiles(target)
  if (left.length !== right.length) {
    return { ok: false, reason: 'count-mismatch', expected: left.length, actual: right.length }
  }
  const byRel = new Map(right.map((item) => [item.rel, item]))
  let bytes = 0
  for (const item of left) {
    const other = byRel.get(item.rel)
    if (!other) return { ok: false, reason: 'missing-file', file: item.rel }
    const one = digestOf(item.abs)
    const two = digestOf(other.abs)
    if (one.size !== two.size || one.hash !== two.hash) {
      return { ok: false, reason: 'content-mismatch', file: item.rel }
    }
    bytes += one.size
  }
  return { ok: true, files: left.length, bytes }
}

function removeQuietly(path) {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // 临时目录删不掉不致命：名字带前缀，下次迁移会再建一个，人也能手动清。
  }
}

/**
 * 把 `from` 库里的 `台账/` 和 `_上下文/` 复制到 `to` 库。
 *
 * 返回：
 *   { ok: true, skipped }                        什么都没搬（首次填库、同一个库、源里没东西）
 *   { ok: true, moved, total, source, target }   搬完了，moved 一项一个目录
 *   { ok: false, reason, ... }                   没搬成，配置不该落盘
 */
/**
 * 同一进程里只许跑一次迁移。
 *
 * 设置页有 busy 挡着连点，但两个窗口、两个标签页能同时发：并发迁移会在
 * 「检查目标空」和「改名落地」之间互相插队。加锁之后第二个直接回 already-running，
 * 配置那边再存一次就行，数据不会搅在一起。
 */
let running = false

export function migrateVault(options = {}) {
  if (running === true) return { ok: false, reason: 'already-running' }
  running = true
  try {
    return runMigrate(options)
  } finally {
    running = false
  }
}

function runMigrate({ from = '', to = '' } = {}) {
  const source = String(from ?? '').trim()
  const target = String(to ?? '').trim()
  // 首次填库：旧路径本来就是空的，没有「换」这回事。
  if (source === '' || target === '') return { ok: true, skipped: 'no-source' }
  // 相对路径在设置页那一层已经被挡住了；这里再挡一次，免得被别处直接调用。
  if (!isAbsolute(source) || !isAbsolute(target)) return { ok: true, skipped: 'no-source' }

  const fromReal = realPathOf(source)
  if (fromReal === null) return { ok: true, skipped: 'source-missing' }
  const toReal = realPathOf(target)
  // 目标必须已经存在：建库是人的动作，插件不替人建。
  if (toReal === null) return { ok: false, reason: 'target-missing' }
  // Windows 的盘符大小写不统一，realpath 之后还可能不同，按不敏感比。
  if (fromReal.toLowerCase() === toReal.toLowerCase()) return { ok: true, skipped: 'same-vault' }

  const dirs = []
  for (const name of MOVE_DIRS) {
    const abs = join(fromReal, name)
    if (isDirectory(abs)) dirs.push({ name, abs })
  }
  // 首发用户：旧库是空的（或只有人的笔记），没东西可搬，不算失败。
  if (dirs.length === 0) return { ok: true, skipped: 'nothing-to-move' }

  // 目标里已经有同名目录：空的可以接管，非空的停下来问人。
  const blocking = []
  const emptyLanded = []
  for (const dir of dirs) {
    const abs = join(toReal, dir.name)
    if (!existsSync(abs)) continue
    if (!isDirectory(abs)) {
      blocking.push(dir.name)
      continue
    }
    if (readdirSync(abs).length === 0) emptyLanded.push(abs)
    else blocking.push(dir.name)
  }
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: 'target-busy',
      dirs: blocking,
      message: `新库里已经有 ${blocking.join('、')}，里面不是空的。我不合并也不覆盖，先把那边挪开或换个库。`,
    }
  }

  const tempDir = join(toReal, `${TEMP_PREFIX}${stamp()}`)
  const moved = []
  try {
    mkdirSync(tempDir, { recursive: true })
    for (const dir of dirs) {
      copyTree(dir.abs, join(tempDir, dir.name), { overwrite: false })
    }
    // 复制完先验一遍；验不过就当没搬过，别把半套东西留给新库。
    for (const dir of dirs) {
      const checked = compareTrees(dir.abs, join(tempDir, dir.name))
      if (checked.ok !== true) {
        removeQuietly(tempDir)
        return { ok: false, reason: 'verify-failed', dir: dir.name, detail: checked.reason, file: checked.file }
      }
      moved.push({ dir: dir.name, files: checked.files, bytes: checked.bytes })
    }

    // 目标里那些空目录先让位，rename 要求目标不存在。
    for (const abs of emptyLanded) {
      try {
        rmdirSync(abs)
      } catch {
        removeQuietly(tempDir)
        return { ok: false, reason: 'target-busy', dirs: [abs], message: '新库里的空目录没让开，可能刚被别人写进了东西。' }
      }
    }

    const landed = []
    try {
      for (const dir of dirs) {
        renameSync(join(tempDir, dir.name), join(toReal, dir.name))
        landed.push(dir.name)
      }
    } catch (error) {
      // 半路失败：把已经落地的挪回临时目录，整份清掉。
      // 源一直没动，所以最坏也只是新库干净如初。
      for (const name of landed) {
        try {
          renameSync(join(toReal, name), join(tempDir, name))
        } catch {
          // 挪不回来就留在新库：那是一份完整校验过的副本，不是坏数据。
        }
      }
      removeQuietly(tempDir)
      return { ok: false, reason: 'land-failed', detail: String(error?.message ?? error) }
    }

    removeQuietly(tempDir)
    const total = moved.reduce((sum, item) => ({ files: sum.files + item.files, bytes: sum.bytes + item.bytes }), {
      files: 0,
      bytes: 0,
    })
    return { ok: true, moved, total, source: fromReal, target: toReal }
  } catch (error) {
    removeQuietly(tempDir)
    return { ok: false, reason: 'copy-failed', detail: String(error?.message ?? error) }
  }
}

/**
 * 撤回一次已经落地的迁移。
 *
 * 迁移成功、配置却没写进去，新库里就留着一份没人认领的副本；不撤的话，下次
 * 再换库会被自己的副本判成 `target-busy`，人还得手动去删。源从头到尾没动过，
 * 所以删掉落地的副本不丢数据。
 *
 * 只删 `migrated.moved` 里点名的目录，不碰新库里的其它东西。
 * 删不掉的留着并报回来 —— 那是完整校验过的副本，不是坏数据，但不该假装删掉了。
 */
export function undoMigrate(done) {
  const moved = Array.isArray(done?.moved) ? done.moved.map((item) => item.dir) : []
  const target = typeof done?.target === 'string' ? done.target : ''
  if (moved.length === 0 || target === '') return { ok: true, removed: [], left: [] }

  const removed = []
  const left = []
  for (const name of moved) {
    const abs = join(target, name)
    if (!existsSync(abs)) continue
    try {
      rmSync(abs, { recursive: true, force: true })
      removed.push(name)
    } catch (error) {
      left.push({ dir: name, detail: String(error?.message ?? error) })
    }
  }
  return { ok: left.length === 0, removed, left }
}
