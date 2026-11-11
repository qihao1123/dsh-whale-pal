/**
 * 命令回执：成功不吭声，失败塞一行。
 *
 * 为什么只留失败（2026-11-11 用户定的口径，原话「只让失败说话」）：
 * 宿主的 composer 对不带附件的命令，成功时把文案丢掉、失败时也不回显，
 * 命令到底跑成没有只剩 `command/done` 那条日志。成功是常态，每条都吭声要花一份上下文；
 * 失败少见，而且多半得让人知道，所以只给失败留一句。
 *
 * 塞进去的是一会话消息（`agent.inject`），不是命令返回值：命令的 `{kind, text}` 原样返回，
 * 界面那层怎么处理都不受影响。塞不进去（会话没有 inject、或它抛错）只写日志，不动命令结果。
 */
import { messageFor } from './inbox.js'

const PREFIX = '[whale-pal] /whale'
const MAX = 300

/** 失败时该说的那一行；成功或没结果就回空串。 */
export function receiptLine(result, rawInput = '') {
  if (!result || result.kind !== 'error') return ''
  // 命令名压成单行、掐短：回执只用来认出是哪一条，不复制整段参数。
  const command = String(rawInput).replace(/\s+/gu, ' ').trim().slice(0, 40)
  const said = typeof result.text === 'string' ? result.text.replace(/\s+/gu, ' ').trim() : ''
  const head = command === '' ? `${PREFIX} 失败` : `${PREFIX} ${command} 失败`
  return said === '' ? head : `${head}：${said.slice(0, MAX)}`
}

/** 失败才塞一条，返回原 result（命令的成败不因回执而变）。 */
export function withFailureReceipt({ agent, result, rawInput = '', log = null } = {}) {
  const line = receiptLine(result, rawInput)
  if (line === '') return result
  if (typeof agent?.inject !== 'function') {
    if (typeof log === 'function') log(`[dsh-whale-pal] 失败回执没塞进去（会话没有 inject）：${line}`)
    return result
  }
  try {
    agent.inject(messageFor(line))
  } catch (error) {
    if (typeof log === 'function') log(`[dsh-whale-pal] 失败回执没塞进去：${String(error?.message ?? error)}`)
  }
  return result
}
