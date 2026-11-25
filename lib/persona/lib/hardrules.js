/**
 * 写死的规则（记忆分层 P3 规则五）：人写的常驻指令永远赢过学来的。
 *
 * 「写死」= 工作区里的 AGENTS.md（DSH 每次开会话都会读它）+ 插件配置里人写的额外边界。
 * 这些是确定性的、人定的；记忆是从对话里学出来的。两者冲突时：
 *   1. 写死的赢；
 *   2. 学到的只做补充、不覆盖；
 *   3. **直接矛盾的当噪声丢掉，不存**，并留一句为什么丢。
 *
 * 判据必须窄：只认「去掉否定词之后一模一样」这一种矛盾。
 * 更宽的相似度判断会变成隐藏分类器——把正常记忆误杀，而且没人看得出为什么。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const NEGATION = /[不别没勿莫无非]/gu

/** 一条规则的正文：去掉列表符号、编号和空白。 */
function cleanRuleLine(line) {
  return String(line ?? '')
    .replace(/^\s*(?:[-*+]|\d+[.)、])\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** 从一份 AGENTS.md 里抽出条目。只拿列表项和编号项——正文段落是说明，不是规则。 */
export function rulesFromText(text, max = 200) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/u)) {
    if (!/^\s*(?:[-*+]|\d+[.)、])\s+/u.test(line)) continue
    const value = cleanRuleLine(line)
    if (value.length < 4) continue
    out.push(value.slice(0, 200))
    if (out.length >= max) break
  }
  return out
}

/**
 * 收集当前写死的规则。
 *
 * 读 `<cwd>/AGENTS.md`，没有就往上找（工作区根通常在上层）；
 * 加上 `<home>/AGENTS.md`（跨工作区常驻的那份）和配置里的额外边界。
 * 读不到就是空数组——这不是错误，不能因为它挡了记忆写入。
 */
export function readHardcodedRules({ cwd = '', home = '', extraBoundaries = '', max = 200 } = {}) {
  const files = []
  const start = String(cwd ?? '').trim()
  if (start !== '') {
    let current = resolve(start)
    for (let depth = 0; depth < 8; depth += 1) {
      const file = join(current, 'AGENTS.md')
      if (existsSync(file)) {
        files.push(file)
        break
      }
      const up = dirname(current)
      if (up === current) break
      current = up
    }
  }
  if (String(home ?? '').trim() !== '') {
    const global = join(String(home).trim(), 'AGENTS.md')
    if (existsSync(global)) files.push(global)
  }

  const rules = []
  for (const file of files) {
    try {
      rules.push(...rulesFromText(readFileSync(file, 'utf8'), max))
    } catch {
      /* 读不了就当没有 */
    }
  }
  // 配置里的额外边界是多行自由文本，按行取。
  for (const line of String(extraBoundaries ?? '').split(/\r?\n/u)) {
    const value = cleanRuleLine(line)
    if (value.length >= 4) rules.push(value.slice(0, 200))
  }
  return [...new Set(rules)].slice(0, max)
}

/** 去掉否定词、去掉标点空白之后的样子：用来判「是不是同一句话，只是正反相反」。 */
function polarityKey(text) {
  return String(text ?? '')
    .replace(NEGATION, '')
    .replace(/[\s，。、,.！!？?：:；;「」『』()（）【】\[\]~～\-—_]/gu, '')
    .toLowerCase()
}

function negationCount(text) {
  return (String(text ?? '').match(NEGATION) ?? []).length
}

/**
 * 这条学来的记忆跟哪条写死的规则直接矛盾？
 *
 * 只认一种：两边去掉否定词、标点和空白之后一模一样，但否定词个数不同。
 * 例如写死「不接受被叫主人」，学到「接受被叫主人」——这就是要丢的那条。
 * 其余相似的一律不算：宁可漏判，也不许把正常记忆误杀。
 *
 * @returns {{rule: string}|null}
 */
export function findConflictingRule(text, rules) {
  const key = polarityKey(text)
  if (key.length < 4) return null
  const mine = negationCount(text)
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (polarityKey(rule) !== key) continue
    if (negationCount(rule) === mine) continue
    return { rule }
  }
  return null
}
