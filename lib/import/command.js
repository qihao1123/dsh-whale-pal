/**
 * `/whale import` 这一路的回话：看情况、回滚（要原话确认）、回滚错了再退回来。
 *
 * 口径出处：`融合计划-v2.md` §5（P5 行）、§7 不变量 21。
 *
 * 回滚是**破坏性**的，所以这里分两步：不带「确认」只报「会丢什么」，带「确认」才动手——
 * 平台的门禁口令按字面判，这里也一样，`对`/`好` 这类不算确认。
 */
import { rollbackImport, inspectRollback, undoRollback } from './rollback.js'
import { inspectImport } from './run.js'
import { COPY } from '../copy.js'

const CONFIRM = '确认'

function line(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 只读看情况：计划、旧根、导入记录、逐项核对、快照。 */
export function importText({ resolved, at = '' } = {}) {
  const seen = inspectImport({ resolved, at })
  if (seen.ok !== true) return COPY.importNeedsRoot
  const lines = [`${COPY.importPlan}：${seen.planText}`, `旧根：${seen.legacyRoot}`]

  const record = seen.record
  if (record && typeof record === 'object') {
    const from = line(record.from) ? record.from : '（记录里没写）'
    lines.push(`导入记录：${line(record.at) ? record.at : '（没写时间）'}，从 ${from} 搬来，revision ${record.revision ?? '?'}`)
    const diff = Array.isArray(record.diff) ? record.diff : []
    lines.push(diff.length === 0 ? '那次导入逐项都对上，没有差异' : `那次导入有差异：${diff.join('、')}`)
  } else {
    lines.push('导入记录：没有')
  }

  // 那一刻准不准，看导入记录（导入当时比的）；下面是**现在**两边的读数：
  // 旧根停在导入那一刻，新根后来会长，所以两边不完全一样是正常的，别当成导丢了。
  lines.push('', '逐项核对：', '  导入那一刻以导入记录为准；下面是现在两边的读数（新根后来会长）：', ...seen.lines.map((one) => `  ${one}`))

  const snaps = seen.snapshots
  lines.push(
    '',
    snaps.length === 0
      ? `快照：一份都没有（快照根 ${seen.snapshotDir}）`
      : `快照：${snaps.length} 份，最新一份 ${snaps[0].name}${snaps[0].empty === true ? '（空快照：导入前新根还不存在）' : `（${snaps[0].files} 个文件）`}`,
  )
  if (seen.plan.action === 'import') lines.push('', `要真导：敲 ${COPY.importRunHint}`)
  return lines.join('\n')
}

/**
 * 回滚这一路。
 *
 * @param {{resolved: object, argument?: string, at?: string, log?: Function}} options
 *   `argument` 是 `/whale import` 后面那半句原文：空 = 看情况；`rollback` = 只报会丢什么；
 *   `rollback 确认` = 真动手；`undo` = 把刚才那次回滚退回去。
 */
export function importCommand({ resolved, argument = '', at = '', log = () => {} } = {}) {
  const said = String(argument ?? '').trim()
  if (said === '' || said === 'status') return { ok: true, text: importText({ resolved, at }) }

  if (/^undo\b/iu.test(said)) {
    const back = undoRollback({ resolved, at })
    if (back.ok !== true) {
      return { ok: false, text: back.reason === 'no-pre-rollback' ? COPY.importNoPreRollback : COPY.importRollbackFailed }
    }
    return { ok: true, text: `退回上一次回滚之前那份：铺回 ${back.files} 个文件，清掉 ${back.removed.length} 项` }
  }

  if (/^rollback\b/iu.test(said) === false) return { ok: false, text: COPY.importUnknown }

  const seen = inspectRollback({ resolved, at })
  if (seen.ok !== true) return { ok: false, text: seen.reason === 'no-snapshot' ? COPY.importNoSnapshot : COPY.importNeedsRoot }

  const confirmed = said.includes(CONFIRM)
  if (confirmed !== true) {
    const lines = [
      `回滚会把新根退回导入前：${seen.snapshot.name}（${seen.wouldRestore}）`,
      seen.wouldRemove.length === 0 ? '现在新根里没有多余的东西，这一下不丢什么' : `会丢掉现在新根里的 ${seen.wouldRemove.length} 项：${seen.wouldRemove.join('、')}`,
      ...seen.signals.map((one) => `  ${one}`),
      '',
      `要真回滚，把「${CONFIRM}」两个字带上再说一遍：/whale import rollback ${CONFIRM}`,
    ]
    return { ok: true, text: lines.join('\n') }
  }

  const done = rollbackImport({ resolved, at, force: true, log })
  if (done.ok !== true) {
    return { ok: false, text: done.reason === 'needs-force' ? COPY.importNeedsForce : COPY.importRollbackFailed }
  }
  return {
    ok: true,
    text: [
      `已回滚到导入前：清掉 ${done.removed.length} 项，退回 ${done.restored === true ? `${done.files} 个文件` : '空（导入前新根还不存在）'}`,
      '动手前那一份另存成了 pre-rollback 快照，想退回来就敲 /whale import undo',
    ].join('\n'),
  }
}
