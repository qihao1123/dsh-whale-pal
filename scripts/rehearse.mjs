// 迁移演练：拿旧目录的一份拷贝在新代码上跑一遍，看计数对不对。
// 只读旧目录，所有写入都落在临时 DSH_HOME 里。
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureStateImported } from '../lib/migrate.js'
import { resolveDataPaths } from '../lib/paths.js'
import { applyPersona } from '../lib/persona/index.js'

const source = process.argv[2]
if (!source) {
  console.error('用法：node scripts/rehearse.mjs <旧 personas 根目录>')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'whale-pal-rehearsal-'))
try {
  cpSync(source, join(home, 'persona-framework', 'desktop'), { recursive: true })
  const resolved = resolveDataPaths({ dshHome: home, profile: 'desktop' })

  const result = ensureStateImported({ ...resolved, log: (m) => console.log(m) })
  console.log('导入结果：', JSON.stringify(result, null, 1))

  const sections = []
  const ctx = {
    llm: { stream: async () => ({}) },
    effect(fn) {
      fn()
    },
    on() {
      return () => {}
    },
    systemPrompt: { section: (spec) => (sections.push(spec), () => {}) },
    webServer: { register: () => () => {} },
  }
  const api = applyPersona(ctx, { paths: resolved.paths, log: (m) => console.log(m) })
  console.log('两段注入：', sections.map((s) => `${s.name}@${s.order}`).join(' + '))
  const kernel = sections[0].text()
  const summary = sections[1].text()
  console.log(`内核 ${kernel.length} 字，摘要 ${summary.length} 字`)
  console.log('摘要前 120 字：', summary.slice(0, 120).replaceAll('\n', ' / '))
  const view = api.buildView()
  console.log('视图 revision：', view.state.revision, '短记忆：', JSON.stringify({
    facts: view.state.memory.facts.length,
    preferences: view.state.memory.preferences.length,
    events: view.state.memory.events.length,
    openTopics: view.state.memory.openTopics.length,
  }), '长记忆：', view.state.longMemory.length, 'traits：', view.state.traits.length)
  console.log('import-record：', readFileSync(resolved.importRecord, 'utf8').slice(0, 400))
} finally {
  rmSync(home, { recursive: true, force: true })
}
