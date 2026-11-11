/**
 * 造一个「老库」用于演练：把出厂包整份拷到 drill/库，再按已知的老库形态改几处。
 *
 * 为什么不能直接拿真库演练：`D:\AI 空间\记忆空间` 是空库（只有 `.obsidian/` 与两份笔记），
 * 一份 S1 母体都没有，升级过去只会全是 S0 新建，验不到 S1 覆盖与 S2 合并。
 *
 * 改的四类，每类都能在原文里找到对应症状：
 *   1. `系统-配置层/域索引.md` —— 抽掉 IMMUTABLE 哈希头 + 写成 CRLF（§二 139-144 第①类分叉）；
 *   2. 一个用户域的 `域索引.md` —— 表头退回 5 格、第二张表退回旧节名（检测一四判据全不中）；
 *   3. `个人配置层/个人风格指纹.md` —— 整份删掉（§二 138 第①类：老库 `个人配置层\` 少这一份）；
 *   4. `个人配置层/会话状态.md` —— 抽掉「字段清单」那一节（检测五 要补的格）。
 * 另外建 `.obsidian/` 与 `数据/`（零写入验收要盯这两处）。
 *
 * 用法：`node scripts/build-drill.mjs [--force]`
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

export const FACTORY = process.env.WHALE_DRILL_FACTORY ?? ''
export const DRILL_ROOT = join(ROOT, 'drill')
export const DRILL_VAULT = join(DRILL_ROOT, '库')

/** 演练库不许被当成真库：里面的文件都要能一眼看出是造的。 */
export const DRILL_MARK = join(DRILL_VAULT, '_演练库说明.md')

function main() {
  const force = process.argv.includes('--force')
  if (existsSync(DRILL_VAULT)) {
    if (force === false) {
      console.error(`演练库已存在：${DRILL_VAULT}\n要重建就加 --force`)
      process.exit(1)
    }
    rmSync(DRILL_VAULT, { recursive: true, force: true })
  }
  if (existsSync(FACTORY) === false) {
    console.error(`找不到出厂包：${FACTORY}`)
    process.exit(1)
  }

  mkdirSync(DRILL_ROOT, { recursive: true })
  cpSync(FACTORY, DRILL_VAULT, { recursive: true })

  const done = []
  done.push(degradeDomainIndex())
  done.push(degradeDomainIndexUser())
  done.push(removeFingerprint())
  done.push(stripStateFields())
  done.push(makeRuntimeDirs())

  writeFileSync(
    DRILL_MARK,
    [
      '# 演练库（不是真库）',
      '',
      '这一份由 `scripts/build-drill.mjs` 从出厂包复制后故意改坏几处，用来跑升级治理。',
      '改坏的四处：系统层域索引（缺哈希头 + CRLF）、一个用户域域索引（5 格表头 + 旧节名）、',
      '个人风格指纹（整份不在）、会话状态（抽掉字段清单那一节）。',
      '',
      `造于 ${new Date().toISOString()}`,
      '',
    ].join('\n'),
    'utf8',
  )
  done.push('说明件')

  for (const line of done) console.log(`· ${line}`)
  console.log(`\n演练库：${DRILL_VAULT}`)
  console.log('这一份只用于演练；真库一个字都没动。')
}

/** ① 系统层域索引：抽掉哈希头，再把行尾写成 CRLF。 */
function degradeDomainIndex() {
  const target = join(DRILL_VAULT, '系统-配置层', '域索引.md')
  const text = readFileSync(target, 'utf8')
  const lines = text.split('\n')
  const kept = lines[0].startsWith('<!-- SYSTEM:IMMUTABLE HASH:') ? lines.slice(1) : lines
  writeFileSync(target, kept.join('\r\n'), 'utf8')
  return '系统-配置层/域索引.md：抽掉哈希头 + 改成 CRLF'
}

/** ② 一个用户域的域索引：表头退回 5 格、第二张表退回旧节名。 */
function degradeDomainIndexUser() {
  const domain = '01认知与思维-脑子怎么用'
  const target = join(DRILL_VAULT, domain, '域索引.md')
  if (existsSync(target) === false) return `${domain}/域索引.md：没有这一份，跳过`
  const text = readFileSync(target, 'utf8')
  const out = text
    .replace(/^## 概念与标签索引$/mu, '## 域内概念映射')
    .replace(/\| 层级 \| 文件名 \| 版本 \| 一句话核心 \| 标签 \| 适用场景 \| 概念状态 \|/u, '| 层级 | 文件名 | 版本 | 一句话核心 | 状态 |')
    .replace(/^\|:--\|:--\|:--\|:--\|:--\|:--\|:--\|$/mu, '|:--|:--|:--|:--|:--|')
  writeFileSync(target, out, 'utf8')
  return `${domain}/域索引.md：表头退回 5 格 + 旧节名`
}

/** ③ 个人风格指纹整份不在（老库 `个人配置层\` 只有 11 份的那个症状）。 */
function removeFingerprint() {
  const target = join(DRILL_VAULT, '个人配置层', '个人风格指纹.md')
  if (existsSync(target) === false) return '个人配置层/个人风格指纹.md：本来就没有'
  rmSync(target)
  return '个人配置层/个人风格指纹.md：删掉'
}

/** ④ 会话状态抽掉「字段清单」那一节（检测五要补的格）。 */
function stripStateFields() {
  const target = join(DRILL_VAULT, '个人配置层', '会话状态.md')
  if (existsSync(target) === false) return '个人配置层/会话状态.md：没有这一份'
  const text = readFileSync(target, 'utf8')
  const lines = text.split('\n')
  const kept = []
  let skipping = false
  for (const line of lines) {
    if (/^## 字段清单/u.test(line)) {
      skipping = true
      continue
    }
    if (skipping && /^## /u.test(line)) skipping = false
    if (skipping === false) kept.push(line)
  }
  writeFileSync(target, kept.join('\n'), 'utf8')
  return '个人配置层/会话状态.md：抽掉「字段清单」那一节'
}

/** ⑤ `.obsidian/` 与 `数据/`：零写入验收要盯这两处。 */
function makeRuntimeDirs() {
  mkdirSync(join(DRILL_VAULT, '.obsidian'), { recursive: true })
  writeFileSync(join(DRILL_VAULT, '.obsidian', 'app.json'), '{"legacyEditor":false}\n', 'utf8')
  mkdirSync(join(DRILL_VAULT, '数据', '心跳', 'logs'), { recursive: true })
  writeFileSync(join(DRILL_VAULT, '数据', '心跳', 'heartbeat-wrapper.ps1'), '# 旧版心跳脚本（演练用）\n', 'utf8')
  return '.obsidian/ 与 数据/心跳/logs/ 建好'
}

main()
