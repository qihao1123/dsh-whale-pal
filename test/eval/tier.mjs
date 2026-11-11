/**
 * 失忆率两级（2026-11-09 人类签字拆分判据 4）：只做纯计算，不碰盘。
 *
 * 为什么要拆：旧口径 `1 − R@3` 把两件代价完全不同的事混成一个数 ——
 * 「这条压根没被看见」和「看见了但排在第四」。前者是真失忆（不知道有这段记忆），
 * 后者在新架构（目录 + 取回）下只是多取一次，不该按失忆算。
 *
 * 级一「目录召回」：这一轮注入里，这条记忆能不能被看见 ——
 *   正文出现在「记得 / 未完成 / 一直记着」里，或者目录行里有它的「编号 · 主题」。
 *   两者任一即算命中：正文露出来了就是最强的「看见」，不需要再给指针。
 *
 * 级二「取回命中」：拿它的编号真取回（`readEntry` + `renderRead`，≤2000 字），
 *   取回来的文本里有没有这条的答案。查不到、截断把答案切掉了、取到的是别的条目，
 *   都算没命中。
 *   **要原话的用例（evidence）另加一条**：取回的文本里得真的含档案取回的原话，
 *   只拿回转述不算命中 —— 这条正是旧口径看不见的那格（EVID 0/12，失忆率却报 8.3%）。
 *   判的是「原话出现在取回文本里」，不是「条目里有个 ref 字段」。
 *
 * 两条分母相同：带 `expect` 的召回用例（recall + evidence），与旧口径同一批。
 * 级二不看级一：即使这一轮正文已经露出来，取回路径照样拿这个编号试一次 ——
 * 它量的是「路径保不保得住」，不是「这一轮用户运气好不好」。
 * 所以两条会同时低才叫好；级一高、级二低 = 这一轮靠正文侥幸，路径已经坏了。
 */

/** 判据 4 的上限，两级各算一次。定这个数的是人类（原判据 ≤10%），改它要人类点头。 */
export const TIER_LIMIT = 0.1

/** 目录行里的一行：`M-001 · 一句主题`。只认行首那段，主题里再出现编号不算。 */
const ID_LINE = /^(M-\d+)\s*·/u

/**
 * 从注入文本里取目录行上的编号。
 *
 * 只认 `目录：` 这一行（`记得：` / `未完成：` 里也有编号时那叫正文，不叫目录）。
 * 分隔符与 `renderStateSummary` 一致：`；`。
 */
export function catalogIdsOf(summary) {
  const ids = []
  for (const line of String(summary ?? '').split('\n')) {
    const index = line.indexOf('：')
    if (index < 0 || line.slice(0, index) !== '目录') continue
    for (const part of line.slice(index + 1).split('；')) {
      const match = part.trim().match(ID_LINE)
      if (match) ids.push(match[1])
    }
  }
  return ids
}

/**
 * 判一条用例的两级结果。入参全是「已经量好的事实」：
 *   - `shown`  正文是否出现在注入的召回行里（由调用方按 expect 定位，别在这里再算一遍名次）
 *   - `id`     这条记忆的编号（没有编号 = 取回钥匙都没有）
 *   - `catalogIds` 目录行上的编号
 *   - `fetched` 真取回成形后的文本（`renderRead` 的输出，含原话那一段）
 *   - `expect` 这条用例必须被想起来的片段
 *   - `needsOriginal` 这条要不要原话（evidence）
 *   - `originalText` 从档案里按 seq 捞回来的原话；捞不到就是空串
 */
export function judgeTier({
  shown = false,
  id = '',
  catalogIds = [],
  fetched = '',
  expect = '',
  needsOriginal = false,
  originalText = '',
} = {}) {
  const pointer = String(id ?? '')
  const ids = Array.isArray(catalogIds) ? catalogIds : []
  const inCatalog = pointer !== '' && ids.includes(pointer)
  const dir = shown === true || inCatalog
  const dirVia = shown === true ? '正文' : inCatalog ? '目录' : '没看见'
  const body = String(fetched ?? '')
  let fetch = false
  let fetchWhy = ''
  if (pointer === '') fetchWhy = '没有编号'
  else if (dir !== true) fetchWhy = '级一没命中，连编号都没拿到'
  else if (String(expect ?? '') === '') fetchWhy = '用例没写 expect'
  else if (!body.includes(String(expect))) fetchWhy = '取回文本里没有答案'
  else if (needsOriginal === true && String(originalText ?? '') === '') fetchWhy = '只拿回转述，追不到原话（ref 或档案缺）'
  else if (needsOriginal === true && !body.includes(String(originalText))) fetchWhy = '原话没进取回的文本'
  else fetch = true
  return { dir, dirVia, inCatalog, fetch, fetchWhy }
}

/** 把逐条结果合成两个率。分母 0 时报「未实测」，不报 0%。 */
export function tierRates(rows) {
  const list = Array.isArray(rows) ? rows : []
  const total = list.length
  const dirHits = list.filter((row) => row.dir === true).length
  const fetchHits = list.filter((row) => row.fetch === true).length
  const miss = (hit) => (total === 0 ? null : 1 - hit / total)
  const dirMiss = miss(dirHits)
  const fetchMiss = miss(fetchHits)
  return {
    total,
    dirHits,
    fetchHits,
    dirMiss,
    fetchMiss,
    dirPass: dirMiss !== null && dirMiss <= TIER_LIMIT,
    fetchPass: fetchMiss !== null && fetchMiss <= TIER_LIMIT,
    /** 一格多少：分母 12 时 8.3%，用来提醒「再掉一条就过线」。 */
    cell: total === 0 ? null : 100 / total,
  }
}
