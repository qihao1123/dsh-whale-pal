/**
 * 把当前生效的人格内核导出成一篇 Markdown，放进笔记库给人读。
 *
 * 为什么放在保存路径上：文档和真正注入的那段文字必须同源。上次它们分叉了
 * 一个多月，文档里还写着早就删掉的条目，而模型读的是另一份。所以这里导出的
 * 不是「配置字段的另一种排版」，而是 renderKernel 的原文——写进文档的那一刻，
 * 文档里那句话和模型看到的那句话是同一个字符串。
 *
 * 失败姿势：任何一步失败都只吞掉并记一行日志，绝不阻断保存。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renderKernel } from './render.js'

const DIR_NAME = '人格提示词'
const FILE_NAME = '人格提示词.md'
const TMP_NAME = '.人格提示词.md.tmp'

/**
 * 旧版留几份。用户 2026-11-20 定：留一到两份就行，新的把最旧的顶掉。
 * 所以这里不是「每次多一份」，而是固定两个槽位轮换，永远只有这两个文件名。
 */
const OLD_SLOTS = ['人格提示词-上一版.md', '人格提示词-上上版.md']

/** 文档放在笔记库的哪个位置；没配笔记库路径就返回空串（不猜）。 */
export function personaDocPath(config) {
  const vault = String(config?.knowledge?.vaultPath ?? '').trim()
  if (!vault) return ''
  return join(vault, DIR_NAME, FILE_NAME)
}

/** 时间按本地时区写，读的人不需要换算。 */
function stampLocal(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export function renderPersonaDoc(config, state, at = new Date()) {
  const kernel = renderKernel(config, state)
  const name = String(config?.bot_name ?? '').trim() || '（未命名）'
  const head = [
    `# 人格提示词 · ${name}`,
    '',
    '> 这篇是自动生成的，别手改：设置页一保存，插件就按内核重写它，手改会被覆盖。',
    '> 下面「人格内核」那段就是模型实际读到的那份文字，不是摘要也不是另写的版本。',
    `> 生成时间：${stampLocal(at)} · 内核 ${kernel.length} 字`,
    '',
    '---',
    '',
    // 内核自己第一行就是「# 人格内核」，这里不再套一层标题，免得出现两个。
    kernel,
    '',
  ].join('\n')
  return head
}

/**
 * 把当前这篇顶进旧版槽位：最旧的那份直接删，其余往后挪一格。
 *
 * 两个槽位而不是「每次加一份带时间戳的」：笔记库里一旦按时间戳堆起来，
 * 过几个月就是几十个同名不同时间戳的孤儿文件，谁也不敢删。
 */
function rotateOldVersions(file) {
  if (!existsSync(file)) return
  const dir = dirname(file)
  const oldest = join(dir, OLD_SLOTS[OLD_SLOTS.length - 1])
  try {
    if (existsSync(oldest)) unlinkSync(oldest)
  } catch {
    /* 删不掉就留着，后面覆盖写会把内容换掉，不影响这次同步 */
  }
  for (let i = OLD_SLOTS.length - 1; i > 0; i -= 1) {
    const from = join(dir, OLD_SLOTS[i - 1])
    const to = join(dir, OLD_SLOTS[i])
    if (!existsSync(from)) continue
    try {
      renameSync(from, to)
    } catch {
      /* 单个槽位挪不动就跳过，宁可少一份旧版 */
    }
  }
  try {
    copyFileSync(file, join(dir, OLD_SLOTS[0]))
  } catch {
    /* 顶不进旧版槽位也不挡新内容落盘 */
  }
}

/**
 * 写进笔记库。内容没变就不碰文件（避免每次启动都改一次 mtime，
 * 笔记库同步软件会因此白跑一趟）。
 */
export function exportPersonaDoc({ config, state, at = new Date(), log = () => {} } = {}) {
  const file = personaDocPath(config)
  if (!file) return { ok: false, reason: 'no-vault' }
  const vault = String(config?.knowledge?.vaultPath ?? '').trim()
  if (!existsSync(vault)) return { ok: false, reason: 'vault-missing', path: file }
  let text = ''
  try {
    text = renderPersonaDoc(config, state, at)
  } catch (error) {
    log(`[dsh-whale-pal] 人格提示词导出失败（渲染）：${error?.message ?? error}`)
    return { ok: false, reason: 'render-failed' }
  }
  try {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null
    if (before === text) return { ok: true, wrote: false, path: file }
    mkdirSync(join(vault, DIR_NAME), { recursive: true })
    // 先把现在这篇顶进旧版槽位，再写新的：这样断电也只丢一份旧版，不会丢当前这篇。
    rotateOldVersions(file)
    const tmp = join(vault, DIR_NAME, TMP_NAME)
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    return { ok: true, wrote: true, path: file }
  } catch (error) {
    log(`[dsh-whale-pal] 人格提示词导出失败（写盘）：${error?.message ?? error}`)
    return { ok: false, reason: 'write-failed', path: file }
  }
}
