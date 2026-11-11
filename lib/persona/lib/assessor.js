/**
 * 评估器：一条独立的小调用，读完这轮对话后只回一个 JSON。
 *
 * 为什么不让主对话模型直写状态：主模型正在「演」，让它同时当裁判会为了
 * 自洽而修饰判断，而且它的输出是用来给人看的，不该承载元数据。这里用一次
 * 短促的旁路调用，输出结构固定、体积小、失败也不影响对话。
 *
 * v6（2026-11-10）：只产「记忆 + 承诺」。traits / mood / relationship /
 * 称呼意愿 / 价值观权重都不再由评估器产出——那套状态机已经拆掉。
 */

import { clean, clip, plain } from './sanitize.js'

export const ASSESSOR_SYSTEM = [
  '你是某个 AI 的「记录员」，不是它的替身。读一段对话，只挑出以后值得想起的事实。',
  '',
  '规则：',
  '1. 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块、不要前后缀。整个 JSON 控制在 300 字以内。',
  '2. 没证据就不要写。宁可 salience 低，也不要为了填满字段而编。',
  '3. salience 表示「这段往来值不值得记」，0 表示完全日常寒暄，1 表示确实有分量。',
  '4. 记忆只记对以后有用的事实与偏好，不记寒暄、不记对话原文。',
  '5. 只写这一段对话里真的出现过的字段，其余字段整个省略。每类 memory 最多 2 条，每条不超过 40 字。',
  '6. commitments 只记「你自己答应过的事」：你说过会做、会补、会去看。不记对方的要求，不记「我会努力」这种空话。写成一句能做能验的动作，20 字以内。之后这段对话里你真的做到了之前答应的事，就把那件事的原话放进 commitmentsDone。',
  '7. openTopics 记「这段对话里没做完、以后该接着做」的事；之前列过的某件事这段对话里做完了，把它放进 resolvedTopics。别把「以后再说」的客套当未完成。',
  '8. 不要评价自己，不要扮演角色，不要在 JSON 之外输出任何字。',
  '',
  '输出结构（字段都可省略）：',
  '{"salience":0.0,',
  '"memory":{"facts":["…"],"preferences":["…"],"events":["…"],"openTopics":["…"]},',
  '"commitments":["…"],"commitmentsDone":["…"],"resolvedTopics":["…"]}',
].join('\n')

const MAX_ITEMS = 5
const MAX_TEXT = 120

function clampUnit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(1, number))
}

function textList(value, max = MAX_ITEMS) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = typeof item === 'string' ? clean(item, MAX_TEXT) : ''
    if (!text || out.includes(text)) continue
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

/**
 * 把模型给的 JSON 收拾成可信结构：非法值丢掉、数字钳制、长度截断。
 * 这一步才是真正的边界——模型输出永远当作不可信输入。
 */
export function validateAssessment(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const result = { salience: clampUnit(raw.salience) }

  if (raw.memory && typeof raw.memory === 'object') {
    const memory = {}
    for (const key of ['facts', 'preferences', 'events', 'openTopics']) {
      const list = textList(raw.memory[key])
      if (list.length > 0) memory[key] = list
    }
    if (Object.keys(memory).length > 0) result.memory = memory
  }

  for (const key of ['commitments', 'commitmentsDone', 'resolvedTopics']) {
    const list = textList(raw[key], 2)
    if (list.length > 0) result[key] = list
  }

  return result
}

/** 从可能带噪声的输出里抠出第一个完整的 JSON 对象。 */
export function extractJson(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

/** 解析 + 校验。任何一步失败都返回 null，调用方当作「这轮不更新」。 */
export function parseAssessment(text) {
  const json = extractJson(text)
  if (!json) return null
  let raw
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  return validateAssessment(raw)
}

/**
 * 组装评估请求：对话是数据，规则在 system。
 */
export function buildAssessmentRequest(transcriptText) {
  const body = clip(transcriptText, 4000)
  return {
    system: ASSESSOR_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: ['<transcript>', body, '</transcript>', '', '按结构输出 JSON。'].join('\n') }],
      },
    ],
  }
}

/**
 * 跑一次评估。超时、报错、空输出都返回 {ok:false}，绝不抛出——
 * 这条链路挂在回合末尾，抛错会污染正常对话。
 */
export async function runAssessment({ llm, provider, model, transcript, timeoutMs = 20000, signal }) {
  if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'llm-unavailable' }
  if (!provider || !model) return { ok: false, error: 'model-unavailable' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })

  let text = ''
  let reasoningChars = 0
  let finishKind = null
  try {
    const request = buildAssessmentRequest(transcript)
    const stream = llm.stream({
      provider,
      model,
      system: request.system,
      messages: request.messages,
      temperature: 0,
      maxTokens: 600,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length
      if (chunk.type === 'finish' && chunk.reason) {
        finishKind = chunk.reason.kind ?? null
        if (finishKind === 'error') return { ok: false, error: 'stream-error' }
      }
    }
  } catch (error) {
    return { ok: false, error: error && error.message ? String(error.message) : 'stream-failed' }
  } finally {
    clearTimeout(timer)
  }

  const assessment = parseAssessment(text)
  if (!assessment) {
    const error = finishKind === 'max-tokens' ? 'truncated' : 'unparseable'
    return { ok: false, error, finish: finishKind, chars: text.length, reasoningChars, raw: clip(text, 400) }
  }
  return { ok: true, assessment, finish: finishKind, chars: text.length, reasoningChars, raw: clip(text, 400) }
}

export { plain }
