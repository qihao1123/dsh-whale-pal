/**
 * 人格卡：把一整段粘贴进来的人格设定，按标签拆成十项。
 *
 * 为什么要有这一层：人的卡多是 `名称：六一` / `## 价值观` 这种带标签的散文，
 * 而内核要的是十个各自独立的字段。手抄一遍是纯体力活，还容易抄漏。
 *
 * 边界先说清楚：
 *   - 这里只做「按标签分流」，不做语义理解。认不出的行原样落在 rest 里，
 *     绝不丢字——丢字比拆错严重得多。
 *   - 一个标签的正文一直延续到下一个标签出现为止。所以卡片里没写标签的小节，
 *     会跟在上一个标签下面；这是规则解析的必然局限，界面上给了「让模型帮我拆」
 *     作兜底，以及逐项手改。
 *   - 不设「必须认出多少项」的门槛：一项都没认出来时 rest 就是全文，
 *     调用方据此提示人。
 */

/** 十项：前六项是身份，后四项是内核第 1、2 节读的底色与规则。 */
export const CARD_KEYS = Object.freeze([
  'name',
  'nameMeaning',
  'selfName',
  'selfNameMeaning',
  'title',
  'titleMeaning',
  'temperament',
  'values',
  'boundaries',
  'language',
])

/**
 * 标签别名表。
 *
 * 只收「人真的会写在冒号左边」的词。收窄一点，宁可认不出落到 rest 让人手改，
 * 也不要认错——把「原则」错当成「名称」会安静地毁掉一整段。
 */
const ALIASES = new Map([
  // 名称
  ['名称', 'name'],
  ['名字', 'name'],
  ['角色名', 'name'],
  ['你的名字', 'name'],
  ['ai名字', 'name'],
  ['我的名字', 'name'],
  ['叫法', 'name'],
  // 名称的含义
  ['名称含义', 'nameMeaning'],
  ['名称的含义', 'nameMeaning'],
  ['名字含义', 'nameMeaning'],
  ['名字的含义', 'nameMeaning'],
  ['名字的意思', 'nameMeaning'],
  ['名称的意思', 'nameMeaning'],
  ['含义', 'nameMeaning'],
  // 自称
  ['自称', 'selfName'],
  ['第一人称', 'selfName'],
  ['如何自称', 'selfName'],
  // 自称的含义
  ['自称含义', 'selfNameMeaning'],
  ['自称的含义', 'selfNameMeaning'],
  // 称呼
  ['称呼', 'title'],
  ['对我的称呼', 'title'],
  ['怎么称呼我', 'title'],
  ['称呼我', 'title'],
  ['你的称呼', 'title'],
  // 称呼的含义
  ['称呼含义', 'titleMeaning'],
  ['称呼的含义', 'titleMeaning'],
  // 底色
  ['底色', 'temperament'],
  ['性格', 'temperament'],
  ['性格底色', 'temperament'],
  ['性格特点', 'temperament'],
  ['气质', 'temperament'],
  ['人设', 'temperament'],
  ['角色性格', 'temperament'],
  ['角色设定', 'temperament'],
  // 价值观
  ['价值观', 'values'],
  ['价值取向', 'values'],
  ['信念', 'values'],
  ['立场', 'values'],
  ['原则', 'values'],
  ['信条', 'values'],
  // 边界
  ['边界', 'boundaries'],
  ['底线', 'boundaries'],
  ['红线', 'boundaries'],
  ['雷区', 'boundaries'],
  ['禁止', 'boundaries'],
  ['禁止事项', 'boundaries'],
  ['禁止行为', 'boundaries'],
  ['不可以', 'boundaries'],
  ['规则', 'boundaries'],
  ['约束', 'boundaries'],
  // 说话风格
  ['说话', 'language'],
  ['说话风格', 'language'],
  ['说话方式', 'language'],
  ['语言风格', 'language'],
  ['语言', 'language'],
  ['语气', 'language'],
  ['口吻', 'language'],
  ['风格', 'language'],
])

/** 半角/全角冒号都认；左边最长 16 字，再长就不是标签了。 */
const LABEL_LINE = /^([^：:\n]{1,16})[：:]\s*(.*)$/

/** Markdown 标题行：`## 价值观`。井号后面的整段当标签。 */
const HEADING_LINE = /^#{1,6}\s*(.+?)\s*$/

/** 列表/引用符号与数字编号：只剥前缀，不动正文。 */
const BULLET_PREFIX = /^\s*(?:[-*+•]\s+|\d+[.、)）]\s*|>\s*)+/

/** 括号里的补充说明不算标签名：`名称（你叫什么）：六一`。 */
const PAREN_TAIL = /[（(【\[].*?[）)】\]]/g

function tidyLabel(text) {
  return String(text ?? '')
    .replace(PAREN_TAIL, '')
    .replace(/\s+/g, '')
    .replace(/[*_`]/g, '')
    .toLowerCase()
}

/** 去掉列表符号与行尾空白，正文不动。 */
function tidyBody(line) {
  return String(line ?? '').replace(BULLET_PREFIX, '').trimEnd()
}

/**
 * 认一行是不是标签行。
 *
 * 三种结果，别混：
 *   {key, value}  —— 认得出的标签，从这里开始新的一段；
 *   {unknown}     —— 长得像标签（左边一小段 + 冒号）但别名表里没有。
 *                    这时要**结束**上一段并把它放进 rest，不能让它被上一段吞掉：
 *                    吞掉之后人既看不见它，也不知道自己那行没生效；
 *   null          —— 普通正文，跟着当前段走。
 *
 * @returns {{key: string, value: string}|{unknown: string}|null}
 */
function readLabel(line) {
  const heading = HEADING_LINE.exec(line)
  if (heading) {
    const key = ALIASES.get(tidyLabel(heading[1]))
    if (key) return { key, value: '' }
    return { unknown: heading[1] }
  }

  const labelled = LABEL_LINE.exec(tidyBody(line))
  if (!labelled) return null
  const name = labelled[1].trim()
  const key = ALIASES.get(tidyLabel(name))
  if (!key) return { unknown: name }
  return { key, value: String(labelled[2] ?? '').trim() }
}

/**
 * 块内合并：一行一条，空行不要。
 *
 * 不保留空行的原因：这些行最后会以 `\n` 连成一段注入内核，空行在那里
 * 只占字数不产生层次；真正的层次靠「一行一条」本身。
 */
function joinBlock(lines) {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * 把一整段原文拆成十项。
 *
 * @param {unknown} raw 粘贴进来的原文
 * @returns {{fields: Record<string, string>, rest: string, hits: string[], chars: number, total: number}}
 *   fields —— 十项各自的值，认不出就是空串；
 *   rest   —— 一处标签都没落在前面的行，原样保留；
 *   hits   —— 认出来的项（顺序跟 CARD_KEYS 走）；
 *   chars  —— 原文长度；
 *   total  —— 十项合计字数，给界面标「这些会进内核」。
 */
export function parsePersonaCard(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n')
  const buckets = new Map(CARD_KEYS.map((key) => [key, []]))
  const rest = []
  let current = null

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    if (trimmed === '') {
      if (current) buckets.get(current).push('')
      else if (rest.length > 0) rest.push('')
      continue
    }

    const hit = readLabel(line)
    if (hit !== null && hit.key !== undefined) {
      current = hit.key
      if (hit.value !== '') buckets.get(current).push(hit.value)
      continue
    }

    if (hit !== null && hit.unknown !== undefined) {
      // 认不出的标签：收掉上一段，这一行原样进 rest，别让人以为自己写的那行生效了。
      current = null
      rest.push(tidyBody(line))
      continue
    }

    if (current) buckets.get(current).push(tidyBody(line))
    else rest.push(tidyBody(line))
  }

  const fields = {}
  const hits = []
  let total = 0
  for (const key of CARD_KEYS) {
    const value = joinBlock(buckets.get(key))
    fields[key] = value
    if (value !== '') {
      hits.push(key)
      total += value.length
    }
  }

  return { fields, rest: joinBlock(rest), hits, chars: text.length, total }
}

/**
 * 模型拆解时的系统提示。
 *
 * 与规则解析的分工：规则解析免费、即时、可预测，是主路；这一段是兜底，
 * 只有人主动点按钮才会跑，所以可以写得啰嗦一点。
 */
export const SPLITTER_SYSTEM = [
  '你是「人格卡拆分员」。收到一段人格设定原文，把它拆成十个字段。',
  '',
  '规则：',
  '1. 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块、不要前后缀。',
  '2. 只用原文里真的写了的字。可以删掉重复、合并同义、理顺断行，但不要自己补人格设定、不要润色、不要加评价。',
  '3. 原文没写到的字段整个省略，不要给空字符串占位。',
  '4. 十项各管什么：',
  '   name         名称（这个 AI 叫什么，通常很短）',
  '   nameMeaning  名称的含义（为什么叫这个名字）',
  '   selfName     自称（它提到自己时用的称呼）',
  '   selfNameMeaning 自称的含义',
  '   title        称呼（它对用户的叫法）',
  '   titleMeaning 称呼的含义',
  '   temperament  底色（性格、气质，几句话）',
  '   values       价值观（立场、信念、看重什么）',
  '   boundaries   边界（不能做的事、红线，可以多条）',
  '   language     说话风格（语气、用词偏好）',
  '5. 位置不对的插图式设定（外貌、爱好、背景故事）原文里没有对应项，就整个省略；它们会留在原文存档里，不要硬塞进某一项。',
  '6. 单项超过 1000 字时压到 1000 字以内，保留意思。',
  '',
  '输出结构（字段都可省略）：',
  '{"fields":{"name":"…","temperament":"…","values":"…","boundaries":"…","language":"…"}}',
].join('\n')

/**
 * 模型输出收拾成可信结构：只认十个键、只收字符串、去掉空值。
 * 模型输出永远当不可信输入处理。
 */
export function validateSplit(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw.fields && typeof raw.fields === 'object' && !Array.isArray(raw.fields)
    ? raw.fields
    : raw
  const fields = {}
  let total = 0
  for (const key of CARD_KEYS) {
    const value = source[key]
    if (typeof value !== 'string') continue
    const text = value.replace(/\r\n?/g, '\n').trim()
    if (text === '') continue
    fields[key] = text
    total += text.length
  }
  if (Object.keys(fields).length === 0) return null
  return { fields, hits: CARD_KEYS.filter((key) => fields[key] !== undefined), total }
}
