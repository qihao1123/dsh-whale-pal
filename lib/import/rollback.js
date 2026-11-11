/**
 * 回滚：把新根退回导入前那一状态。
 *
 * 口径出处：`融合计划-v2.md` §5（P5 验收「导入后可回滚到导入前状态」）。
 *
 * 两条自制规矩：
 *   1. **默认不删**：导入之后新根往往已经住下了（真状态、真审计），回滚会丢掉它们，
 *      所以先只读体检、列出「会丢什么」；没有 `force` 就到此为止。
 *   2. **回滚本身也可回滚**：动手前把当前新根再存一份 `pre-rollback` 快照（照 `undo_restore` 的做法）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { defaultSnapshotDir, latestSnapshot, listSnapshots, restoreSnapshot, TREE_DIR_NAME } from './snapshot.js'

/** 回滚前只读体检：快照在哪、会丢什么、要不要显式确认。 */
export function inspectRollback({ resolved, at = '' } = {}) {
  const paths = resolved?.paths
  if (!paths) return { ok: false, reason: 'no-paths' }
  const snapshotDir = defaultSnapshotDir(resolved.base ?? {})
  const snapshot = latestSnapshot({ dir: snapshotDir })
  if (!snapshot) return { ok: false, reason: 'no-snapshot', snapshotDir }

  const top = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
  const now = top(paths.root)
  const back = snapshot.empty === true ? [] : top(join(snapshot.dir, TREE_DIR_NAME))
  const wouldRemove = now.filter((name) => !back.includes(name))

  const signals = []
  if (wouldRemove.length > 0) signals.push(`现在新根里有 ${wouldRemove.length} 项不在那份快照里：${wouldRemove.join('、')}`)
  if (snapshot.empty !== true && back.length === 0) signals.push('快照里那份 tree 是空的，回滚会把新根清空')

  return {
    ok: true,
    at,
    snapshot,
    snapshotDir,
    wouldRemove,
    wouldRestore: snapshot.empty === true ? '空（导入前新根还不存在）' : `${back.length} 项`,
    signals,
    needsForce: wouldRemove.length > 0,
  }
}

/**
 * 回滚：`force` 不是 true 就只回报检（`reason: 'needs-force'`）。
 *
 * @param {{resolved: object, at?: string, force?: boolean, log?: Function}} options
 */
export function rollbackImport({ resolved, at = '', force = false, log = () => {} } = {}) {
  const seen = inspectRollback({ resolved, at })
  if (seen.ok !== true) return seen
  if (seen.needsForce === true && force !== true) {
    return { ok: false, reason: 'needs-force', inspected: seen, message: '导入后新根又住下了，回滚会丢东西；确认了再动手' }
  }

  const keptAt = at === '' ? 'pre-rollback' : `${at}`.replaceAll(':', '-').replaceAll('.', '-')
  const done = restoreSnapshot({
    snapshot: seen.snapshot,
    root: resolved.paths.root,
    keepDir: seen.snapshotDir,
    at: keptAt,
  })
  if (done.ok !== true) return { ...done, inspected: seen }

  const report = {
    ok: true,
    at,
    backTo: seen.snapshot.name,
    restored: done.restored,
    removed: done.removed,
    kept: done.kept,
    inspected: { snapshotDir: seen.snapshotDir, wouldRemove: seen.wouldRemove },
  }
  if (typeof log === 'function') log(`已回滚到导入前：清掉 ${done.removed.length} 项，快照留在 ${seen.snapshot.name}`)
  return report
}

/** 把最新的 `pre-rollback` 快照再回滚回去——回滚错了还能回来。 */
export function undoRollback({ resolved, at = '' } = {}) {
  const paths = resolved?.paths
  if (!paths) return { ok: false, reason: 'no-paths' }
  const snapshotDir = defaultSnapshotDir(resolved.base ?? {})
  const kept = listSnapshots({ dir: snapshotDir }).find((one) => one.label === 'pre-rollback') ?? null
  if (!kept) return { ok: false, reason: 'no-pre-rollback' }
  return restoreSnapshot({ snapshot: kept, root: paths.root, keepDir: '', at })
}
