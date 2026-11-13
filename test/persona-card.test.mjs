/**
 * 人格卡解析：一整段原文 → 十项 + 其余。
 *
 * 这里只测纯函数，不碰宿主、不碰磁盘。界面和路由各自另有测试。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CARD_KEYS,
  parsePersonaCard,
  validateSplit,
} from '../lib/persona-card.js'

describe('解析：认识标签', () => {
  it('冒号行按标签拆开，十项齐全', () => {
    const parsed = parsePersonaCard(
      ['名称：六一', '名称的含义：随手起的', '自称：我', '称呼：你', '说话风格：自然口语，少术语'].join('\n'),
    )
    assert.equal(parsed.fields.name, '六一')
    assert.equal(parsed.fields.nameMeaning, '随手起的')
    assert.equal(parsed.fields.selfName, '我')
    assert.equal(parsed.fields.title, '你')
    assert.equal(parsed.fields.language, '自然口语，少术语')
    assert.deepEqual(parsed.hits, ['name', 'nameMeaning', 'selfName', 'title', 'language'])
    // 十项一个不少，认不出的就是空串，不是缺键。
    assert.deepEqual(Object.keys(parsed.fields).sort(), [...CARD_KEYS].sort())
  })

  it('Markdown 标题也当标签，井号个数不影响', () => {
    const parsed = parsePersonaCard(['## 底色', '自然、有边界', '', '### 价值观', '自由、公平'].join('\n'))
    assert.equal(parsed.fields.temperament, '自然、有边界')
    assert.equal(parsed.fields.values, '自由、公平')
  })

  it('半角冒号、列表符、数字编号都不挡识别', () => {
    const parsed = parsePersonaCard(['- 名称: 六一', '1. 底色：自然', '> 价值观：公平'].join('\n'))
    assert.equal(parsed.fields.name, '六一')
    assert.equal(parsed.fields.temperament, '自然')
    assert.equal(parsed.fields.values, '公平')
  })

  it('别名都认：性格 / 底线 / 语气 / 名字', () => {
    const parsed = parsePersonaCard(['名字：六一', '性格：不说软话', '底线：不骂人', '语气：直'].join('\n'))
    assert.equal(parsed.fields.name, '六一')
    assert.equal(parsed.fields.temperament, '不说软话')
    assert.equal(parsed.fields.boundaries, '不骂人')
    assert.equal(parsed.fields.language, '直')
  })

  it('括号里的补充说明不算标签名', () => {
    const parsed = parsePersonaCard('名称（你叫什么）：六一')
    assert.equal(parsed.fields.name, '六一')
  })

  it('中文方括号标题：整行【标签】，后面可以跟正文', () => {
    const parsed = parsePersonaCard(
      ['【性格底色】', '自然、有边界', '【说话方式】用第一人称，称呼对方“你”。', '【边界】不骂人'].join('\n'),
    )
    assert.equal(parsed.fields.temperament, '自然、有边界')
    assert.equal(parsed.fields.language, '用第一人称，称呼对方“你”。')
    assert.equal(parsed.fields.boundaries, '不骂人')
    assert.equal(parsed.rest, '')
  })

  it('中文序号标题：一、标签 和 （一）标签', () => {
    const parsed = parsePersonaCard(['一、性格底色', '冷淡', '（二）价值观', '自由'].join('\n'))
    assert.equal(parsed.fields.temperament, '冷淡')
    assert.equal(parsed.fields.values, '自由')
  })

  it('单独成行的加粗：认得出的当标题，认不出的留在正文里', () => {
    const parsed = parsePersonaCard(['**性格底色**', '有点冷淡', '**不要编造**', '这是正文'].join('\n'))
    assert.equal(parsed.fields.temperament, '有点冷淡\n**不要编造**\n这是正文')
  })

  it('「表达边界」算边界，不再当成认不出的标签', () => {
    const parsed = parsePersonaCard(['【表达边界】', '不攻击外貌和人格'].join('\n'))
    assert.equal(parsed.fields.boundaries, '不攻击外貌和人格')
    assert.equal(parsed.hits.includes('boundaries'), true)
  })

  it('同一个标签出现两次就合到一项里', () => {
    const parsed = parsePersonaCard(['边界：不骂人', '', '边界：不撒谎'].join('\n'))
    assert.equal(parsed.fields.boundaries, '不骂人\n不撒谎')
  })
})

describe('解析：多行块', () => {
  it('块里的列表保留换行，内部空行压掉', () => {
    const parsed = parsePersonaCard(
      ['## 边界', '- 不主动骂人', '', '- 不接受被骂，被骂会还击', '', '## 价值观', '自由'].join('\n'),
    )
    assert.equal(parsed.fields.boundaries, '不主动骂人\n不接受被骂，被骂会还击')
    assert.equal(parsed.fields.values, '自由')
  })

  it('一个标签的正文一直延续到下一个标签为止', () => {
    const parsed = parsePersonaCard(['## 价值观', '自由、公平', '认同共产主义意识形态'].join('\n'))
    assert.equal(parsed.fields.values, '自由、公平\n认同共产主义意识形态')
    assert.equal(parsed.fields.boundaries, '')
  })
})

describe('解析：认不出的东西不许被吞掉', () => {
  it('一个标签都没有：全文进 rest，一项都不认', () => {
    const text = '你就是我最好的朋友，说话随便点。'
    const parsed = parsePersonaCard(text)
    assert.deepEqual(parsed.hits, [])
    assert.equal(parsed.rest, text)
    assert.equal(parsed.total, 0)
  })

  it('长得像标签但别名表里没有的：结束上一段，原样进 rest', () => {
    const parsed = parsePersonaCard(['## 价值观', '自由', '外貌：黑色短发', '喜欢下雨天'].join('\n'))
    assert.equal(parsed.fields.values, '自由')
    // 这一行和它后面跟着的内容都不能被价值观吞掉。
    assert.equal(parsed.rest, '外貌：黑色短发\n喜欢下雨天')
    assert.equal(parsed.fields.values.includes('外貌'), false)
  })

  it('开头就是认不出的标签：从第一行起就进 rest', () => {
    const parsed = parsePersonaCard(['外貌：短头发', '名称：六一'].join('\n'))
    assert.equal(parsed.rest, '外貌：短头发')
    assert.equal(parsed.fields.name, '六一')
  })

  it('认不出的【】标题也结束上一段：不许被上一项吞掉', () => {
    const parsed = parsePersonaCard(['【说话方式】', '口语', '【记忆与成长】', '不编造'].join('\n'))
    assert.equal(parsed.fields.language, '口语')
    // 记忆与成长没有对应的坑，但它的正文必须出现在 rest 里，不能混进说话方式。
    assert.equal(parsed.rest, '【记忆与成长】\n不编造')
  })

  it('内容偏好不是"认不出"：它并进底色，不再另起一段', () => {
    const parsed = parsePersonaCard(['【性格底色】', '冷淡', '【内容偏好】', '喜欢游戏解说'].join('\n'))
    assert.equal(parsed.fields.temperament, '冷淡\n喜欢游戏解说')
    assert.deepEqual(parsed.hits, ['temperament'])
    assert.deepEqual(parsed.sections, [])
  })
})

describe('解析：计数', () => {
  it('chars 是原文长度，total 是十项合计', () => {
    const text = '名称：六一\n\n## 价值观\n自由'
    const parsed = parsePersonaCard(text)
    assert.equal(parsed.chars, text.length)
    assert.equal(parsed.total, '六一'.length + '自由'.length)
  })

  it('空输入不炸', () => {
    const parsed = parsePersonaCard('')
    assert.deepEqual(parsed.hits, [])
    assert.equal(parsed.rest, '')
    assert.equal(parsed.chars, 0)
  })

  it('不是字符串也不炸', () => {
    assert.deepEqual(parsePersonaCard(null).hits, [])
    assert.deepEqual(parsePersonaCard(42).hits, [])
  })
})

describe('解析：没进十项的部分切成段落', () => {
  it('按标题切段，标题名和正文分开，标题行原样留着', () => {
    const parsed = parsePersonaCard(
      ['【说话方式】', '口语', '【记忆与成长】', '只记真发生过的', '不要编造'].join('\n'),
    )
    assert.deepEqual(
      parsed.sections.map((s) => [s.title, s.text]),
      [['记忆与成长', '只记真发生过的\n不要编造']],
    )
    assert.equal(parsed.sections[0].heading, '【记忆与成长】')
    // rest 由 sections 拼回来，两份不会各说一套。
    assert.equal(parsed.rest, '【记忆与成长】\n只记真发生过的\n不要编造')
  })

  it('开头没标题的那段单独成段：title 是空串', () => {
    const parsed = parsePersonaCard(['你是小鲸鱼。', '## 价值观', '自由'].join('\n'))
    assert.equal(parsed.fields.values, '自由')
    assert.equal(parsed.sections.length, 1)
    assert.equal(parsed.sections[0].title, '')
    assert.equal(parsed.sections[0].text, '你是小鲸鱼。')
  })

  it('几段连着、中间夹着认得出的标题，各自独立', () => {
    const parsed = parsePersonaCard(
      ['【外貌】', '黑色短发', '## 价值观', '自由', '【记忆与成长】', '不编造'].join('\n'),
    )
    assert.equal(parsed.fields.values, '自由')
    assert.deepEqual(
      parsed.sections.map((s) => s.title),
      ['外貌', '记忆与成长'],
    )
    // 价值观那段正文不许串到前后两段里。
    assert.equal(parsed.sections[0].text, '黑色短发')
    assert.equal(parsed.sections[1].text, '不编造')
  })

  it('每段的 chars 是这级正文的字数，空壳段不产生', () => {
    const parsed = parsePersonaCard(['## 价值观', '自由', '## 外貌', ''].join('\n'))
    assert.equal(parsed.sections.length, 1)
    assert.equal(parsed.sections[0].text, '')
    assert.equal(parsed.sections[0].chars, 0)
  })

  it('段内的「普通网友：……」是正文，不被切成六个标题', () => {
    const parsed = parsePersonaCard(
      ['【和不同的人相处】', '普通网友：保持边界', '熟人：可以更放松'].join('\n'),
    )
    assert.equal(parsed.sections.length, 1)
    assert.equal(parsed.sections[0].title, '和不同的人相处')
    assert.equal(parsed.sections[0].text, '普通网友：保持边界\n熟人：可以更放松')
  })

  it('顶层出现的认不出冒号行，仍然单独成段', () => {
    const parsed = parsePersonaCard(['外貌：短发', '喜欢下雨天'].join('\n'))
    assert.equal(parsed.sections.length, 1)
    assert.equal(parsed.sections[0].title, '外貌')
    assert.equal(parsed.rest, '外貌：短发\n喜欢下雨天')
  })
})

describe('模型拆解的输出收拾', () => {
  it('只认十个键，别的键丢掉', () => {
    const result = validateSplit({
      fields: { name: '六一', values: '自由', appearance: '短发', boundaries: '' },
    })
    assert.deepEqual(result.fields, { name: '六一', values: '自由' })
    assert.deepEqual(result.hits, ['name', 'values'])
    assert.equal(result.fields.appearance, undefined)
  })

  it('非字符串的值丢掉，不当成空', () => {
    const result = validateSplit({ fields: { name: 42, values: ['自由'], title: '你' } })
    assert.deepEqual(result.fields, { values: '自由', title: '你' })
  })

  it('列表形式的字段按行收：模型把边界写成数组，不许整项丢掉', () => {
    const result = validateSplit({
      fields: {
        name: '六一',
        boundaries: ['不攻击别人的外貌', 42, '   ', '不泄露隐私'],
      },
    })
    assert.equal(result.fields.boundaries, '不攻击别人的外貌\n不泄露隐私')
    assert.deepEqual(result.hits, ['name', 'boundaries'])
  })

  it('十项全空就当这次没拆出来', () => {
    assert.equal(validateSplit({ fields: {} }), null)
    assert.equal(validateSplit({ fields: { name: '   ' } }), null)
    assert.equal(validateSplit(null), null)
    assert.equal(validateSplit('一段话'), null)
  })

  it('没有 fields 外壳时，直接把顶层当字段读', () => {
    const result = validateSplit({ name: '六一', temperament: '自然' })
    assert.deepEqual(result.fields, { name: '六一', temperament: '自然' })
  })

  it('模型的搬运账：只认十项、认中文叫法，脏数据丢掉', () => {
    const result = validateSplit({
      fields: { name: '六一' },
      moves: [
        { from: '和不同的人相处', to: 'language' },
        { from: '记忆与成长', to: '说话' },
        { from: '外貌', to: 'appearance' },
        { from: '', to: 'values' },
        'x',
        null,
      ],
      unused: [
        { from: '每次开口前快速自检', why: '是检查步骤，不是设定' },
        { from: '' },
      ],
    })
    assert.deepEqual(result.moves, [
      { from: '和不同的人相处', to: 'language' },
      { from: '记忆与成长', to: 'language' },
    ])
    assert.deepEqual(result.unused, [{ from: '每次开口前快速自检', why: '是检查步骤，不是设定' }])
  })

  it('模型没交代搬运账时给空数组，页面照旧能用', () => {
    const result = validateSplit({ fields: { name: '六一' } })
    assert.deepEqual(result.moves, [])
    assert.deepEqual(result.unused, [])
  })

  it('搬运账里的长句和换行会被截短压平，不让脏数据撑爆界面', () => {
    const long = '很长的段落标题'.repeat(20)
    const result = validateSplit({
      fields: { name: '六一' },
      moves: [{ from: '第一行\n第二行', to: 'temperament' }],
      unused: [{ from: long, why: '很长的理由'.repeat(60) }],
    })
    assert.equal(result.moves[0].from, '第一行 第二行')
    assert.equal(result.unused[0].from.length, 40)
    assert.equal(result.unused[0].why.length, 120)
  })
})
