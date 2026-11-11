/**
 * 召回层：先按「这句话在问什么」选出候选，再交给排序层。
 *
 * 为什么要有它（2026-11-06 实测定位）：
 *   原来 `selectMemory` 只有一步——四类记忆共用一个槽位池，按全局
 *   `salience × 新鲜度` 取前 N。那是**排序**，不是**召回**。
 *   于是问「Node 版本」（salience 0.396）会被一条 neovim 的高分事实（0.90）顶掉，
 *   尽管前者才是这句该想起来的那条。实测失忆率 33.3%，四条里有三条是这么丢的。
 *
 * 口径（旧版人格框架 `根配置.md` §8.1 V4.1 修订）：
 *   **召回（相关性选人）≠ 排序（权重排人）** —— 先按当前相关性 + 实体匹配决定
 *   「该找什么」，再按权重表决定「怎么排」。
 *
 * 纯模块：不碰盘、不看时钟、零依赖。切词只用 `Intl.Segmenter`（Node 内置）或退化切法。
 */

/** 中文里出现频率极高、对判别「在问什么」没帮助的词。 */
const STOP_WORDS = new Set([
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那', '就', '都', '也',
  '和', '与', '在', '有', '没', '不', '吗', '呢', '吧', '啊', '呀', '哦', '嗯',
  '一个', '什么', '怎么', '为什么', '哪个', '哪些', '多少', '怎样', '如何',
  '还', '再', '又', '很', '太', '更', '最', '会', '能', '要', '想', '说', '看',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
])

/** 单字查询词太容易误命中（「的」「是」），两个字起才当实体。 */
const MIN_WORD_LEN = 2

/**
 * 切词：优先用 `Intl.Segmenter('zh')`（Node 18+ 内置，按词切中文），
 * 拿不到就退化成「按标点/空白切 + 中文按二字滑窗」。
 *
 * @returns {string[]} 去重后的小写词，已去停用词
 */
export function tokenize(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return []
  const words = []

  // 中文二字滑窗：不依赖词典，专治 Segmenter 把「台账」切成「台」「账」这种。
  // 只在连续汉字段上滑，所以英文与标点不会被卷进来。
  const cjkBigrams = (piece) => {
    const out = []
    for (const run of String(piece).match(/[\u4e00-\u9fa5]+/gu) ?? []) {
      for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2))
    }
    return out
  }

  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const seg = new Intl.Segmenter('zh', { granularity: 'word' })
      for (const part of seg.segment(raw)) {
        if (part?.isWordLike !== true) continue
        words.push(String(part.segment).toLowerCase())
      }
    }
  } catch {
    // 退化到下面
  }

  // 中文**始终**补二字滑窗：Segmenter 的分词粒度不可靠——它会把「台账」切成
  // 「台」「账」两个单字，而单字会被 MIN_WORD_LEN 滤掉，那个词就彻底消失了。
  // 滑窗不需要词典，代价是词多一点，但召回只看「命中」，多几个词不会误伤。
  for (const piece of raw.split(/[\s,，。；;：:！!？?、()（）[\]【】"'“”]+/u)) {
    const item = piece.trim()
    if (item === '') continue
    if (/^[A-Za-z0-9_.-]+$/u.test(item)) {
      words.push(item.toLowerCase())
      continue
    }
    for (const bigram of cjkBigrams(item)) words.push(bigram)
  }

  // 滑窗出来的二字词要再过一道：两个字都是虚词的组合（「的了」「是我」「这那」）
  // 不是实体，留着只会让召回误命中。判据是「拆开看每个字都在停用字表里」。
  const FUNCTION_CHARS = new Set('的了是我你他她它们这那就都也和与在有没不吗呢吧啊呀哦嗯还再又很太更最会能要想说看个什怎么'.split(''))
  const allFunction = (word) => [...word].every((ch) => FUNCTION_CHARS.has(ch))

  const seen = new Set()
  const out = []
  for (const word of words) {
    if (word.length < MIN_WORD_LEN) continue
    if (STOP_WORDS.has(word)) continue
    if (/[\u4e00-\u9fa5]/u.test(word) && word.length === 2 && allFunction(word)) continue
    if (seen.has(word)) continue
    seen.add(word)
    out.push(word)
  }
  return out
}

/**
 * 召回分：这条记忆命中了查询里的几个词。
 *
 * @returns {{ hit: number, matched: string[] }} hit = 命中词数 / 查询词总数（0~1）
 */
export function recallScore(text, queryWords) {
  const words = Array.isArray(queryWords) ? queryWords : []
  if (words.length === 0) return { hit: 0, matched: [] }
  const target = String(text ?? '').toLowerCase()
  if (target === '') return { hit: 0, matched: [] }
  const matched = words.filter((word) => target.includes(word))
  return { hit: matched.length / words.length, matched }
}

/**
 * 两段式：先召回，后排序。
 *
 * 规则（方案 §2.1）：
 *   1. 查询词命中 >0 的进候选池；
 *   2. 候选池不足 `limit` 时，用存量分补位（不能因为召回不上就一条不给）；
 *   3. 池内仍按存量分（`scoreEntry`）排序。
 *
 * @param {Array<{kind: string, text: string, score: number}>} entries 已算好存量分的候选
 * @param {{ query?: string, limit?: number }} options
 * @returns {{ picked: Array, recall: { words: string[], hits: number, usedFallback: boolean } }}
 */
export function recallThenRank(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  const limit = Math.max(0, Math.floor(Number(options.limit) || 0))
  const words = tokenize(options.query)

  if (words.length === 0) {
    // 没有查询词（冷启、或这轮没说话）：老路子，纯排序。
    return {
      picked: [...list].sort((a, b) => b.score - a.score).slice(0, limit),
      recall: { words: [], hits: 0, usedFallback: true },
    }
  }

  const hit = []
  for (const entry of list) {
    const { hit: ratio, matched } = recallScore(entry?.text, words)
    if (ratio > 0) hit.push({ ...entry, recallHit: ratio, matched })
  }

  const usedFallback = hit.length < limit
  let picked = [...hit].sort((a, b) => b.score - a.score)
  if (usedFallback) {
    // 补位：召回没覆盖到的，按存量分从高到低填满。
    const taken = new Set(picked.map((item) => `${item.kind}\u0000${item.text}`))
    const rest = list
      .filter((entry) => taken.has(`${entry?.kind}\u0000${entry?.text}`) === false)
      .sort((a, b) => b.score - a.score)
    for (const entry of rest) {
      if (picked.length >= limit) break
      picked.push({ ...entry, recallHit: 0, matched: [] })
    }
  }

  return { picked: picked.slice(0, limit), recall: { words, hits: hit.length, usedFallback } }
}

// ------------------------------------------------------------------ 分档

/**
 * 档位阈值（方案 §2.2 草案）。
 *
 * 为什么分四档而不是二态：「记得 / 不记得」丢掉了中间那层——
 * 一条分数不高但这次正好相关的记忆，和一条分数很高但跟这句话无关的记忆，
 * 在二态里长得一样，模型只能靠猜。分档是把这个区别显式写出来。
 */
export const TIER = {
  HIGH: 'high',
  MID: 'mid',
  LOW: 'low',
  NONE: 'none',
}

export const TIER_THRESHOLD = {
  /** 存量分到这个数算「本来就重要」。 */
  highScore: 0.7,
  /** 召回命中率到这个数算「这句就在问它」。 */
  highHit: 0.5,
  /** 存量分低于这个数、且有召回命中 → 低档（要用先确认）。 */
  lowScore: 0.3,
  /** 无权重：这么久没被提起，且没有召回命中，就不进注入。 */
  staleSessions: 180,
}

/**
 * 给一条候选定档。
 *
 * @param {{score: number, recallHit?: number, lastSeenSession?: number}} entry
 * @param {{session?: number, thresholds?: object}} options
 */
export function tierOf(entry, options = {}) {
  const t = { ...TIER_THRESHOLD, ...(options.thresholds ?? {}) }
  const score = Number(entry?.score) || 0
  const hit = Number(entry?.recallHit) || 0
  const session = Number(options.session) || 0
  const seen = Number(entry?.lastSeenSession) || 0
  const stale = session - seen >= t.staleSessions

  if (score >= t.highScore || hit >= t.highHit) return TIER.HIGH
  if (score < t.lowScore && hit > 0) return TIER.LOW
  // 无权重：很久没提起，而且这句话也没问到它 —— 只在取回工具里出现，不进注入。
  if (stale && hit === 0) return TIER.NONE
  return TIER.MID
}

/** 档位标记：高档行首加 `!`，低档行尾加一句「要用先确认」。中档什么都不加。 */
export const TIER_MARK = {
  high: '!',
  low: '（低权重，确认再用）',
}

/**
 * 把一条候选按档位渲染成注入里的一格。
 *
 * 只做标记，不改正文：改了正文就不是「同一句话」了，取回时会对不上。
 */
export function markTier(text, tier) {
  const body = String(text ?? '').trim()
  if (body === '') return ''
  if (tier === TIER.HIGH) return `${TIER_MARK.high}${body}`
  if (tier === TIER.LOW) return `${body}${TIER_MARK.low}`
  return body
}

/**
 * 分档后的候选：把 NONE 档剔掉，其余带上 `tier`。
 *
 * 剔除放在这一层而不是渲染层：渲染层拿到什么画什么，
 * 让渲染层去判断「这条该不该出现」等于把决策藏进展示里。
 */
export function splitByTier(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : []
  const kept = []
  const dropped = []
  for (const entry of list) {
    const tier = tierOf(entry, options)
    if (tier === TIER.NONE) dropped.push({ ...entry, tier })
    else kept.push({ ...entry, tier })
  }
  return { kept, dropped }
}

// ------------------------------------------------------------------ 失误归因

/**
 * 失误三分类（方案 §2.4，照 `记忆系统.md` §三）。
 *
 * 三种失误长得很像，但修法完全不同，混成一类就永远修不对：
 *   - **召回漏**：条目在库里、该进注入，却没进（或进了但排太后）。修召回层。
 *   - **召回噪**：不该进注入的进了，挤掉该进的。修排序或档位阈值。
 *   - **路由错**：注入是对的，但取回取错了条目（编号指错、或该取 A 取了 B）。修取回。
 *
 * 归因只依据三件可观测的事实，不猜模型心理：
 *   1. 这条在不在库里（`inStore`）；
 *   2. 在不在注入里（`inInjection`）；
 *   3. 在注入里的话排第几（`rank`，1 起）。
 */
export const MISTAKE = {
  RECALL_MISS: '召回漏',
  RECALL_NOISE: '召回噪',
  ROUTE_WRONG: '路由错',
}

/**
 * 归因一条失败的召回用例。
 *
 * @param {{inStore: boolean, inInjection: boolean, rank?: number|null, expectRank?: number}} facts
 * @returns {{ type: string|null, why: string, fix: string }}
 *          type 为 null 表示这不是检索的错（比如用例本身写错了），不许硬塞一个类型。
 */
export function attributeMistake(facts = {}) {
  const inStore = facts.inStore === true
  const inInjection = facts.inInjection === true
  const rank = Number(facts.rank) || 0
  const want = Number(facts.expectRank) || 3

  if (!inStore) {
    // 库里根本没有这条：既不是召回漏也不是路由错，是采集没采到。
    // 这一条必须单独说，否则会一直去调召回层，而问题在写入侧。
    return {
      type: null,
      why: '条目不在库里：这次失败不是检索造成的，是它压根没被记下来',
      fix: '查写入侧（采集闸门 / 评估模型有没有漏），不要调召回层',
    }
  }
  if (!inInjection) {
    return {
      type: MISTAKE.RECALL_MISS,
      why: '条目在库，但没进注入',
      fix: '查召回层：这句话的词有没有被切出来、候选池够不够、档位有没有把它判成无权重',
    }
  }
  if (rank > want) {
    return {
      type: MISTAKE.RECALL_MISS,
      why: `条目进了注入，但排在行内第 ${rank}（要求前 ${want}）`,
      fix: '查排序：命中率与存量分的权重是不是让它排太后，或槽位太少',
    }
  }
  return { type: null, why: `已排在行内第 ${rank}，判定为命中`, fix: '无新增' }
}
