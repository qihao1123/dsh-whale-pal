// 评估器失败样本的时间分布：按「本次启动时刻」切开 audit.jsonl 里的 assess 记录。
//
// 为什么要这支脚本：健康页那行「近 50 次成功 41（83.7%），失败最多的是 truncated 8 次」
// 是个滚动窗口，**不区分样本发生在修复之前还是之后**。想判断「改了 maxTokens/retry 之后
// 还截不截断」，就得把每条样本的 at 和启动时刻放在一起看。
//
// 为什么用 Node 而不是 PowerShell 一句：Windows PowerShell 5.1 的 ConvertFrom-Json
// 会把 ISO 时间字符串转成 DateTime，`-ge` 比较跨时区时会错位（第一次查就错在这里，把
// 修好之后的样本全判成了「修复前」）。
//
// 只读：不写盘、不改状态。
//
// 用法：
//   node scripts/assess-samples.mjs            # 默认 ~/.dsh/whale-pal/desktop
//   node scripts/assess-samples.mjs <数据目录>
//   node scripts/assess-samples.mjs <数据目录> --list   # 连最近 50 条时间线一起打

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const sample = 50

const dir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(homedir(), '.dsh', 'whale-pal', 'desktop')
const list = process.argv.includes('--list')

/** 审计轮转后旧档在 `.1`：两边按「旧在前、新在后」读，和台账那条口径一致。 */
function readRows(files) {
  const rows = []
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim() === '') continue
      try {
        rows.push(JSON.parse(line))
      } catch {
        // 半行多半是正在写：跳过，不猜。
      }
    }
  }
  return rows
}

const audit = [join(dir, 'audit.jsonl.1'), join(dir, 'audit.jsonl')]
const rows = readRows(audit)
const assessments = rows.filter((row) => row?.type === 'assess')
if (assessments.length === 0) {
  console.log(`没有评估样本：${audit.join('、')} 里没有 type=assess 的行`)
  process.exit(0)
}

const window = assessments.slice(-sample)
const boot = bootAt(dir)
const after = window.filter((row) => String(row.at) >= boot)
const before = window.filter((row) => String(row.at) < boot)

const failed = (list) => list.filter((row) => row?.detail?.ok !== true)
const reasons = (list) => {
  const seen = {}
  for (const row of failed(list)) {
    const key = String(row?.detail?.error ?? 'unknown')
    seen[key] = (seen[key] ?? 0) + 1
  }
  return Object.entries(seen)
    .map(([key, count]) => `${key} ${count}`)
    .join('、')
}

console.log(`数据目录：${dir}`)
console.log(`启动时刻：${boot === '' ? '读不到（run-state.json 没有 at）' : boot}（UTC）`)
console.log(`窗口：${window.length} 条，${window[0].at} .. ${window[window.length - 1].at}（UTC）`)
console.log('')
console.log(`启动前：${before.length} 条，失败 ${failed(before).length} 条${before.length > 0 && failed(before).length > 0 ? `（${reasons(before)}）` : ''}`)
console.log(`启动后：${after.length} 条，失败 ${failed(after).length} 条${after.length > 0 && failed(after).length > 0 ? `（${reasons(after)}）` : ''}`)
if (after.length < 20) {
  console.log(`（启动后的样本只有 ${after.length} 条，还没到能下结论的数量；先攒到 20 条左右再看）`)
}

if (list) {
  console.log('')
  console.log('---- 最近 50 条 ----')
  for (const [index, row] of window.entries()) {
    const ok = row?.detail?.ok === true
    const flag = String(row.at) >= boot ? '后' : '前'
    console.log(`${String(index + 1).padStart(2)} ${row.at} ${flag} ${ok ? 'ok' : `失败 ${row?.detail?.error ?? '?'}`}`)
  }
}

/** 本次启动时刻：插件自己写在 run-state.json 里，只有一次写入（每次启动覆盖）。 */
function bootAt(root) {
  const file = join(root, 'run-state.json')
  if (!existsSync(file)) return ''
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    return typeof state?.at === 'string' ? state.at : ''
  } catch {
    return ''
  }
}
