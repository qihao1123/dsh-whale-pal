/**
 * 数据目录：人格内核的存储根。
 *
 * 旧插件用的是 `~/.dsh/persona-framework/<profile>`，这里换成 `~/.dsh/whale-pal/<profile>`。
 * 不改 store.js 的默认根，是因为它的默认值被测试锚着（store.test.mjs 直接断言
 * `'C:\\h\\persona-framework\\desktop'`）；store 本来就留了 personaDir 覆盖口，走它就行。
 */
import { join } from 'node:path'

import { resolvePaths } from './persona/lib/state/store.js'

const DATA_DIR = 'whale-pal'
const LEGACY_PLUGIN_DIR = 'persona-framework'

/**
 * @param {{dshHome?: string, profile?: string, dataDir?: string, legacyDir?: string}} pluginConfig
 * @returns {{base: object, paths: object, legacy: object, importRecord: string}}
 */
export function resolveDataPaths(pluginConfig = {}) {
  const base = resolvePaths({ dshHome: pluginConfig.dshHome, profile: pluginConfig.profile })
  const root = pluginConfig.dataDir || join(base.home, DATA_DIR, base.profile)
  const legacyRoot = pluginConfig.legacyDir || join(base.home, LEGACY_PLUGIN_DIR, base.profile)
  const scoped = { dshHome: base.home, profile: base.profile }
  const paths = resolvePaths({ ...scoped, personaDir: root })
  return {
    base,
    // runState 是装载自检要用的退出标记，跟着数据目录走，不另开一格。
    paths: { ...paths, runState: join(root, 'run-state.json') },
    legacy: resolvePaths({ ...scoped, personaDir: legacyRoot }),
    importRecord: join(root, 'import-record.json'),
    // 处理流程的进度点：事务层自己的格子，不写进人格内核的 state.json。
    progress: join(root, 'progress.json'),
    // 派活的账本：哪个项目用哪条执行会话、还有哪些任务在排队。
    dispatch: join(root, 'dispatch.json'),
  }
}
