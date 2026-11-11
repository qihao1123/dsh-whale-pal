/**
 * 注入安全的基础零件。
 *
 * 人格内容是「用户写的自由文本」+「模型间接影响的记忆文本」，两者都可能带
 * 指令样式、控制字符、超长片段、以及宿主模板变量语法（`{{名字}}`）。所有进入
 * 提示词或落盘的文本都必须先过这里的一层，顺序固定：
 *
 *   stripControl → clip → (需要进 XML 数据段时) xmlEscape
 *
 * 注意 `{{ }}`：宿主会把 `{{变量}}` 当模板变量，未注册的名字会让整段注入失败。
 * 我们自己注册 section 时会显式关掉插值（interpolate: false），但仍然拆开花括号，
 * 因为配置里的文本也可能出现在别的插值通道里。
 */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/** 统一换行、去掉除 \n \t 之外的控制字符。 */
export function stripControl(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
}

/** 按字符数截断（不切断代理对）。 */
export function clip(text, max) {
  const s = String(text ?? '')
  if (!Number.isFinite(max) || max <= 0) return ''
  if (s.length <= max) return s
  let out = s.slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

/** XML 文本节点转义：属性值不在这里处理，我们只产生文本节点。 */
export function xmlEscape(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 拆掉模板变量语法，避免宿主把人类写的 `{{名字}}` 当未注册变量。 */
export function defuseTemplate(text) {
  return String(text ?? '').replace(/\{\{/g, '{').replace(/\}\}/g, '}')
}

/**
 * 通用清洗：控制字符 → 模板语法 → 截断 → 去首尾空白 → 去掉尾巴上的分隔符。
 * 结果为空时返回 fallback（默认空串）。
 *
 * 尾巴上的 `，、；：。` 和空白一起清掉：这些字符放在句末没有任何含义，多半是
 * 手滑多打的（比如把分隔符打在了最后）。`！？…」` 这类有语气的不动。
 * 内部的标点一个不碰——「自然；有边界」这种写法是作者的意思，不是错误。
 */
const TAIL_PUNCT = /[，,、；;：:。.\s]+$/u

function trimTail(text) {
  return String(text ?? '').replace(TAIL_PUNCT, '')
}

export function clean(raw, max = 500, fallback = '') {
  const s = trimTail(clip(trimTail(defuseTemplate(stripControl(raw)).trim()), max))
  return s === '' ? fallback : s
}

/**
 * 把任意文本包成一个 XML 数据段，并显式标注「这是数据」。
 * 只用于非受信内容（配置里的自由文本、记忆摘要）。
 */
export function dataBlock(tag, text, options = {}) {
  const body = xmlEscape(stripControl(text))
  const note = options.note ? `\n<!-- ${xmlEscape(stripControl(options.note))} -->` : ''
  return `<${tag}>${note}\n${body}\n</${tag}>`
}

/** 单行化：把换行压成空格，用于「名称」这类只能一行的字段。 */
export function oneLine(text, max = 200) {
  return clean(String(text ?? '').replace(/\s+/g, ' '), max)
}

/**
 * 散文位置用的清洗：清掉控制字符后，把尖括号换成全角。
 *
 * 为什么不用实体转义：散文里出现 `&lt;` 会让人读着别扭，也容易被模型当成
 * 编码噪声忽略掉。全角 `＜＞` 既保留可读性，又不可能闭合同级或上级标签，
 * 是「这段文字只是文字」的最省事写法。
 */
export function plain(raw, max = 500) {
  return clean(raw, max).replace(/</g, '＜').replace(/>/g, '＞')
}
