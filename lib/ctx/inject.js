// 口径出处：融合计划-v2.md §16.5.3（热索引只放目录，摘要正文永不常驻）、
// §16.6（锚定块 ≤300 字、放稳定前缀之后、哈希一样就不重写）。
//
// 这一层只造文本，不碰盘：锚定块由调用方按需现算，没有「写哪儿」这回事了。

import { createHash } from 'node:crypto';

export const ANCHOR_MAX = 300;
export const ANCHOR_LIMIT = 12;
export const TOPIC_MAX = 12;
export const KEYWORD_MAX = 2;

const DATE_TIME = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/g;

function oneLine(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

// 目录行里主题只给 TOPIC_MAX 个字，超了就缩。缩的时候落在词/标点边界上，
// 免得切出 `Primary Requ` 这种半个词——看着像坏了。太靠前（<4 字）就宁可整段切。
const CUT_BREAK = /[\s。；，、：·（）(),.;:!?]/u;

function cut(text, max) {
  const value = oneLine(text);
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  for (let index = head.length - 1; index >= 4; index -= 1) {
    if (CUT_BREAK.test(head[index])) return head.slice(0, index);
  }
  return head;
}

function keywordsOf(fields) {
  const list = Array.isArray(fields?.keywords) ? fields.keywords : [];
  const picked = [];
  for (const item of list) {
    const word = oneLine(item);
    if (word !== '' && picked.length < KEYWORD_MAX) picked.push(word);
  }
  return picked;
}

// 只放目录：编号 · 主题（前两个关键词）。最近的排前面，没时间的排后面。
export function buildAnchor({ cards } = {}) {
  const list = Array.isArray(cards) ? cards.slice() : [];
  const sorted = list
    .map((card, index) => ({ card, index }))
    .sort((left, right) => {
      const a = oneLine(left.card?.at);
      const b = oneLine(right.card?.at);
      if (a === b) return left.index - right.index;
      if (a === '') return 1;
      if (b === '') return -1;
      return a < b ? 1 : -1;
    })
    .map((entry) => entry.card);

  const lines = [];
  for (const card of sorted) {
    if (lines.length >= ANCHOR_LIMIT) break;
    const id = oneLine(card?.id);
    if (id === '') continue;
    const fields = card?.fields;
    const topic = cut(fields?.topic, TOPIC_MAX);
    const words = keywordsOf(fields);
    const head = topic === '' ? id : `${id} · ${topic}`;
    lines.push(words.length === 0 ? head : `${head}（${words.join('、')}）`);
  }
  return lines;
}

// 锚定块里不许出现任何日期时间：否则哈希每次都变，前缀缓存白保。
export function anchorText({ lines } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const body = list
    .map((line) => oneLine(line).replace(DATE_TIME, '').replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
  if (body.length <= ANCHOR_MAX) return body;
  return `${body.slice(0, ANCHOR_MAX)}…`;
}

// 哈希口径与母体一致：先把 CRLF 归一成 LF，去掉末尾所有换行，再补回一个。
export function anchorHash(text) {
  const normalized = String(text === undefined || text === null ? '' : text)
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/, '');
  return createHash('md5').update(`${normalized}\n`, 'utf8').digest('hex');
}
