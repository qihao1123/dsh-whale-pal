/**
 * dsh-whale-pal —— 插件入口。
 *
 * 这里只做三件事，人格内核的能力全在 `lib/persona/`：
 *   1. 算出数据根（`~/.dsh/whale-pal/<profile>`，旧根只读一次）；
 *   2. 旧状态一次性导入；
 *   3. 交接给人格内核，拿回进程内 api 备用。
 *
 * 不许双活：旧插件 `dsh-persona-framework` 还挂在 profile 里时直接不启动。
 * 它自己会注入那两段提示词，我再注入就是同一套人格说两遍；而两个写者
 * 各写各的 state.json，人格会当场分叉。等旧插件卸掉，这个条件自然消失。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runImport } from './lib/import/run.js'
import { loadReport } from './lib/load.js'
import { resolveDataPaths } from './lib/paths.js'
import { registerSurface } from './lib/host.js'
import { applyPersona, PLUGIN_NAME } from './lib/persona/index.js'

export const name = PLUGIN_NAME
// systemPrompt 缺了就没有人格可注入；webServer 管调试路由与设置页通道；
// commands 是 /whale，tools 是 whale_pal_identity；workspaceController 是工作区
// 清单与改名（模式按目录定之后要用）。未注入的服务在 Cordis 里是 Proxy 抛错而
// 不是 undefined，所以必须在这里声明全，不能靠守卫兜。
export const inject = ['systemPrompt', 'webServer', 'commands', 'tools', 'workspaceController']

const LEGACY_PLUGIN = 'dsh-persona-framework'

function log(message) {
  console.warn(`[dsh-whale-pal] ${message}`)
}

function legacyStillLoaded({ home, profile }) {
  const manifest = join(home, 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) return false
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    return false
  }
  const dependencies = parsed?.dependencies ?? {}
  const bundles = parsed?.dsh?.profile?.bundles ?? []
  return Object.hasOwn(dependencies, LEGACY_PLUGIN) || bundles.includes(LEGACY_PLUGIN)
}

/**
 * 只挂一条 `/health`：人格内核没起来时的最小出口。
 *
 * 这时候别的一概不挂——没有内核，设置页改了也没处写，多挂一个写入口
 * 就是多一个会骗人的口子。
 */
function registerHealthOnly(ctx, paths) {
  let webServer = null
  try {
    webServer = ctx?.webServer ?? null
  } catch {
    webServer = null
  }
  if (!webServer || typeof webServer.register !== 'function') return

  const handler = async (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    const report = loadReport({ paths, registered: null, log })
    res.statusCode = report.ok ? 200 : 503
    res.end(JSON.stringify(report))
  }

  try {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: '/api/whale-pal', handler }),
      'dsh-whale-pal: health only',
    )
  } catch {
    webServer.register({ kind: 'prefix', path: '/api/whale-pal', handler })
  }
}
export function apply(ctx, pluginConfig = {}) {
  const resolved = resolveDataPaths(pluginConfig)

  if (legacyStillLoaded(resolved.base)) {
    log('profile 里还挂着 dsh-persona-framework，本次不启动人格内核；卸掉旧插件再重启')
    return null
  }

  // 旧状态只在第一次导：先存导入前快照，再导，再逐项核对，再把旧文件置只读（P5，不变量 21）。
  // 台账那一行不在这一层写——那会儿库的 api 还没起来；报告传给 registerSurface，由它补。
  let importReport = null
  try {
    importReport = runImport({ resolved, at: new Date().toISOString(), log, record: null })
    const result = importReport
    if (result.imported === true) {
      const { counts } = result
      const snagged = (result.checked?.diff ?? []).length === 0 ? '逐项都对上' : `有差异（${result.checked.diff.join('、')}）`
      log(
        `已从旧目录导入状态：revision ${counts.revision}、短记忆 ${counts.facts + counts.preferences + counts.events + counts.openTopics} 条、长记忆 ${counts.longMemory} 条、traits ${counts.traits} 条；${snagged}`,
      )
      if (result.snapshot?.ok !== true) log(`导入前的快照没存下来（${result.snapshot?.reason ?? '未知'}）：回滚这条路这次不可用`)
      if (result.froze?.ok !== true) log('旧文件没能全锁成只读，不影响这次启动')
    }
  } catch (error) {
    log(`旧状态导入失败，这次从空状态起步：${error?.message ?? error}`)
  }

  const api = applyPersona(ctx, { paths: resolved.paths, log })
  if (!api) {
    // 内核没起来也留一个出口：不然设置页只会显示连不上，看不出为什么。
    try {
      registerHealthOnly(ctx, resolved.paths)
    } catch (error) {
      log(`最小健康出口没挂上：${error?.message ?? error}`)
    }
    return null
  }

  // 设置页、/whale 命令、whale_pal_identity 工具、模式那一段提示。
  // 挂失败只记日志：人格内核已经注入了，不该因为设置页挂了就整块不启动。
  try {
    registerSurface({
      ctx,
      api,
      paths: resolved.paths,
      // 回滚与体检要旧根与快照位置，一并给它；人格内核那边不用这两个。
      legacy: resolved.legacy,
      base: resolved.base,
      importRecord: resolved.importRecord,
      // 导入报告只为了在台账里留一条（判断/结果/教训留空，隔天补）。
      importReport,
      log,
    })
  } catch (error) {
    log(`设置页接线失败，人格内核照常工作：${error?.message ?? error}`)
  }

  return api
}
