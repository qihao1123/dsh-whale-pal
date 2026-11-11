/**
 * 旧状态该不该导：只判断，不动盘。
 *
 * 口径出处：`融合计划-v2.md` §5（P5 行）、§7 不变量 21（只导一次、旧文件此后只读、
 * 接管过程可回退到导入前的快照）。
 *
 * 三条短路与 `lib/migrate.js` 的 `ensureStateImported` 逐条一致。为什么要有这一层：
 * 真导入那条路是「先写再解释」，而人问「现在到底导没导、为什么没导」时不该写盘，
 * 所以先判一遍、能只读地报告。
 */

export const PLAN_REASONS = Object.freeze(['import', 'state-exists', 'already-imported', 'no-legacy-state'])

/**
 * @param {{stateExists?: boolean, recordExists?: boolean, legacy?: object|null}} facts
 *   `legacy` 是旧根里那份 state（读出来传进来；读不到传 null），本模块不碰盘。
 * @returns {{action: 'import'|'skip', reason: string}}
 */
export function planImport({ stateExists = false, recordExists = false, legacy = null } = {}) {
  if (stateExists) return { action: 'skip', reason: 'state-exists' }
  if (recordExists) return { action: 'skip', reason: 'already-imported' }
  if (legacy === null || typeof legacy !== 'object') return { action: 'skip', reason: 'no-legacy-state' }
  return { action: 'import', reason: 'import' }
}

/** 计划里的人话：给命令与日志用，一句话，不带指令口气。 */
export function planText(plan) {
  const reason = String(plan?.reason ?? '')
  if (reason === 'import') return '该导：新根还没有状态，旧根有'
  if (reason === 'state-exists') return '不导：新根已经有状态了'
  if (reason === 'already-imported') return '不导：导过一次（import-record.json 在）'
  if (reason === 'no-legacy-state') return '不导：旧根里没有状态（全新机器）'
  return `不导：${reason === '' ? '理由不明' : reason}`
}
