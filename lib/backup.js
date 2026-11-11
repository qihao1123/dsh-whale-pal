/**
 * 备份与跨盘搬运。
 *
 * 两条口径：
 *   - `融合计划-v2.md:1192`：**不 rename 跨盘**，HDD↔SSD 之间一律「复制 + 校验 + 切换」，绝不 move。
 *   - `融合计划-v2.md:189`：写之前有 `.bak`，`.bak` 拿不到就不动原文件。
 *
 * 这里只管搬运和备份本身，不判断「该不该写」——那是调用方的事。
 */
import { copyFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

import { backupNameOf, backupIsSound, listBackups, pruneBackups, sameBytes } from './atomic.js'

/** 某个路径落在哪个卷上。Windows 比盘符，其它平台比设备号。 */
export function volumeKey(target) {
  const abs = resolve(target)
  if (process.platform === 'win32') return parse(abs).root.toLowerCase()
  let probe = abs
  for (let i = 0; i < 40; i += 1) {
    try {
      return String(statSync(probe).dev)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return ''
      probe = parent
    }
  }
  return ''
}

/** 两个路径是否同一个卷。 */
export function sameVolume(a, b) {
  return volumeKey(a) === volumeKey(b) && volumeKey(a) !== ''
}

/** 复制并逐字校验；不成立就回 ok:false，不返回「大概成功」。 */
export function copyVerified(from, to) {
  try {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
  } catch (error) {
    return { ok: false, error: 'copy-failed', detail: String(error?.message ?? error) }
  }
  if (!sameBytes(from, to)) return { ok: false, error: 'copy-mismatch' }
  return { ok: true, to }
}

/**
 * 把文件搬到新位置。
 *
 * 同卷才用 rename（代价最小且原子），跨卷一律复制 + 校验 + 删源。
 * 删源在最后一步，且只在字节校验通过之后。
 */
export function moveVerified(from, to) {
  if (!existsSync(from)) return { ok: false, error: 'source-missing' }
  const copied = copyVerified(from, to)
  if (!copied.ok) return copied
  if (sameVolume(from, to)) {
    // 同卷也走复制路径了，直接删源即可，不再二次搬。
    try {
      unlinkSync(from)
    } catch (error) {
      return { ok: false, error: 'remove-failed', detail: String(error?.message ?? error), to }
    }
    return { ok: true, to, mode: 'copy-then-remove', crossVolume: false }
  }
  try {
    unlinkSync(from)
  } catch (error) {
    return { ok: false, error: 'remove-failed', detail: String(error?.message ?? error), to }
  }
  return { ok: true, to, mode: 'copy-then-remove', crossVolume: true }
}

/**
 * 给一个文件做备份，返回备份路径。
 *
 * 备份要能判定：字节相同 + 创建时间不早于源的最后修改（`backupIsSound`）。
 * 判定不过就当没有备份，调用方据此停下。
 */
export function stash(file, { keep = undefined } = {}) {
  if (!existsSync(file)) return { ok: false, error: 'source-missing', backup: null }
  const backup = backupNameOf(file)
  try {
    copyFileSync(file, backup)
  } catch (error) {
    return { ok: false, error: 'backup-failed', backup: null, detail: String(error?.message ?? error) }
  }
  if (!backupIsSound(file, backup)) {
    return { ok: false, error: 'backup-unsound', backup }
  }
  if (keep !== undefined) pruneBackups(file, { keep })
  return { ok: true, backup }
}

/** 列出备份，新的在前；薄封装，便于调用方只 import 这一个文件。 */
export function backupsOf(file) {
  return listBackups(file)
}

/** 多份文件一起搬运：任一失败就停下并报出已经搬过的，便于人工退回。 */
export function moveMany(pairs) {
  const moved = []
  for (const [from, to] of pairs) {
    const result = moveVerified(from, to)
    if (!result.ok) return { ok: false, error: result.error, failedAt: from, moved, detail: result.detail }
    moved.push(join(from, '->', to))
  }
  return { ok: true, moved }
}
