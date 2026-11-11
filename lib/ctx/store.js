// 口径出处：`融合计划-v2.md` §16.4（档案存 `_上下文/压缩档案/<blockId>.md`）、
// §16.5（索引是派生文件；关键词与条目按需现算，不落盘）、§16.6（锚定块按需现算）、
// `docs/P35-补全.md` 第四节（目录与编号）。
//
// 这一层是 ctx 里唯一碰盘的地方：别的模块只做判断与拼字，写不写、写哪儿都问这里。
// 两条硬规矩：
// 1. 内容一样就不落盘，mtime 不动——前缀缓存靠这个活着。
// 2. 同一块被再压一次要留旧版：第二代起文件名带代号，绝不覆盖上一版。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { nextId, readCard, renderCard } from './archive.js';
import { cardsOfBatch, nextBatch } from './batch.js';
import { mergeEntries } from './entries.js';
import { RAW_DIR_NAME, rawFileName } from './raw.js';
import { rebuildFromCards } from './rebuild.js';
import { compareId } from './index3.js';

export const CTX_DIR_NAME = '_上下文';
export const CARD_DIR_NAME = '压缩档案';
export const INDEX_NAME = '索引.md';
export const TRASH_DIR_NAME = '回收站';
export const TOPIC_CUT = 16;

/** 库目录 → 上下文档案根目录。库换了，档案跟着库走。 */
export function ctxRoot(vaultPath) {
  return join(String(vaultPath ?? ''), CTX_DIR_NAME);
}

/** 一份档案目录里的各条路径；只拼路径，不建目录。 */
export function pathsOf(root) {
  const base = String(root ?? '');
  return {
    root: base,
    cards: join(base, CARD_DIR_NAME),
    // 原文单独一层子目录：卡片那层按 `.md` 平铺扫描，子目录不会被当成卡片读走。
    raw: join(base, CARD_DIR_NAME, RAW_DIR_NAME),
    index: join(base, INDEX_NAME),
  };
}

export function ensureLayout(root) {
  const layout = pathsOf(root);
  try {
    mkdirSync(layout.cards, { recursive: true });
    mkdirSync(layout.raw, { recursive: true });
    return { ok: true, layout };
  } catch (error) {
    return { ok: false, reason: 'layout-failed', detail: String(error?.message ?? error) };
  }
}

/** 读一份文本；读不到就 null，不当异常传下去。 */
export function readTextFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 写一份文本：内容一样就一个字节都不动。
 *
 * 先写临时文件再改名：中途断掉不会留下半份索引，也不会出现两个进程各写一半的局面。
 */
export function writeText(file, text) {
  const body = String(text ?? '');
  const current = readTextFile(file);
  if (current !== null && current === body) return { ok: true, file, wrote: false };
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, body, 'utf8');
    renameSync(temp, file);
    return { ok: true, file, wrote: true };
  } catch (error) {
    try {
      if (existsSync(temp)) rmSync(temp, { force: true });
    } catch {
      /* 临时文件清不掉不值得再抛一次 */
    }
    return { ok: false, reason: 'write-failed', detail: String(error?.message ?? error) };
  }
}

const oneLine = (value) => String(value ?? '').replace(/\r?\n|\r/g, ' ').trim();

// 条目标签不算关键词：它们是抽取用的类型名，拿来当词表只会误导。
const NOT_KEYWORD = new Set(['事实', '决定', '待办', '偏好']);

// 英文虚词也不进关键词。宿主的压缩摘要是那边模型写的，写英文时满篇 the/and/for，
// 光按词频排它们准排前面（真机上第一版就是 `the、and、dsh`）。
const STOPWORD = new Set(('a an the and or but if then than that this these those there here ' +
  'is are was were be been being am do does did doing done have has had having ' +
  'i me my we us our you your he him his she her it its they them their ' +
  'of in on at to for from with without by as into over under about after before between ' +
  'not no nor so too very can could may might must shall should will would ' +
  'when where which who whom whose what how why all any both each few more most other some such ' +
  'only own same up down out off again once also just now').split(' ').filter((word) => word !== ''));

/**
 * 从摘要里猜几个关键词（2–6 个字、按出现次数排，虚词不算）。
 *
 * 这是算出来的，不是原文标的：卡片里那行「关键词」是同一套算法给的，
 * 只用来补索引与锚定块要用的短词。
 *
 * 注意口径：**不能**再加「出现≥2次」这类收紧条件。卡片格式要求至少 2 个关键词，
 * 条件一苛刻，摘要一薄就可能凑不够，整张卡会被判不合法、直接写不进去。
 */
export function guessKeywords(text, limit = 3) {
  const counts = new Map();
  const words = String(text ?? '').split(/[^0-9A-Za-z\u4e00-\u9fff]+/u);
  for (const word of words) {
    const value = word.trim();
    if (value.length < 2 || value.length > 6) continue;
    if (NOT_KEYWORD.has(value)) continue;
    if (STOPWORD.has(value.toLowerCase())) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => (right[1] - left[1]) || (right[0].length - left[0].length))
    .slice(0, limit)
    .map((entry) => entry[0]);
}

// 主题取第一行不为空的字：太长就在标点处断开，免得索引里挂着半句话。
// 中英标点都要算：宿主那边的摘要是英文的，只认中文标点会一刀都断不下来。
const TOPIC_BREAK = /[。；，、：·（）()\s,.;:!?]/u;

export function topicOf(text) {
  const lines = String(text ?? '').split('\n');
  for (const line of lines) {
    const value = oneLine(line).replace(/^#+\s*/, '');
    if (value === '') continue;
    if (value.length <= TOPIC_CUT) return value;
    const head = value.slice(0, TOPIC_CUT);
    // 断在预算内**最后**一个标点。断在第一个会把 `Primary Request and Intent`
    // 切成 `Primary`（真机第一版就是这样），那还不如不断。
    let at = -1;
    for (let index = head.length - 1; index >= 0; index -= 1) {
      if (TOPIC_BREAK.test(head[index])) {
        at = index;
        break;
      }
    }
    // 断在太靠前的位置反而更糊涂，所以至少留 6 个字。
    if (at >= 6) return head.slice(0, at);
    return head;
  }
  return '';
}

/** 一张卡片：编号由队列排，主题与关键词从摘要里出来。 */
export function cardOf({ id, blockId, gen = 1, batch = 'B001', source = 'native', at = '', item = {} }) {
  const text = String(item.text ?? '');
  return {
    id,
    blockId,
    gen,
    batch,
    source,
    at,
    fields: {
      range: oneLine(item.range),
      topic: topicOf(text),
      summary: text,
      keywords: guessKeywords(text),
      unfinished: '无（自动压缩，原文没标）',
      // 模型补的条目：落档时是空的，之后由 `/whale ctx entries` 或工具那一路补。
      entries: [],
    },
  };
}

// 同一块被再压一次要留旧版：第二代起文件名带代号，绝不覆盖上一版（⑨ 旧版不覆盖）。
export function cardFileName(blockId, gen = 1) {
  const base = String(blockId ?? '');
  const round = Number.isFinite(gen) && gen > 1 ? `-${Math.trunc(gen)}` : '';
  return `${base}${round}.md`;
}

export function writeCard(root, card) {
  const layout = pathsOf(root);
  const rendered = renderCard(card);
  if (!rendered || typeof rendered !== 'string') return { ok: false, reason: 'card-unrenderable' };
  const file = join(layout.cards, cardFileName(card.blockId, card.gen));
  const written = writeText(file, rendered);
  if (written.ok !== true) return written;
  return { ok: true, file, wrote: written.wrote };
}

/** 把档案目录里所有卡片读出来，按编号排；读不出来的跳过，不因为一张坏卡就整层失败。 */
export function readCards(root) {
  const layout = pathsOf(root);
  let names = [];
  try {
    names = readdirSync(layout.cards);
  } catch {
    return [];
  }
  const cards = [];
  for (const name of names.filter((item) => item.endsWith('.md'))) {
    const text = readTextFile(join(layout.cards, name));
    if (text === null) continue;
    const card = readCard(text);
    if (card && card.ok === true) cards.push(card);
  }
  cards.sort((left, right) => compareId(left.id, right.id));
  return cards;
}

/**
 * 从档案重写派生文件：只剩 `索引.md` 一份。档案是唯一源，索引能重算。
 *
 * 关键词表、条目表都不再落盘（第二批形态审计：没有持久读者）：
 * 条目表由 `host-bridge` 按需从卡片现算，关键词表整份删掉。
 */
export function rebuildAll(root) {
  const layout = pathsOf(root);
  const made = ensureLayout(root);
  if (made.ok !== true) return made;

  const cards = readCards(root);
  const rebuilt = rebuildFromCards(cards);
  if (!rebuilt || rebuilt.ok !== true) return { ok: false, reason: 'rebuild-failed' };

  const written = writeText(layout.index, rebuilt.indexText);
  if (written.ok !== true) return { ok: false, reason: 'rebuild-failed', detail: written.detail };
  return { ok: true, cards: cards.length };
}

/**
 * 消费待写队列：每一条变成一张卡 + 一份原文，编号接着往后排。
 *
 * 队列来自投影状态（会话重放会再攒一遍），所以这里只认「这次要写什么」，
 * 不认「上次写到哪」：编号以盘上已有的卡为准。
 *
 * `rawOf(item)` 由调用方给：它拿这条待写的 seqs 去会话里回捞原文并拼成 md。
 * 回捞不到（宿主没给会话、那批事件已经 prune 掉）不算失败——摘要照样落，
 * 但要把「这份档案没有原文」记下来，别让人以为留过了。
 */
export function drainQueue({ root, pending = [], batch = '', now = '', rawOf = null } = {}) {
  const made = ensureLayout(root);
  if (made.ok !== true) return made;

  const cards = readCards(root);
  const ids = cards.map((card) => card.id);
  // 已经落过盘的块不再写第二遍。投影每次加载都会重放日志，同一份压缩会被重新排进队列；
  // 照写就会给同一张卡换新编号（C001 → C002），锚定块跟着换字、前缀缓存白废。
  const landed = new Set(cards.map((card) => `${card.blockId}#${card.gen}`));
  // 批次号：一次压缩事件落的一批共用一个号，号接着盘上已有的往后排。
  // 队列里 `at` 相同的条目算同一次事件；已经落过的旧块不参与，免得白占号。
  // 调用方显式给了 `batch` 就整批都用它（老调用方与测试还能这么用）。
  const batches = cards.map((card) => card.batch);
  const byEvent = new Map();
  const batchFor = (key) => {
    if (batch !== '') return batch;
    const hit = byEvent.get(key);
    if (hit !== undefined) return hit;
    const minted = nextBatch(batches);
    batches.push(minted);
    byEvent.set(key, minted);
    return minted;
  };
  const batchesWritten = [];
  const written = [];
  const skipped = [];
  const rawWritten = [];
  const rawFailed = [];
  const rawMissing = [];
  for (const item of Array.isArray(pending) ? pending : []) {
    const gen = Number.isFinite(item.gen) ? item.gen : 1;
    const key = `${item.blockId}#${gen}`;
    const seen = landed.has(key);
    let id = '';
    if (seen === false) {
      id = nextId(ids);
      ids.push(id);
      landed.add(key);
    }
    // 原文不管卡片落没落过都试一次：上一次可能没取到，这一次取到了就补上。
    if (typeof rawOf === 'function') {
      let text = null;
      try {
        text = rawOf(item);
      } catch (error) {
        rawFailed.push({ blockId: item.blockId, reason: String(error?.message ?? error) });
      }
      if (typeof text === 'string' && text !== '') {
        const raw = writeRaw(root, { blockId: item.blockId, gen, text });
        if (raw.ok === true) rawWritten.push(item.blockId);
        else rawFailed.push({ blockId: item.blockId, reason: raw.reason ?? 'raw-write-failed' });
      } else if (rawExists(root, item.blockId, gen) !== true && !rawFailed.some((one) => one.blockId === item.blockId)) {
        rawMissing.push(item.blockId);
      }
    } else if (rawExists(root, item.blockId, gen) !== true) {
      rawMissing.push(item.blockId);
    }
    if (seen === true) {
      skipped.push(item.blockId);
      continue;
    }
    const mine = batchFor(String(item.at ?? now ?? item.blockId ?? ''));
    const card = cardOf({ id, blockId: item.blockId, gen, batch: mine, source: item.source ?? 'native', at: item.at || now, item });
    const result = writeCard(root, card);
    if (result.ok !== true) return { ok: false, reason: 'card-write-failed', ids: written };
    written.push(id);
    batchesWritten.push(mine);
  }

  const rebuilt = rebuildAll(root);
  if (rebuilt.ok !== true) return { ok: false, reason: 'rebuild-failed', ids: written };
  return { ok: true, ids: written, batches: batchesWritten, skipped, rebuilt, rawWritten, rawFailed, rawMissing };
}

/**
 * 队列里**还没落过盘**的那几条（按 `blockId#gen` 判）。
 *
 * 自动落盘专用：`drainQueue` 对已经落过的条目仍会重跑一遍 `rawOf`（那是为了补上
 * 上次没取到的原文），可队列里攒着几十万条被压事件，每轮都重算一遍原文不值当。
 * 先在这儿筛掉落过的，自动那条路就只在真有新东西时动手。
 */
export function pendingNew(root, pending = []) {
  const landed = new Set(readCards(root).map((card) => `${card.blockId}#${card.gen}`));
  return (Array.isArray(pending) ? pending : []).filter((item) => {
    const gen = Number.isFinite(item?.gen) ? item.gen : 1;
    return landed.has(`${String(item?.blockId ?? '')}#${gen}`) === false;
  });
}

/**
 * 把模型补的条目并进某张卡片，然后重算索引（条目表按需现算，不用重算）。
 *
 * 条目存在**卡片里**（卡片是唯一源），所以重算不会把它冲掉；
 * 同一「类型 + 内容」再写一遍不算新增（幂等），内容改了就是新的一条。
 */
export function setCardEntries(root, { id = '', rows = [] } = {}) {
  const want = String(id ?? '').trim().toUpperCase();
  if (want === '') return { ok: false, reason: 'no-id' };
  const cards = readCards(root);
  const card = cards.find((one) => one.id === want);
  if (!card) return { ok: false, reason: 'card-not-found' };

  const before = Array.isArray(card.fields.entries) ? card.fields.entries : [];
  const merged = mergeEntries(before, rows);
  const added = merged.length - before.length;
  if (added === 0) return { ok: true, id: want, entries: merged, added, wrote: false, cards: cards.length };

  const next = { ...card, fields: { ...card.fields, entries: merged } };
  delete next.ok;
  const written = writeCard(root, next);
  if (written.ok !== true) return { ok: false, reason: written.reason ?? 'card-write-failed' };
  const rebuilt = rebuildAll(root);
  if (rebuilt.ok !== true) return { ok: false, reason: 'rebuild-failed' };
  return { ok: true, id: want, entries: merged, added, wrote: written.wrote === true, cards: cards.length };
}

/**
 * 整批撤下来：把这一批的卡片与它们的原文**挪进库内的回收站**，然后重算索引。
 *
 * 只挪不删——回收站里按原来的两层结构放好，搬回去就等于还原。
 * `at` 由调用方给（本层不读时钟），只用来给回收站那层文件夹起个不重名的名字。
 * 中途挪不动就停下，已经挪过的照实报出来，索引仍然按盘上剩下的重算（不留半份假账）。
 */
export function trashBatch(root, { batch = '', at = '' } = {}) {
  const made = ensureLayout(root);
  if (made.ok !== true) return made;
  const layout = pathsOf(root);
  const want = String(batch ?? '').trim();
  if (want === '') return { ok: false, reason: 'no-batch' };
  const cards = cardsOfBatch({ cards: readCards(root), batch: want });
  if (cards.length === 0) return { ok: false, reason: 'batch-unknown' };

  const stamp = String(at ?? '').replaceAll(':', '-').replaceAll('.', '-');
  const folder = join(layout.root, TRASH_DIR_NAME, stamp === '' ? want : `${want}_${stamp}`);
  const moved = [];
  const failed = [];
  for (const card of cards) {
    const file = cardFileName(card.blockId, card.gen);
    const raw = rawFileName(card.blockId, card.gen);
    let broke = '';
    try {
      mkdirSync(join(folder, CARD_DIR_NAME), { recursive: true });
      renameSync(join(layout.cards, file), join(folder, CARD_DIR_NAME, file));
    } catch (error) {
      broke = String(error?.message ?? error);
    }
    let rawMoved = false;
    if (broke === '' && existsSync(join(layout.raw, raw))) {
      try {
        mkdirSync(join(folder, RAW_DIR_NAME), { recursive: true });
        renameSync(join(layout.raw, raw), join(folder, RAW_DIR_NAME, raw));
        rawMoved = true;
      } catch (error) {
        broke = String(error?.message ?? error);
      }
    }
    if (broke !== '') {
      failed.push({ id: card.id, reason: broke });
      continue;
    }
    moved.push({ id: card.id, file, raw: rawMoved ? raw : '' });
  }

  const rebuilt = rebuildAll(root);
  if (rebuilt.ok !== true) return { ok: false, reason: 'rebuild-failed', folder, moved, failed };
  return { ok: failed.length === 0, batch: want, folder, moved, failed, cards: readCards(root).length };
}

/**
 * 按当前口径把盘上每张卡片的「主题」「关键词」重算一遍，别的一格不动。
 * 只在取词口径改过以后用：卡片是唯一源，摘要、范围、编号一个字都不改，
 * 只重写这两行，再把索引重算。
 */
export function refreshCards(root) {
  const changed = [];
  const failed = [];
  for (const card of readCards(root)) {
    const topic = topicOf(card.fields.summary);
    const keywords = guessKeywords(card.fields.summary);
    if (topic === card.fields.topic && keywords.join('、') === card.fields.keywords.join('、')) continue;
    const next = { ...card, fields: { ...card.fields, topic, keywords } };
    delete next.ok;
    const written = writeCard(root, next);
    if (written.ok !== true) {
      failed.push(card.id);
      continue;
    }
    changed.push({ id: card.id, topic, keywords });
  }
  const rebuilt = rebuildAll(root);
  return { ok: true, changed, failed, rebuilt };
}

/** 原文的文件路径：跟卡片同源同代，位置可推导，索引不用多记一列。 */
export function rawFileOf(root, blockId, gen = 1) {
  return join(pathsOf(root).raw, rawFileName(blockId, gen));
}

export function rawExists(root, blockId, gen = 1) {
  try {
    return existsSync(rawFileOf(root, blockId, gen));
  } catch {
    return false;
  }
}

/** 原文留了几份。`/status` 用它说真话，而不是只看卡片数。 */
export function rawCount(root) {
  try {
    return readdirSync(pathsOf(root).raw).filter((name) => name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/**
 * 写一份原文。内容一样就不动 mtime——跟别的落盘一个规矩。
 * 原文只进这一个目录，谁都不读它：不进锚定块、不进索引。
 */
export function writeRaw(root, { blockId, gen = 1, text = '' } = {}) {
  const made = ensureLayout(root);
  if (made.ok !== true) return made;
  return writeText(rawFileOf(root, blockId, gen), text);
}
