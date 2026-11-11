// 扫会话日志：空内容的 user/message，以及 20015 报错落在哪一轮。
// 只读，不写任何文件。
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS = 'C:/Users/123/.dsh/sessions'
const WANT = process.argv[2] ?? ''

function walk(root, out = []) {
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out)
    else if (/\.jsonl\.zstd$/u.test(name)) out.push({ file: p, mtime: st.mtimeMs })
  }
  return out
}

const textOf = (event) => {
  const blocks = event?.data?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
    .join('')
    .trim()
}

const rows = []
for (const entry of walk(SESSIONS)) {
  if (WANT && !entry.file.includes(WANT)) continue
  let text
  try {
    text = zstdDecompressSync(readFileSync(entry.file)).toString('utf8')
  } catch (err) {
    rows.push({ file: entry.file, mtime: entry.mtime, error: err.message })
    continue
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* 半截行跳过 */
    }
  }
  const users = events.filter((e) => e?.type === 'user/message')
  const blanks = users.filter((e) => textOf(e) === '')
  const errs = events.filter((e) => JSON.stringify(e).includes('20015'))
  const interesting = blanks.length > 0 || errs.length > 0
  if (!interesting) continue
  rows.push({
    file: entry.file,
    mtime: entry.mtime,
    users: users.length,
    blanks: blanks.map((e) => ({ seq: e.seq, time: e.time })),
    errs: errs.map((e) => ({ type: e.type, seq: e.seq, time: e.time })),
  })
}

rows.sort((a, b) => b.mtime - a.mtime)
for (const row of rows) {
  const when = new Date(row.mtime).toISOString().slice(0, 19).replace('T', ' ')
  const rel = row.file.slice(row.file.indexOf('sessions') + 8)
  console.log(`\n${when} | user ${row.users} | 空 ${row.blanks?.length ?? '-'} | 报错 ${row.errs?.length ?? '-'}`)
  console.log(`  ${rel}`)
  if (row.error) console.log(`  解不开：${row.error}`)
  for (const b of (row.blanks ?? []).slice(0, 5)) console.log(`    空消息 seq ${b.seq} @ ${new Date(b.time).toISOString().slice(0, 19)}`)
  for (const e of (row.errs ?? []).slice(0, 5)) console.log(`    报错 ${e.type} seq ${e.seq} @ ${new Date(e.time).toISOString().slice(0, 19)}`)
}
console.log(`\n共 ${rows.length} 份有问题会话`)
