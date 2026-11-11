/**
 * 确认口令：只按字面判。
 *
 * 口径（融合计划 D4，一个字都不放松）：
 *   - 唯一合法形状是「确定／确认」+ 阶段号，例如 `确定stage 3 阶段`、`确定 stage3`、`确认三阶段`；
 *   - 口令可以夹在整句里（「按你的理解；确定stage 4 阶段」也算），因为 D4 口径是「含」；
 *     但前面挂否定词的不算——「我不确定stage 4 阶段」是犹豫，不是按了；
 *   - 全半角归一、stage 与数字之间的空格可有可无、大小写不敏感；
 *   - 阶段号必须等于当前待确认的那个号，不符不算；
 *   - `确定工序 M` 是另一套号，不与阶段口令混用；
 *   - `对 / 好 / 可以 / 嗯 / OK / 继续` 与沉默都不算——一律回问同一句。
 *
 * 为什么这么严：语气词放过去一次，门禁就形同虚设，
 * 之后每一次「替你按一下」都会显得合情合理。
 */

/** 回问用的一句。所有不合规输入都回这一句，不改口、不加解释。 */
export const ASK_AGAIN = '要确认这一步，回我一句「确定stage 阶段号 阶段」，阶段号得是现在待确认的那个。'

const CN_DIGITS = Object.freeze({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 })

/** 全角转半角 + 去空白 + 转小写。只看形状，不改意思。 */
export function normalizeToken(raw) {
  const text = String(raw ?? '')
  const folded = text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
  return folded
}

function toNumber(text) {
  if (/^[0-9]+$/.test(text)) return Number(text)
  if (text.length === 1 && CN_DIGITS[text]) return CN_DIGITS[text]
  return null
}

/**
 * 解析一条确认口令。
 *
 * @param {string} raw 用户原话
 * @param {{ pending?: number }} options pending 是当前待确认的阶段号，0 表示没有待确认项
 * @returns {{ ok: boolean, stage?: number, reason?: string }}
 *   reason: empty | not-a-token | workstep-token | no-stage | nothing-pending | wrong-stage
 */
export function parseConfirm(raw, { pending = 0 } = {}) {
  const text = normalizeToken(raw)
  if (!text) return { ok: false, reason: 'empty' }

  if (/确定|确认/u.test(text) === false) return { ok: false, reason: 'not-a-token' }
  if (/(确定|确认)工序/u.test(text)) return { ok: false, reason: 'workstep-token' }

  // 整句搜索：命中可能不止一处，取最后一处（人改口时会先说一遍再说一遍）。
  // 否定词打头的跳过：不 / 没 / 别 / 否 / 未。
  const pattern = /(确定|确认)(?:stage|阶段)?([0-9]+|[一二三四五六七八九])/gu
  const negated = new Set(['不', '没', '别', '否', '未'])
  let match = null
  let negatedHit = false
  for (const hit of text.matchAll(pattern)) {
    const before = text.slice(0, hit.index).slice(-1)
    if (negated.has(before)) {
      negatedHit = true
      continue
    }
    // 「确定一下」里的「一」不是阶段号：量词用法，按没说清处理。
    const after = text.slice((hit.index ?? 0) + hit[0].length).slice(0, 1)
    if (hit[2] === '一' && after === '下') continue
    match = hit
  }
  if (!match) {
    // 有「确定」但前面挂着否定、或者后面跟的是量词：都不算说清。
    return { ok: false, reason: negatedHit ? 'not-a-token' : 'no-stage' }
  }

  const stage = toNumber(match[2])
  if (!stage) return { ok: false, reason: 'no-stage' }
  if (!pending) return { ok: false, reason: 'nothing-pending' }
  if (stage !== pending) return { ok: false, reason: 'wrong-stage' }

  return { ok: true, stage }
}

/** 门禁用：这条口令算不算「按了」。 */
export function isConfirmed(raw, options) {
  return parseConfirm(raw, options).ok
}
