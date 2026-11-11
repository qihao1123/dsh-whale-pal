/**
 * 逐项核对：把旧根那份 state 与新根写下的 state 按同一套计数比一遍。
 *
 * 口径出处：`融合计划-v2.md` §5（P1.0 验收要逐项对上：revision、295 条短记忆、
 * 33 条长记忆、8 条 traits、20 条承诺）、§7 不变量 21。
 * 键名与 `lib/migrate.js` 的 `countState` 完全一致——同一件事只许有一套计数名字。
 *
 * 纯函数：不读盘、不看时钟。差异**只报不修**——核对是用来发现「导丢了」的，不是用来抹平的。
 */

/** 计数键 → 人话。`lib/migrate.js` 的 `countState` 出哪个键，这里就认哪个。 */
export const CHECK_LABELS = Object.freeze({
  revision: '版本号',
  facts: '短记忆·事实',
  preferences: '短记忆·偏好',
  events: '短记忆·事件',
  openTopics: '短记忆·未结话题',
  longMemory: '长记忆',
  traits: '特征',
  traitsArchive: '特征·归档',
  values: '价值观',
  titleCandidates: '称呼候选',
  commitments: '承诺',
})

/** 短记忆是四类相加：事实 + 偏好 + 事件 + 未结话题。 */
export function shortMemoryOf(counts) {
  const pick = (key) => Number(counts?.[key]) || 0
  return pick('facts') + pick('preferences') + pick('events') + pick('openTopics')
}

/**
 * @param {object} before 旧根那份 state 的计数（`countState(legacyState)`）
 * @param {object} after 新根写下的 state 的计数（`countState(state)`）
 * @returns {{ok: boolean, rows: Array, diff: string[], same: boolean}}
 */
export function checkCounts(before = {}, after = {}) {
  const keys = []
  for (const key of Object.keys(CHECK_LABELS)) {
    if (key in before || key in after) keys.push(key)
  }
  const rows = keys.map((key) => ({
    key,
    label: CHECK_LABELS[key],
    before: Number(before?.[key]) || 0,
    after: Number(after?.[key]) || 0,
  }))
  const diff = rows.filter((row) => row.before !== row.after).map((row) => row.key)
  return { ok: true, rows, diff, same: diff.length === 0 }
}

/** 人可读的核对清单：一行一项，只标差异，数量一样就不啰嗦。 */
export function checkLines(checked) {
  const rows = Array.isArray(checked?.rows) ? checked.rows : []
  if (rows.length === 0) return ['逐项核对：没有可比的两份计数']
  const lines = [`短记忆合计：旧 ${shortMemoryOf(countOf(rows))} → 新 ${shortMemoryOf(countOf(rows, 'after'))}`]
  for (const row of rows) {
    if (row.before === row.after) {
      lines.push(`${row.label}：${row.before}（一样）`)
      continue
    }
    const gap = row.after - row.before
    lines.push(`${row.label}：旧 ${row.before} → 新 ${row.after}（新比旧${gap > 0 ? '多' : '少'} ${Math.abs(gap)}）`)
  }
  return lines
}

/** 把 [ {key,label,before,after} ] 折回 `countState` 那种计数对象，供上面的合计用。 */
function countOf(rows, side = 'before') {
  const counts = {}
  for (const row of rows) counts[row.key] = row[side]
  return counts
}
