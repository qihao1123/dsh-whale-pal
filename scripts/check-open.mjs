/**
 * 开源包发布检查：证明闭源那包没进开源包。
 *
 * 三处都要能证明，不能只打一个标记就发出去：
 *   1. 构建产物 / 要发出去的文件 —— 这里扫；
 *   2. 发布清单（package.json）—— 这里扫依赖与名字；
 *   3. 装完后的检查 —— 有个测试导入这个脚本跑同一份扫描（test/open-source.test.mjs）。
 *
 * 判据不写死闭源包名（写了就等于把名字刻进开源包）：只认三件事——
 *   - 要发出去的文件里不能出现外部场景的专有词；
 *   - 代码只许 import 相对路径、node 内置、宿主包、以及自己 dependencies 里写明的包；
 *   - package.json 的依赖清单里不许有「说不清是什么」的私有包。
 *
 * 用法：
 *   node scripts/check-open.mjs                 # 扫默认那几处
 *   CLOSED_PACKAGES=a,b node scripts/check-open.mjs   # 额外禁词（例如闭源包名）
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 默认要扫的路径：真要发出去的那些。 */
const DEFAULT_ENTRIES = ['lib', 'index.js', 'persona-card.js', 'cordis.patch.yml', 'README.md', 'package.json']

/** 开源包里不该出现的词（外部场景的专有词）。 */
const DEFAULT_FORBIDDEN = ['直播']

/** 允许 import 的第三方范围：宿主自己的包、宿主注入的 react、自己声明的依赖。 */
const ALLOWED_SCOPES = ['@deepseek-ai/', 'react', 'react-dom']

const CODE = /\.(?:js|mjs|cjs)$/u

/** 递归列出文件（跳过 node_modules 与隐藏备份目录）。 */
export function listFiles(root, entries = DEFAULT_ENTRIES) {
  const out = []
  const walk = (full) => {
    let info = null
    try {
      info = statSync(full)
    } catch {
      return
    }
    if (info.isDirectory()) {
      let names = []
      try {
        names = readdirSync(full)
      } catch {
        return
      }
      for (const name of names) {
        if (name === 'node_modules' || name.startsWith('.bak')) continue
        walk(join(full, name))
      }
      return
    }
    out.push(full)
  }
  for (const entry of entries) {
    const full = resolve(root, entry)
    if (existsSync(full)) walk(full)
  }
  return out
}

/** 从一份源码里取 import/require 的包名（相对路径与 node: 内置不算）。 */
function specifiersOf(text) {
  const out = []
  const patterns = [/from\s+['"]([^'"]+)['"]/gu, /require\(\s*['"]([^'"]+)['"]\s*\)/gu, /import\(\s*['"]([^'"]+)['"]\s*\)/gu]
  for (const pattern of patterns) {
    let match = null
    while ((match = pattern.exec(text)) !== null) out.push(match[1])
  }
  return out
}

/**
 * 扫一遍。
 * @returns {{ok: boolean, hits: Array<{file: string, line: number, why: string}>, files: number}}
 */
export function scanOpenPackage(options = {}) {
  const root = resolve(options.root ?? process.cwd())
  const entries = Array.isArray(options.entries) && options.entries.length > 0 ? options.entries : DEFAULT_ENTRIES
  const envWords = String(process.env.CLOSED_PACKAGES ?? '')
    .split(/[,，;；\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
  const forbidden = [...DEFAULT_FORBIDDEN, ...(Array.isArray(options.forbidden) ? options.forbidden : []), ...envWords]

  let pkg = {}
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    pkg = {}
  }
  const ownDeps = Object.keys({
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  })
  const allowed = [...ALLOWED_SCOPES, ...ownDeps]

  const files = listFiles(root, entries)
  const hits = []
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/')
    let text = ''
    try {
      if (statSync(file).size > 2 * 1024 * 1024) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/u)
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      for (const word of forbidden) {
        if (word !== '' && line.includes(word)) hits.push({ file: rel, line: i + 1, why: `出现了外部场景的词「${word}」` })
      }
    }
    if (!CODE.test(file)) continue
    for (const spec of specifiersOf(text)) {
      if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('#')) continue
      if (allowed.some((prefix) => spec === prefix || spec.startsWith(prefix))) continue
      hits.push({ file: rel, line: 0, why: `import 了一个不在依赖清单里的包：${spec}` })
    }
  }

  // 发布清单本身也要干净：依赖里不许有说不清的私有包。
  for (const dep of ownDeps) {
    if (forbidden.some((word) => word !== '' && dep.includes(word))) {
      hits.push({ file: 'package.json', line: 0, why: `依赖清单里出现了闭源包名：${dep}` })
    }
  }
  return { ok: hits.length === 0, hits, files: files.length }
}

function main() {
  const report = scanOpenPackage({ root: dirname(dirname(fileURLToPath(import.meta.url))) })
  if (report.ok) {
    console.log(`✓ 开源包干净：扫了 ${report.files} 个文件，没发现外部场景的东西`)
    return
  }
  for (const hit of report.hits) console.error(`✗ ${hit.file}${hit.line > 0 ? ':' + hit.line : ''} —— ${hit.why}`)
  process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
