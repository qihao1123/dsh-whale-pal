/**
 * 演练：把两次压缩事件折成档案，落到 `drill/库/_上下文/`，再把派生内容打印出来。
 *
 * 这是验收口径里「① 压缩一次后档案出现、索引新增一行」「⑦ 锚定块前后一致」
 * 「② 删掉整个 _上下文/ 能完整重建」的现场证据。全程没有真的压缩：事件是假的，
 * 折法与落盘走的就是插件里那两条路。
 *
 * 关键词表、条目表、锚定块都不再落盘（第二批形态审计）：只有 `索引.md` 在盘上，
 * 那两表与锚定块按需现算，所以这里现算着打印，不读文件。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { syncArchives } from '../lib/ctx/host-bridge.js'
import { ctxRoot, pathsOf, readCards, rebuildAll } from '../lib/ctx/store.js'
import { anchorText, buildAnchor } from '../lib/ctx/inject.js'
import { rebuildFromCards } from '../lib/ctx/rebuild.js'
import { drainPlan, foldEvent, initialState, summarizePayload } from '../lib/ctx/watch.js'

const VAULT = resolve('drill/库')
const root = ctxRoot(VAULT)

/** 造一条 compaction/summary 事件：形状照 asar 里那份载荷。 */
function compactionEvent(compactionId, at, summary, start, end, tokens) {
  return {
    type: 'compaction/summary',
    at,
    data: {
      compactionId,
      summary: [{ type: 'text', text: summary }],
      shadowedRange: { start, end },
      shadowedSeqs: [start, end],
      shadowedTokenCount: tokens,
      provider: 'deepseek',
      model: 'flash',
    },
  }
}

const api = { getConfig: () => ({ knowledge: { vaultPath: VAULT } }) }

// 每次演练都从空档案目录开始：编号才从 C001 排，读到的数也可复算。
rmSync(root, { recursive: true, force: true })

let state = initialState()
state = foldEvent(
  state,
  compactionEvent(
    'b1000001',
    '2026-11-04T04:10:00+08:00',
    '这一段讲的是上下文档案的两层结构：卡片只放范围、主题、摘要与关键词，原文另存一份，取回时按编号去找。索引只放目录，摘要正文不常驻。\n决定：取回先给编号与一句主题，正文按需再读。',
    'm00010',
    'm00080',
    18600,
  ),
)
state = foldEvent(
  state,
  compactionEvent(
    'b1000002',
    '2026-11-04T04:40:00+08:00',
    '这一段讲的是上下文档案：压缩事件折成待写队列，落盘只在工具或命令被调用时发生，投影重放不写盘。索引只放目录，摘要正文不常驻。\n待办：把索引从档案重建一遍。',
    'm00081',
    'm00120',
    9200,
  ),
)
// prune 不是压缩：只记次数，不该多出一份档案。
state = foldEvent(state, { type: 'compaction/prune', at: '2026-11-04T04:41:00+08:00', data: {} })

const { archives } = drainPlan(state)
const first = syncArchives({ api, pending: archives, now: '2026-11-04 05:00' })
console.log('第一次 sync：', JSON.stringify({ ok: first.ok, ids: first.ids, cards: first.cards, anchorWrote: first.anchorWrote }))

const layout = pathsOf(root)
const anchorOf = () => anchorText({ lines: buildAnchor({ cards: readCards(root) }) })
for (const [name, body] of [
  ['索引（盘上唯一那份派生文件）', readFileSync(layout.index, 'utf8')],
  ['条目（现算，不落盘）', rebuildFromCards(readCards(root)).entriesText],
  ['锚定块（现算，不落盘）', anchorOf()],
]) {
  console.log(`---- ${name}`)
  console.log(body)
}
console.log('盘上没有这三份：', ['关键词.md', '条目.md', '锚定块.md'].filter((name) => existsSync(resolve(root, name))).join('、') || '确认')

// 再来一次：没有新的待写档案，锚定块现算出来还是同一串字。
const anchorBefore = anchorOf()
const second = syncArchives({ api, pending: [], now: '2026-11-04 05:10' })
const anchorAfter = anchorOf()
console.log('第二次 sync：', JSON.stringify({ ok: second.ok, ids: second.ids, anchorWrote: second.anchorWrote }))
console.log('锚定块内容没变：', anchorBefore === anchorAfter)

// 卸妆检查：派生内容里不许出现外挂的名字。
const banned = ['bili', 'billion']
const hits = []
for (const [label, body] of [
  ['索引', readFileSync(layout.index, 'utf8')],
  ['条目', rebuildFromCards(readCards(root)).entriesText],
  ['锚定块', anchorAfter],
]) {
  const text = String(body).toLowerCase()
  for (const word of banned) if (text.includes(word)) hits.push(`${label} 里有 ${word}`)
}
console.log('卸妆检查：', hits.length === 0 ? '干净' : hits.join('；'))

// 重建：整份档案是派生品，删掉 _上下文/ 之后应当能从档案重来。
console.log('重建前存在：', existsSync(root))
const rebuilt = rebuildAll(root)
console.log('重建：', JSON.stringify({ ok: rebuilt.ok }))
if (rebuilt.ok === true) {
  console.log('重建后索引：')
  console.log(readFileSync(layout.index, 'utf8'))
}

// 只清演练用的档案目录，库的其余部分不动。
if (process.argv.includes('--clean')) {
  rmSync(root, { recursive: true, force: true })
  console.log('已清掉演练档案目录')
}
