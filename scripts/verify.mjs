/**
 * 交付前自检：语法 → 导入 → 测试。
 *
 * 不跑 npm test（它靠 shell 展开 glob，Windows 上不展开），
 * 这里自己列文件，逐个交给 node 检查、再一次性交给 --test。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const rel = (file) => relative(root, file).replaceAll('\\', '/')

function listFiles(dir, ext) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, ext))
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out
}

function check(file) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
}

const sources = [join(root, 'index.js'), ...listFiles(join(root, 'lib'), '.js')]
// 只收 `*.test.mjs`：`test/eval/run.mjs` 这种是命令行评估器，模块一加载就 main()，
// 当成测试文件跑等于把整套评估悄悄跑一遍（还会去读真库）。不是测试的，别往这里收。
const tests = [...listFiles(join(root, 'test'), '.test.mjs'), ...listFiles(join(root, 'lib/persona/test'), '.test.mjs')]

let failed = false

// 1) 语法
try {
  sources.forEach(check)
  console.log(`✓ 语法：${sources.length} 个文件`)
} catch (error) {
  failed = true
  console.error('✗ 语法检查失败：')
  console.error(error.stdout?.toString() || error.message)
}

// 2) 入口导出
if (!failed) {
  try {
    const entry = await import(pathToFileURL(join(root, 'index.js')).href)
    const kernel = await import(pathToFileURL(join(root, 'lib/persona/index.js')).href)
    const problems = []
    if (entry.name !== 'dsh-whale-pal') problems.push(`name 是 ${entry.name}`)
    if (!Array.isArray(entry.inject) || !entry.inject.includes('systemPrompt')) problems.push('inject 缺 systemPrompt')
    if (typeof entry.apply !== 'function') problems.push('没有导出 apply')
    if (typeof kernel.applyPersona !== 'function') problems.push('人格内核没有导出 applyPersona')
    if (problems.length > 0) throw new Error(problems.join('；'))
    console.log(`✓ 导入：name=${entry.name} inject=${entry.inject.join(',')}`)
  } catch (error) {
    failed = true
    console.error(`✗ 导入失败：${error.message}`)
  }
}

// 3) 测试
if (!failed) {
  try {
    const out = execFileSync(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'pipe' })
    const text = out.toString()
    // node 24 报 `ℹ tests 912`，node 22 报 `# tests 912`：两种前缀都认。
    const summary = text
      .split('\n')
      .filter((line) => /^(?:ℹ|#) (tests|pass|fail) /.test(line))
      .join(' ')
    console.log(`✓ 测试：${summary.trim()}（${tests.length} 个文件）`)
  } catch (error) {
    failed = true
    console.error('✗ 测试失败：')
    console.error((error.stdout?.toString() || '') + (error.stderr?.toString() || ''))
  }
}

if (failed) {
  console.error('\n✗ 语法 / 导入 / 测试 有未通过项')
  process.exit(1)
}
console.log(`\n✓ 语法 / 导入 / 测试 全通过（${root}）`)
