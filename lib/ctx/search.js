/**
 * 索引自查：按词找档案、列文件、给读法提示。
 *
 * 口径出处：`融合计划-v2.md` §16.5；`LIMIT = 3` 对应「模型自查最多 3 次」，
 * 见 `docs/P35-串联.md` 第二节第 9 行。
 *   - 命中范围只算 `主题` 与 `关键词`，大小写不敏感、子串匹配；
 *   - 一次最多回 `LIMIT` 条，多的不排队——查不到就认清不到，不自己扩查询；
 *   - 一条都没有：`{ok:true, rows:[], hit:false, text:NOT_FOUND}`，不抛。
 *
 * 纯函数：不读盘、不读环境变量、不看时钟。
 */
import { parseIndex, compareId } from './index3.js'

/** 一次最多回几条。 */
export const LIMIT = 3

/** 查不到时给的唯一一句。 */
export const NOT_FOUND = '记录里没查到这条'

/** 一行命中：主题命中或任一关键词命中。 */
function hitOf(row, needle) {
  const topic = String(row?.topic ?? '').toLowerCase()
  if (topic.includes(needle)) return true
  return (Array.isArray(row?.keywords) ? row.keywords : []).some((keyword) =>
    String(keyword ?? '').toLowerCase().includes(needle),
  )
}

/**
 * 在索引里按词找。
 *
 * @param {{ text?: string, query?: string }} input 索引全文与查询词
 * @returns {{ ok: boolean, rows: Array, hit: boolean, text?: string, reason?: string }}
 */
export function searchIndex({ text, query } = {}) {
  const parsed = parseIndex(text)
  if (!parsed.ok) return { ok: false, reason: parsed.reason ?? 'not-text', rows: [], hit: false }

  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return { ok: true, rows: [], hit: false, text: NOT_FOUND }

  const rows = parsed.rows.filter((row) => hitOf(row, needle)).slice(0, LIMIT)
  if (rows.length === 0) return { ok: true, rows: [], hit: false, text: NOT_FOUND }
  return { ok: true, rows, hit: true }
}

/**
 * 列档案清单，一行一条：`C001 · 主题（文件 C001.md）`。
 *
 * @param {{ cards?: Array }} input 卡片数组（形状见串联文档）
 * @returns {string[]} 按编号升序；非数组入参回空数组
 */
export function listFiles({ cards } = {}) {
  if (!Array.isArray(cards)) return []
  return [...cards]
    .sort((left, right) => compareId(left?.id, right?.id))
    .map((card) => {
      const id = String(card?.id ?? '')
      const topic = String(card?.fields?.topic ?? '')
      const blockId = String(card?.blockId ?? id)
      return `${id} · ${topic}（文件 ${blockId}.md）`
    })
}

/** 读某一号档案的提示语，一句，不绕。 */
export function readHint(id) {
  const number = String(id ?? '')
  return `想知道 ${number} 里写了什么，就问我「读 ${number}」`
}
