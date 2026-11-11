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
    assert.deepEqual(result.fields, { title: '你' })
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
})
