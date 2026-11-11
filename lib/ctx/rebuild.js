/**
 * 从卡片重装派生内容：`索引.md`（落盘的那一份）+ 条目表（按需现算，不落盘）。
 *
 * 口径出处：`融合计划-v2.md` §16.5；「档案是唯一源、索引是派生物」见
 * `docs/P35-补全.md` 第四节（删掉整个 `_上下文/` 也应能从档案重建）。
 *   - 只组装，不落盘：写入由 `store.js` 负责，本文件不碰 fs、不读环境变量、不看时钟；
 *   - 卡片一律按编号升序排（C002 在 C010 前，C1000 在 C999 后），入参顺序不影响结果；
 *   - 条目只抽 `rule` 这一路，标 `way:'rule'`；`model` 那一路由运行时另给（`mergeEntries`）。
 *
 * `entries.js` 未落地时的临时兜底：`entriesText` 只出五列表头，并在返回值里带
 * `reason:'entries-unavailable'`。等 `entries.js`（或调用方经第二参传入的 deps）到位，
 * 这段兜底不再触发——它是过渡件，不是新口径。
 */
import { rowOf, renderIndex, compareId } from './index3.js'

/** 条目表五列（`docs/P35-补全.md` 第四节），只在兜底时用。 */
const ENTRIES_HEADER = '| 序号 | 类型 | 内容 | 来源编号 | 抽取方式 |'
const ENTRIES_DIVIDER = '|---|---|---|---|---|'

/**
 * 条目模块已经是常驻文件了（`lib/ctx/entries.js`），所以用静态导入，不再顶层 await：
 * 顶层 await 会让整条 import 链变成异步求值，插件加载时多一层不确定。
 * 第二参 `deps` 仍然能覆盖它——测试靠这个把「条目模块不可用」那条路也锁住。
 */
import { extractRules as defaultExtractRules, mergeEntries as defaultMergeEntries, renderEntries as defaultRenderEntries } from './entries.js'

const entriesModule = { extractRules: defaultExtractRules, renderEntries: defaultRenderEntries }

/** 兜底文本：五列表头 + 分隔行 + 尾换行。 */
function emptyEntriesText() {
  return `${ENTRIES_HEADER}\n${ENTRIES_DIVIDER}\n`
}

/** 取一套可用的条目接口：显式 deps 优先，其次开模块时拉到的那份。 */
function entriesApi(deps) {
  const source = deps ?? entriesModule
  if (!source) return null
  const extractRules = typeof source.extractRules === 'function' ? source.extractRules : null
  const renderEntries = typeof source.renderEntries === 'function' ? source.renderEntries : null
  if (!extractRules || !renderEntries) return null
  // 合并那一步纯逻辑、无依赖，stub 没给就用本模块的默认实现。
  const mergeEntries = typeof source.mergeEntries === 'function' ? source.mergeEntries : defaultMergeEntries
  return { extractRules, renderEntries, mergeEntries }
}

/**

/**
 * 两份文本一次装好，不落盘。
 *
 * 关键词表已删（全仓没有读侧，是纯展示壳）；条目表也不再落盘，改由调用方现算
 * ——`索引.md` 是唯一还在盘上的派生物（第二批形态审计）。
 *
 * @param {Array} cards 卡片对象数组（形状见 `docs/P35-串联.md`）
 * @param {{ extractRules?: Function, renderEntries?: Function }} [deps] 可选：显式传条目模块，
 *   传了就覆盖 `./entries.js`；传空对象等价于「条目模块不可用」。
 * @returns {{ ok: boolean, indexText?: string, entriesText?: string, reason?: string }}
 */
export function rebuildFromCards(cards, deps) {
  if (!Array.isArray(cards)) return { ok: false, reason: 'not-array' }

  const sorted = [...cards].sort((left, right) => compareId(left?.id, right?.id))
  const indexText = renderIndex(sorted.map((card) => rowOf(card)))

  const api = entriesApi(deps)
  if (!api) {
    return { ok: true, indexText, entriesText: emptyEntriesText(), reason: 'entries-unavailable' }
  }

  try {
    const rows = []
    for (const card of sorted) {
      const summary = String(card?.fields?.summary ?? '')
      const sourceId = String(card?.id ?? '')
      const ruleRows = []
      for (const rule of api.extractRules(summary) ?? []) {
        ruleRows.push({ type: rule?.type, content: rule?.content, sourceId, way: 'rule' })
      }
      // 模型补的那一路存在卡片里（`- 条目：` 那几行），同「类型 + 内容」时 model 覆盖 rule。
      const modelRows = (Array.isArray(card?.fields?.entries) ? card.fields.entries : []).map((one) => ({
        type: one?.type,
        content: one?.content,
        sourceId,
        way: 'model',
      }))
      for (const row of api.mergeEntries(ruleRows, modelRows)) rows.push(row)
    }
    return { ok: true, indexText, entriesText: api.renderEntries(rows) }
  } catch {
    // 条目模块抛错按「未就绪」处理：不把别人的异常甩给调用方。
    return { ok: true, indexText, entriesText: emptyEntriesText(), reason: 'entries-unavailable' }
  }
}
