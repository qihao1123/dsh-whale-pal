/**
 * 人格卡：把一整段粘贴进来的人格设定，按标签拆成十一项。
 *
 * 为什么要有这一层：人的卡多是 `名称：六一` / `## 价值观` / `【性格底色】` 这种带标签的散文，
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

/** 十一项：前六项是身份，中间四项是内核第 1、2 节读的底色与规则，最后一项是收束句。 */
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
  'summary',
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
  // 喜欢什么、讨厌什么并进底色：内核第 1 节只有「底色」一格自由文本，
  // 没有单独的「兴趣」槽。2026-11-13 人定的：不为它单开一槽——开槽要动内核结构，
  // 收益只是标签干净；并进底色后跟性格接在同一段里，仍然是在说「这是个什么人」。
  ['内容偏好', 'temperament'],
  ['兴趣偏好', 'temperament'],
  ['兴趣爱好', 'temperament'],
  ['兴趣', 'temperament'],
  // 价值观
  ['价值观', 'values'],
  ['价值取向', 'values'],
  ['信念', 'values'],
  ['立场', 'values'],
  ['原则', 'values'],
  ['信条', 'values'],
  // 边界
  ['边界', 'boundaries'],
  ['表达边界', 'boundaries'],
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
  // 总结：卡片末尾「你是什么、为什么存在」的收束句。
  // 2026-11-14 人定的：它原先无处可去（落在 rest 里永远不进内核），单开一项。
  ['总结', 'summary'],
  ['总纲', 'summary'],
  ['一句话总结', 'summary'],
])

/** 半角/全角冒号都认；左边最长 16 字，再长就不是标签了。 */
const LABEL_LINE = /^([^：:\n]{1,16})[：:]\s*(.*)$/

/** Markdown 标题行：`## 价值观`。井号后面的整段当标签。 */
const HEADING_LINE = /^#{1,6}\s*(.+?)\s*$/

/**
 * 整行方括号：`【性格底色】`，后面可以跟正文。
 *
 * 这是中文人格卡最常见的写法，比 `##` 还常见。以前只认井号和冒号，
 * 一份全用【】的卡会被判成「一行都没认出标签」——不是内容不认识，是标题形态不认识。
 */
const BRACKET_LINE = /^【([^】\n]{1,16})】\s*(.*)$/

/**
 * 中文序号标题：`一、性格底色` / `（一）性格底色`。
 *
 * 只认中文数码，不认 `1.`：后者在正文里就是普通编号列表，当标题会切碎段落
 * （`BULLET_PREFIX` 本来就把 `1.` 当列表符号剥掉）。
 */
const ORDINAL_LINE = /^(?:[（(][一二三四五六七八九十]{1,3}[）)]|[一二三四五六七八九十]{1,3}[、.．])\s*(.*)$/

/**
 * 单独成行的加粗：`**性格底色**`。
 *
 * 和上面几种不同，加粗本身也可能只是句中的强调，所以**只有认得出的名字才算标题**；
 * 认不出的按正文处理，不结束上一段。判错的代价不对称：把强调当标题会切碎一段，
 * 把标题当正文只是这一行没归类。
 */
const BOLD_LINE = /^\*\*([^*\n]{1,16})\*\*\s*$/

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
 * 五种形态按「像标题的确定程度」依次判定，前四种是标题标记，最后一种是冒号标签。
 * 认得出的返回 {key, value}；长得像标题但别名表里没有的返回 {unknown}；其余是正文。
 *
 * 为什么 unknown 要单独区分：它必须**结束**上一段并原样放进 rest。被上一段吞掉之后，
 * 人既看不见它，也不知道自己写的那一节没生效——安静地错配比明着认不出严重得多。
 *
 * @returns {{key: string, value: string}|{unknown: string, raw: string}|null}
 *   unknown 带 raw：认不出的那一行原样留着，给它开一段段落用。
 */
function readLabel(line) {
  // 先去列表/引用符号，再判形态：`> ## 价值观` 和 `- 【底色】` 都该认出来。
  const body = tidyBody(line)

  const heading = HEADING_LINE.exec(body)
  if (heading) {
    const key = ALIASES.get(tidyLabel(heading[1]))
    if (key) return { key, value: '' }
    return { unknown: heading[1], raw: body }
  }

  const bracket = BRACKET_LINE.exec(body)
  if (bracket) {
    const key = ALIASES.get(tidyLabel(bracket[1]))
    if (key) return { key, value: String(bracket[2] ?? '').trim() }
    return { unknown: bracket[1], raw: body }
  }

  const ordinal = ORDINAL_LINE.exec(body)
  if (ordinal) {
    // 序号后面才是标签本身：`一、性格底色`、`（一）性格底色`，也可能紧跟冒号。
    const rest = String(ordinal[1] ?? '').trim()
    const inner = LABEL_LINE.exec(rest)
    if (inner) {
      const name = inner[1].trim()
      const key = ALIASES.get(tidyLabel(name))
      if (key) return { key, value: String(inner[2] ?? '').trim() }
      return { unknown: name, raw: body }
    }
    const key = ALIASES.get(tidyLabel(rest))
    if (key) return { key, value: '' }
    return { unknown: rest, raw: body }
  }

  const bold = BOLD_LINE.exec(body)
  if (bold) {
    const key = ALIASES.get(tidyLabel(bold[1]))
    // 认不出的加粗按正文走：它可能只是强调，不是标题。
    if (key) return { key, value: '' }
    return null
  }

  const labelled = LABEL_LINE.exec(body)
  if (!labelled) return null
  const name = labelled[1].trim()
  const key = ALIASES.get(tidyLabel(name))
  // 冒号是最弱的标题形态：`普通网友：保持边界…` 这种定义行在中文里到处都是。
  // 所以认不出时标成 weak，由调用方决定——已经在一段里就当正文，顶层才另起一段。
  if (!key) return { unknown: name, raw: body, weak: true }
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
 * 把一整段原文拆成十一项 + 若干「没进十一项的段落」。
 *
 * 段落不是垃圾桶。以前没归到十一项的行全塞进一个 rest 字符串，界面上只敢写
 * 「这些行没归到任何一项」——读的人看不出那是一节完整的「内容偏好」还是一行杂字。
 * 现在按标题切成 {title, text}，原文怎么写、就怎么存，只是不进内核。
 *
 * @param {unknown} raw 粘贴进来的原文
 * @returns {{fields: Record<string, string>, rest: string, sections: Array<{title: string, heading: string, text: string, chars: number}>, hits: string[], chars: number, total: number}}
 *   fields   —— 十一项各自的值，认不出就是空串；
 *   sections —— 没归到十一项的部分，按标题切开；title 是认不出的那个标签名，
 *               标题行本身原样留在 heading，开头没标题的那段 title/heading 都是空串；
 *   rest     —— sections 拼回去的原文（兼容旧界面与旧调用方，与 sections 同一份来源）；
 *   hits     —— 认出来的项（顺序跟 CARD_KEYS 走）；
 *   chars    —— 原文长度；
 *   total    —— 十一项合计字数，给界面标「这些会进内核」。
 */
export function parsePersonaCard(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n')
  const buckets = new Map(CARD_KEYS.map((key) => [key, []]))
  const sections = []
  let current = null
  let section = null

  const openSection = (title, heading) => {
    const opened = { title: String(title ?? '').trim(), heading: String(heading ?? '').trim(), lines: [] }
    sections.push(opened)
    return opened
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    if (trimmed === '') {
      if (current) buckets.get(current).push('')
      else if (section) section.lines.push('')
      continue
    }

    const hit = readLabel(line)
    if (hit !== null && hit.key !== undefined) {
      current = hit.key
      section = null
      if (hit.value !== '') buckets.get(current).push(hit.value)
      continue
    }

    if (hit !== null && hit.unknown !== undefined) {
      current = null
      // 弱标题（认不出的冒号行）在已经开了一段的时候折进那一段当正文：
      // `和不同的人相处` 底下的「普通网友：……」「熟人：……」是内容，不是六个标题。
      // 在一段都没开的顶层，它仍然另起一段——那时候它多半真是「外貌：短发」这种没处放的小节。
      if (hit.weak === true && section) {
        section.lines.push(hit.raw)
        continue
      }
      // 强标题（##【】中文序号）：收掉上一项，另开一段，不许被上一项吞掉。
      section = openSection(hit.unknown, hit.raw)
      continue
    }

    if (current) buckets.get(current).push(tidyBody(line))
    else {
      if (!section) section = openSection('', '')
      section.lines.push(tidyBody(line))
    }
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

  // 段落收口：去掉空壳（没标题也没正文的那段不产生一行），顺便量出字数。
  const outSections = sections
    .map((item) => {
      const body = joinBlock(item.lines)
      return { title: item.title, heading: item.heading, text: body, chars: body.length }
    })
    .filter((item) => item.heading !== '' || item.text !== '')

  // rest 从 sections 拼回来，不另存一份：两份来源就会漂移，界面上说「原样留着」就假了。
  const rest = outSections
    .map((item) => [item.heading, item.text].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n')

  return { fields, rest, sections: outSections, hits, chars: text.length, total }
}

/**
 * 十一项各写多少字的目标。
 *
 * 这不是硬上限（硬上限在 settings.js 的 CARD_MAX，是挡住整本书的保险丝）。
 * 这里给的是「内核带得舒服」的量级：内核的 human 段每轮都要注入，
 * 软上限在 render.js 的 KERNEL_LIMITS.human（1000 字）。
 *
 * 2026-11-13 实测：模型把「记忆与成长」「和不同的人相处」都并进十一项之后，
 * 1b 从 973 涨到 1160，超了软上限 160 字。所以进内核那五项合计收到 1020：
 * 超了先压重复和废话，不为凑数字删具体设定——目标宽一点没关系，冗余不能留。
 *
 * 前六项身份里只有 name 进内核；后面 temperament / values / boundaries / language / summary
 * 五项是内核第 1、2 节读的自由文本，其余含义与自称称呼只存档，所以目标给得短。
 */
export const CARD_TARGETS = Object.freeze({
  name: 20,
  nameMeaning: 80,
  selfName: 20,
  selfNameMeaning: 80,
  title: 20,
  titleMeaning: 80,
  temperament: 300,
  values: 180,
  boundaries: 220,
  language: 300,
  summary: 120,
})

/** 中文里最常见的叫法，模型偶尔不照字段名回，认一下，别把整条拆解作废。 */
const FIELD_NAMES = new Map([
  ['名称', 'name'],
  ['名字', 'name'],
  ['名称含义', 'nameMeaning'],
  ['自称', 'selfName'],
  ['自称含义', 'selfNameMeaning'],
  ['称呼', 'title'],
  ['称呼含义', 'titleMeaning'],
  ['底色', 'temperament'],
  ['性格', 'temperament'],
  ['价值观', 'values'],
  ['边界', 'boundaries'],
  ['说话', 'language'],
  ['说话方式', 'language'],
  ['总结', 'summary'],
  ['总纲', 'summary'],
])

/**
 * 模型拆解时的系统提示。
 *
 * 与规则解析的分工：规则解析免费、即时、可预测，只负责切段和认标签；
 * 这一段才是「语义」那一步——它要判断哪一段在说哪一项，并把落空的段落
 * 压进对应项。只有人主动点按钮才会跑，所以可以写得啰嗦一点。
 *
 * 三条硬约束（2026-11-13 人定的）：
 *   - 只许搬和压，不许新增设定、不许改语气倾向——模型改写的每个字都会被
 *     注入每一轮对话，它顺手补一句「更符合人设」的话，就是一次人格漂移；
 *   - 塞不下的不许丢，列进 unused 说明原因；原文由界面另行保留；
 *   - 每项有字数目标，但不许为了凑目标删具体设定。
 *
 * 「压」不是一视同仁的（2026-11-13 晚，照着教程总结加的）：讲动机和
 * 「因为……所以……」的句子最后压，形容词和重复先压。不然 300 字一砍，
 * 先没的就是性格的依据，剩下全是标签。
 */
export const SPLITTER_SYSTEM = [
  '你是「人格卡拆分员」。收到一段人格设定原文，把它拆成十一个字段，并尽量把原文里真正属于设定的内容搬进这十一项。',
  '',
  '规则：',
  '1. 只输出一个 JSON 对象，不要解释、不要 Markdown 代码块、不要前后缀。',
  '2. 只用原文里出现过的意思。可以删重复、合并同义、理顺断行、把长句压短；',
  '   但不许新增原文没有的设定，不许改动立场和语气倾向，不许润色成你觉得更好的人设。',
  '   内核里已经写死的规则只剩这几条，原文再写一遍才算重复，删掉那句原话、在 unused 里记「与规则重复」：',
  '   平台安全高于人格设定、不主动攻击或贬低任何人、不假装有能力权限或记忆、拒绝不必先道歉、称呼不自己发明。',
  '   只删和这些逐条重合的那句；更具体的说法（口头禅、某个梗、机器腔的例子、',
  '   对什么人怎么说话）是卡片自己的内容，要留下。',
  '   表达上的约定——要不要固定开场白、要不要列点总结、要不要追着推进话题——',
  '   内核一个字都不管，全部属于卡片，一句都不许删。',
  '3. 原文没写到的字段整个省略，不要给空字符串占位。',
  '4. 十一项各管什么：',
  '   name         名称（这个 AI 叫什么，通常很短）',
  '   nameMeaning  名称的含义（为什么叫这个名字）',
  '   selfName     自称（它提到自己时用的称呼）',
  '   selfNameMeaning 自称的含义',
  '   title        称呼（它对用户的叫法）',
  '   titleMeaning 称呼的含义',
  '   temperament  底色（性格、气质，还有喜欢什么、讨厌什么）',
  '   values       价值观（立场、信念、看重什么）',
  '   boundaries   边界（不能做的事、红线、可以多条）',
  '   language     说话风格（语气、用词偏好、对不同的人怎么说话）',
  '   summary      总结（卡片末尾那句收束：它是什么、为什么存在）',
  '5. 归类按「这段在说这个人的什么」判，不按标题像什么判：',
  '   - 原文里的表达边界、底线、红线、禁止事项都归 boundaries。哪怕读起来像平台通用的',
  '     安全条款，那也是这个人不做的事，照原文压进边界，不许跳过这一项。',
  '   - 讲「记忆怎么存」的句子（必须真实发生过、要记具体细节、不要空泛标签）不归 values：',
  '     那是记忆系统在执行的活，整段列进 unused，原因写「记忆系统负责」。',
  '   - 讲「怎么面对旧判断」的句子（遇到冲突会犹豫、改口、不为了人设否认过去、',
  '     不每天重置自己）归 values；「同一句话不反复说」归 language；',
  '     「底色稳定、兴趣可以变」归 temperament。',
  '6. 原文里有几段没有对应项（外貌、背景故事、自检清单这类），不要硬塞进某一项；',
  '   实在搬不进去的，列进 unused，一句话说为什么。省略不会丢字——原文由界面留着。',
  '7. 字数目标（尽量凑近，但目标不是硬顶）：名称 20、底色 300、价值观 180、边界 220、说话 300；',
  '   含义/自称/称呼各 80。内核每轮都要带这些字，所以能压就压；',
  '   但删掉一条具体设定比超字数更糟——放不下时压重复和废话，不要删设定。',
  '   压的时候按这个顺序下手：先压重复、空泛的标签堆、客套话；再压没有下文的形容词。',
  '   原文里讲动机、讲「因为……所以……」、讲怕什么、讲某种性格由什么来的句子，最后才动，',
  '   哪怕它让这一项超字。这类句子是形容词的依据，压掉就只剩一串标签。',
  '   底色这一项先放这些依据，形容词排在后面；依据只能从原文搬，不许自己补一个「怕」。',
  '8. moves 只说一段去了哪一项，不要复述正文；原文本来就在哪一项里的，不用写进 moves。',
  '',
  '输出结构（字段、moves、unused 都可省略）：',
  '{"fields":{"name":"…","temperament":"…","values":"…","boundaries":"…","language":"…"},',
  ' "moves":[{"from":"和不同的人相处","to":"language"}],',
  ' "unused":[{"from":"每次开口前快速自检","why":"是检查步骤，不是设定"}]}',
].join('\n')

/**
 * 模型输出收拾成可信结构：只认十个键、只收字符串、去掉空值。
 * 模型输出永远当不可信输入处理。
 *
 * moves / unused 是给人核对用的账：哪一段被搬进了哪一项、哪一段没搬进去。
 * 它们也当不可信输入收——字段名对不上十一项的直接丢掉，别把「模型说它搬了」
 * 当成「真搬了」拿去展示。字数一律截短，防止一条脏数据把界面撑爆。
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
    // 边界这类天然是列表，模型写成数组是常见写法。以前只收字符串，数组整项被丢掉，
    // 界面上就成了「模型没回这一项」——连着两次漏掉 boundaries 很可能就是它。
    const raw = typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim())
            .filter((item) => item !== '')
            .join('\n')
        : null
    if (raw === null) continue
    const text = raw.replace(/\r\n?/g, '\n').trim()
    if (text === '') continue
    fields[key] = text
    total += text.length
  }
  if (Object.keys(fields).length === 0) return null
  return {
    fields,
    hits: CARD_KEYS.filter((key) => fields[key] !== undefined),
    total,
    moves: readMoves(raw),
    unused: readUnused(raw),
  }
}

/** 一段短说明：去换行、截长，模型给的一律当脏数据收。 */
function oneLine(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

/** 字段名不一定是英文键：中文叫法也认，认不出返回空串。 */
function fieldKeyOf(value) {
  const text = oneLine(value, 20)
  if (text === '') return ''
  if (CARD_KEYS.includes(text)) return text
  const lower = text.toLowerCase()
  const exact = CARD_KEYS.find((key) => key.toLowerCase() === lower)
  if (exact) return exact
  return FIELD_NAMES.get(text) ?? ''
}

const MOVE_MAX = 24
const UNUSED_MAX = 24

function readMoves(raw) {
  const list = Array.isArray(raw.moves) ? raw.moves : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const to = fieldKeyOf(item.to)
    const from = oneLine(item.from, 40)
    if (to === '' || from === '') continue
    out.push({ from, to })
    if (out.length >= MOVE_MAX) break
  }
  return out
}

function readUnused(raw) {
  const list = Array.isArray(raw.unused) ? raw.unused : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const from = oneLine(item.from, 40)
    if (from === '') continue
    out.push({ from, why: oneLine(item.why, 120) })
    if (out.length >= UNUSED_MAX) break
  }
  return out
}
