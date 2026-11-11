/**
 * 旧状态一次性导入（P5）：快照 → 导入 → 逐项核对 → 旧文件只读 → 记一笔台账。
 *
 * 口径出处：`融合计划-v2.md` §5（P5 行）、§7 不变量 21；「老库」= 旧插件的状态与记录
 * （`~/.dsh/persona-framework/<profile>`：state.json / config.json / audit.jsonl），不是知识库目录。
 *
 * 真正的读写交给 `lib/migrate.js` 的 `ensureStateImported`——那三条短路与归一化早就在那儿，
 * 这一层只补它没有的：导入前快照、逐项核对清单、旧文件只读、以及台账那一行（由调用方注入 `record`）。
 * 时间由调用方给，本层不看时钟。
 */
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs'

import { countState, ensureStateImported } from '../migrate.js'
import { checkCounts, checkLines } from './check.js'
import { planImport, planText } from './plan.js'
import { defaultSnapshotDir, listSnapshots, snapshotBefore } from './snapshot.js'

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 只读看一遍：该不该导、导过没、旧根里有多少东西、快照还在不在。
 * 这个函数一个字节都不写——命令里「现在什么情况」走它。
 */
export function inspectImport({ resolved, at = '' } = {}) {
  const paths = resolved?.paths
  const legacy = resolved?.legacy
  if (!paths || !legacy) return { ok: false, reason: 'no-paths' }

  const legacyState = readJson(legacy.state)
  const plan = planImport({
    stateExists: existsSync(paths.state),
    recordExists: existsSync(resolved.importRecord),
    legacy: legacyState,
  })
  const legacyCounts = countState(legacyState ?? {})
  const counts = countState(readJson(paths.state) ?? {})
  const checked = checkCounts(legacyCounts, counts)
  const snapshotDir = defaultSnapshotDir(resolved.base ?? {})

  return {
    ok: true,
    at,
    plan,
    planText: planText(plan),
    record: readJson(resolved.importRecord),
    legacyRoot: legacy.root,
    legacyCounts,
    counts,
    checked,
    lines: checkLines(checked),
    snapshotDir,
    snapshots: listSnapshots({ dir: snapshotDir }),
  }
}

/**
 * 旧文件只读：导入完成后旧根不再读也不再写，只留作回退。
 *
 * Windows 上 `chmod` 只认写位（`0o444` = 只读、`0o644` = 可写），够用。
 * 失败**只记不改流程**：旧文件没锁上不该拦住这次启动（不变量 17）。
 */
export function freezeLegacy({ legacy } = {}) {
  const files = [legacy?.state, legacy?.config, legacy?.audit].filter((one) => typeof one === 'string' && one !== '')
  const frozen = []
  const skipped = []
  const failed = []
  for (const file of files) {
    if (existsSync(file) !== true) {
      skipped.push({ file, reason: 'missing' })
      continue
    }
    try {
      if ((statSync(file).mode & 0o200) === 0) {
        skipped.push({ file, reason: 'already-readonly' })
        continue
      }
      chmodSync(file, 0o444)
      frozen.push(file)
    } catch (error) {
      failed.push({ file, reason: String(error?.message ?? error) })
    }
  }
  return { ok: failed.length === 0, frozen, skipped, failed }
}

/**
 * 真的导一次。
 *
 * @param {{resolved: object, at?: string, log?: Function, record?: Function|null, freeze?: boolean}} options
 *   `resolved` 就是 `lib/paths.js` 的 `resolveDataPaths()` 结果（paths / legacy / importRecord / base）。
 *   `record(report)` 是台账那一行：由调用方注入，本层不 import 台账模块。
 * @returns {object} 该导没导（含理由）或导完的报告；坏入参不抛。
 */
export function runImport({ resolved, at = '', log = () => {}, record = null, freeze = true } = {}) {
  const seen = inspectImport({ resolved, at })
  if (seen.ok !== true) return seen
  if (seen.plan.action !== 'import') {
    return { ok: true, imported: false, reason: seen.plan.reason, planText: seen.planText, inspected: seen }
  }

  const snapshot =
    seen.snapshotDir === ''
      ? { ok: false, reason: 'no-snapshot-dir' }
      : snapshotBefore({ root: resolved.paths.root, dir: seen.snapshotDir, at })
  const done = ensureStateImported({
    paths: resolved.paths,
    legacy: resolved.legacy,
    importRecord: resolved.importRecord,
    log,
  })

  const counts = countState(readJson(resolved.paths.state) ?? {})
  const checked = checkCounts(seen.legacyCounts, counts)
  const froze = freeze === true ? freezeLegacy({ legacy: resolved.legacy }) : null
  const report = {
    ok: true,
    imported: done.imported === true,
    reason: done.reason,
    at,
    legacyRoot: resolved.legacy.root,
    counts,
    checked,
    lines: checkLines(checked),
    snapshot,
    froze,
  }
  if (typeof record === 'function') {
    try {
      record(report)
    } catch (error) {
      // 台账那一行写不进去，不能反过来把导入判成失败。
      report.recordFailed = String(error?.message ?? error)
    }
  }
  return report
}
