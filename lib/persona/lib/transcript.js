/**
 * 对话转录：把宿主发来的会话事件压成「谁说了什么」。
 *
 * 只做一件事：从 `session/event` 里挑出人类和模型说过的自然语言，别的
 * （工具调用、推理片段、系统注入）一律丢掉。评估器只看这些，输入越小、
 * 越干净，判断越不容易跑偏。
 */

const MAX_TURNS = 24
const MAX_CHARS = 4000

/** 从内容块数组里取纯文本，忽略工具、图片、文件。 */
export function blocksToText(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 消息 → 文本；兼容 message.content 与裸 content。 */
export function messageToText(message) {
  if (!message || typeof message !== 'object') return ''
  if (typeof message.text === 'string') return message.text.trim()
  return blocksToText(message.content)
}

/** 一次回合里的转录缓冲。每个会话一份。 */
export function createTranscript() {
  return { entries: [], turn: 0, touched: 0, lastUserChars: 0 }
}

/**
 * 吃进一条会话事件，返回是否入账。
 * 只认 'user/message' 与 'assistant/message'，其余返回 false。
 */
export function ingestEvent(buffer, event) {
  if (!buffer || !event || typeof event !== 'object') return false

  if (event.type === 'turn/start' && event.data && typeof event.data.turn === 'number') {
    buffer.turn = event.data.turn
    return false
  }
  if (event.type === 'turn/end' && event.data && typeof event.data.turn === 'number') {
    buffer.turn = event.data.turn
    return false
  }

  let role = null
  let text = ''
  if (event.type === 'user/message') {
    const data = event.data ?? {}
    // 宿主把时间戳、运行环境、技能目录、审批通知这些都塞成 user/message，
    // 只有 source.kind === 'user' 才是人真的说的话。
    const kind = data?.source?.kind
    if (kind !== undefined && kind !== 'user') return false
    role = 'user'
    text = messageToText(data)
  } else if (event.type === 'assistant/message') {
    const data = event.data ?? {}
    if (data.interrupted) return false
    role = 'assistant'
    text = messageToText(data.message)
  }
  if (!role || !text) return false

  // seq 是原文的指针（ref 用它回档案取原话）：事件带就记，不带就 0。
  // 0 = 这条没有可追的来源，取回时如实说追不到，不拿相邻的条目顶。
  buffer.entries.push({ role, text, turn: buffer.turn, seq: Number(event.seq) || 0 })
  if (role === 'user') buffer.lastUserChars = text.length
  buffer.touched += 1
  if (buffer.entries.length > MAX_TURNS) buffer.entries.splice(0, buffer.entries.length - MAX_TURNS)
  return true
}

/** 渲染成评估器读的对话文本，从尾部开始留够字符就停。 */
export function renderTranscript(buffer, maxChars = MAX_CHARS) {
  if (!buffer || buffer.entries.length === 0) return ''
  const picked = []
  let size = 0
  for (let i = buffer.entries.length - 1; i >= 0; i -= 1) {
    const entry = buffer.entries[i]
    const line = `${entry.role === 'user' ? '用户' : '你'}：${entry.text}`
    size += line.length + 1
    if (size > maxChars && picked.length > 0) break
    picked.push(line)
  }
  return picked.reverse().join('\n')
}

/** 结构化描述「最近几条够不够评估」，给诊断用。 */
export function describeSubstance(buffer) {
  if (!buffer || buffer.entries.length === 0) {
    return { entries: 0, size: 0, hasUser: false, hasAssistant: false }
  }
  const tail = buffer.entries.slice(-4)
  return {
    entries: buffer.entries.length,
    size: tail.reduce((sum, entry) => sum + entry.text.length, 0),
    hasUser: tail.some((entry) => entry.role === 'user'),
    hasAssistant: tail.some((entry) => entry.role === 'assistant'),
  }
}

/** 这一轮有没有值得评估的实质内容：至少一问一答，且合起来不短。 */
export function hasSubstance(buffer) {
  if (!buffer || buffer.entries.length < 2) return false
  const info = describeSubstance(buffer)
  return info.hasUser && info.hasAssistant && info.size >= 80
}

/** 取走最后 N 条并清空缓冲（评估用），不清空则返回副本。 */
export function takePending(buffer, limit = 6) {
  if (!buffer) return []
  return buffer.entries.slice(-limit)
}
