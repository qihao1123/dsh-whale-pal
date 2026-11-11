#!/usr/bin/env node
/**
 * 卸载前只读体检：告诉你该摘哪一行、数据在哪、审计里都记了什么。
 *
 * 这个脚本一个字节都不写——卸载是人工动作。原因很简单：卸错了要能回退，
 * 而「脚本自己动手」会让回退这件事没有中间状态可看。
 *
 * 用法：
 *   node scripts/uninstall-check.mjs
 *   node scripts/uninstall-check.mjs --profile desktop
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLUGIN = 'dsh-whale-pal'
const PLUGIN_DIR = 'whale-pal'

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const profile = arg('profile', process.env.DSH_PROFILE || 'desktop')
const profileDir = join(home, 'profiles', profile)
const manifestFile = join(profileDir, 'package.json')
const patchFile = join(profileDir, 'cordis.patch.yml')
const dataDir = join(home, PLUGIN_DIR, profile)

function readJson(file) {
  if (existsSync(file) !== true) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function lines(file) {
  if (existsSync(file) !== true) return []
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/u)
  } catch {
    return []
  }
}

function sizeOf(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

/** 三份清单：依赖、bundles、patch 文件里提到它的行。 */
function inventory() {
  const manifest = readJson(manifestFile) ?? {}
  const dependencies = manifest?.dependencies ?? {}
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
  const patchLines = lines(patchFile)
    .map((text, index) => ({ text: text.trim(), line: index + 1 }))
    .filter((item) => item.text.includes(PLUGIN))

  return {
    dependency: Object.hasOwn(dependencies, PLUGIN) ? dependencies[PLUGIN] : null,
    bundle: bundles.includes(PLUGIN),
    patchLines,
  }
}

function dataFiles() {
  if (existsSync(dataDir) !== true) return []
  const out = []
  const walk = (dir, prefix) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, rel)
        continue
      }
      out.push({ rel, size: sizeOf(full) })
    }
  }
  walk(dataDir, '')
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

function auditSummary() {
  const file = join(dataDir, 'audit.jsonl')
  if (existsSync(file) !== true) return { total: 0, byType: {}, last: [] }
  const rows = []
  for (const line of lines(file)) {
    const text = line.trim()
    if (text === '') continue
    try {
      rows.push(JSON.parse(text))
    } catch {
      /* 坏行跳过：审计读不全也不该让体检失败 */
    }
  }
  const byType = {}
  for (const row of rows) {
    const type = typeof row?.type === 'string' ? row.type : 'unknown'
    byType[type] = (byType[type] ?? 0) + 1
  }
  return { total: rows.length, byType, last: rows.slice(-5) }
}

const parts = inventory()
const files = dataFiles()
const audit = auditSummary()

console.log(`profile：${profileDir}`)
console.log(`数据目录：${dataDir}${existsSync(dataDir) === true ? '' : '（不存在）'}`)
console.log('')

console.log('要摘掉的地方：')
console.log(
  parts.dependency === null
    ? '  package.json 里没有它的依赖 —— 不用动'
    : `  package.json → dependencies["${PLUGIN}"]（现在是 ${parts.dependency}）`,
)
console.log(
  parts.bundle === false
    ? '  dsh.profile.bundles 里没有它 —— 不用动'
    : `  package.json → dsh.profile.bundles 里的 "${PLUGIN}"`,
)
if (parts.patchLines.length === 0) {
  console.log('  cordis.patch.yml 里没有它的行 —— 不用动')
} else {
  for (const item of parts.patchLines) {
    console.log(`  cordis.patch.yml:${item.line}  ${item.text}`)
  }
}
console.log('')

console.log(`数据文件 ${files.length} 个：`)
for (const file of files) console.log(`  ${file.rel}  ${file.size} B`)
if (files.length === 0) console.log('  （没有）')
console.log('')

console.log(`审计 ${audit.total} 条：`)
for (const [type, count] of Object.entries(audit.byType)) console.log(`  ${type} ${count}`)
if (audit.total === 0) console.log('  （没有）')
for (const row of audit.last) {
  const detail = row?.detail === undefined ? '' : JSON.stringify(row.detail)
  console.log(`  seq ${row?.seq ?? '?'} ${row?.type ?? '?'} ${detail.slice(0, 120)}`)
}
console.log('')

console.log('这份脚本只读，什么都没改。卸载保留数据目录；要连数据一起删，是另一件事，人工确认后再动。')
