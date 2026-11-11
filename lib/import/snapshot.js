/**
 * 导入前快照：把新根整个存一份（导入前的世界），回滚就退回它。
 *
 * 口径出处：`融合计划-v2.md` §5（P5 行「导入后可回滚到导入前状态」）、§7 不变量 21。
 *
 * 两条容易踩的：
 *   1. 快照目录**必须在新根之外**——放里面就成了「自己复制自己」，会无限套娃；
 *      所以默认落 `~/.dsh/whale-pal/import-snapshots/<profile>/`，与新根同级。
 *   2. 导入前的新根通常是**不存在**的，所以「empty 快照」也要留一份标记：
 *      回滚要回到的正是「什么都没有」那个状态，不是「空目录里有一堆东西」。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { copyTree } from '../atomic.js'

export const SNAPSHOT_DIR_NAME = 'import-snapshots'
export const MARKER_NAME = 'snapshot.json'
export const TREE_DIR_NAME = 'tree'

/** 默认快照根：与新根同级，落在插件自己的地盘里，绝不进用户知识库。 */
export function defaultSnapshotDir({ home = '', profile = '' } = {}) {
  if (String(home ?? '') === '') return ''
  return join(String(home), 'whale-pal', SNAPSHOT_DIR_NAME, String(profile ?? ''))
}

/** 目录名里不许有冒号（Windows 不认），所以时间戳先洗一遍。 */
export function stampOf(at) {
  const clean = String(at ?? '').replaceAll(':', '-').replaceAll('.', '-').trim()
  return clean === '' ? 'unknown' : clean
}

function countFiles(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name))
    else total += 1
  }
  return total
}

/**
 * @param {{root: string, dir: string, at?: string, label?: string}} options
 * @returns {{ok: boolean, dir?: string, files?: number, empty?: boolean, reason?: string, detail?: string}}
 */
export function snapshotBefore({ root, dir, at = '', label = 'import' } = {}) {
  if (String(root ?? '') === '' || String(dir ?? '') === '') return { ok: false, reason: 'no-path' }
  const dest = join(dir, `${stampOf(at)}_${label}`)
  const has = existsSync(root)
  const files = has ? countFiles(root) : 0
  try {
    mkdirSync(dest, { recursive: true })
    if (files > 0) copyTree(root, join(dest, TREE_DIR_NAME))
    writeFileSync(
      join(dest, MARKER_NAME),
      `${JSON.stringify({ at, root, files, empty: files === 0, label }, null, 2)}\n`,
      'utf8',
    )
  } catch (error) {
    return { ok: false, reason: 'snapshot-failed', detail: String(error?.message ?? error) }
  }
  return { ok: true, dir: dest, files, empty: files === 0 }
}

/** 列快照：只认带标记的目录，标记坏了就当没有，不猜。 */
export function listSnapshots({ dir } = {}) {
  if (String(dir ?? '') === '' || existsSync(dir) !== true) return []
  const found = []
  for (const name of readdirSync(dir)) {
    const one = join(dir, name)
    try {
      if (!statSync(one).isDirectory()) continue
      const marker = JSON.parse(readFileSync(join(one, MARKER_NAME), 'utf8'))
      found.push({ name, dir: one, at: String(marker?.at ?? ''), files: Number(marker?.files) || 0, empty: marker?.empty === true, label: String(marker?.label ?? ''), marker })
    } catch {
      // 没标记或标记坏了：不列，也不删——留给人看。
    }
  }
  return found.sort((left, right) => String(right.at).localeCompare(String(left.at)))
}

export function latestSnapshot({ dir } = {}) {
  return listSnapshots({ dir })[0] ?? null
}

/**
 * 把新根退回快照那一状态：先给**当前**的新根也存一份（回滚本身也可回滚），再清空、按快照铺回去。
 *
 * @param {{snapshot: object, root: string, keepDir?: string, at?: string}} options
 * @returns {{ok: boolean, reason?: string, removed?: string[], restored?: boolean, files?: number, kept?: object|null}}
 */
export function restoreSnapshot({ snapshot, root, keepDir = '', at = '' } = {}) {
  if (snapshot === null || typeof snapshot !== 'object' || String(root ?? '') === '') {
    return { ok: false, reason: 'no-snapshot' }
  }
  const kept = String(keepDir ?? '') === '' ? null : snapshotBefore({ root, dir: keepDir, at, label: 'pre-rollback' })
  const removed = []
  try {
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        removed.push(name)
        rmSync(join(root, name), { recursive: true, force: true })
      }
    }
    const tree = join(snapshot.dir, TREE_DIR_NAME)
    if (snapshot.empty === true || existsSync(tree) !== true) mkdirSync(root, { recursive: true })
    else copyTree(tree, root)
  } catch (error) {
    return { ok: false, reason: 'restore-failed', detail: String(error?.message ?? error), removed, kept }
  }
  return { ok: true, removed, restored: snapshot.empty !== true, files: Number(snapshot.files) || 0, kept }
}
