// 原文留存口径（用户 2026-11-04）：压缩前的原文要留、要能后期检索，
// 但绝不进上下文——上下文只放摘要。
//
// 所以这一层只做一件事：把会话事件按 seq 拼成一份能读的 md。
// 写盘仍然只走 store.drainQueue，而且这份文件谁都不读：
// 不进锚定块、不进索引、不进关键词，也从不被 inject/rebuild 拿起来。
//
// 纯函数：不看时钟、不碰盘。时间和来源都由调用方喂进来。

export const RAW_DIR_NAME = '原文';
export const RAW_MARK = 'whale-context-raw';
export const MAX_BLOCK_CHARS = 8000;
export const NON_TEXT_BLOCK = '[非文本块]';

// 正文按块截断。原文是拿来检索的，不是拿来整段塞进模型的，
// 所以单个工具结果太大就砍，砍了要留下「砍了多少」这条线。
export function cut(text, limit = MAX_BLOCK_CHARS) {
  const body = String(text ?? '');
  if (limit <= 0 || body.length <= limit) return body;
  return `${body.slice(0, limit)}\n…（截断，原文 ${body.length} 字）`;
}

export function isoOf(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

// 一张卡一份原文，文件名跟卡片同源同代：同一块再压一次绝不覆盖上一版。
export function rawFileName(blockId, gen = 1) {
  const base = String(blockId ?? '');
  const round = Number.isFinite(gen) && gen > 1 ? `-${Math.trunc(gen)}` : '';
  return `${base}${round}.md`;
}

// 用户消息把内容放在 data.content，助手消息放在 data.message.content。
function contentOf(event) {
  const data = event?.data ?? {};
  if (Array.isArray(data.content)) return data.content;
  if (Array.isArray(data.message?.content)) return data.message.content;
  return [];
}

const LABELS = new Map([
  ['user/message', '用户'],
  ['developer/message', '开发者'],
  ['assistant/message', '助手'],
  ['tool/result', '工具结果'],
]);

function blockLines(block) {
  if (!block || typeof block !== 'object') return [];
  if (block.type === 'text' && typeof block.text === 'string') return [cut(block.text)];
  // 推理块不进原文：它是模型的过程稿，不是这段对话的内容，塞进来只会把检索淹掉。
  if (block.type === 'reasoning') return [];
  if (block.type === 'tool-call') {
    const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
    return [`**调用工具**：\`${String(block.name ?? '')}\``, '', cut(args, 2000)];
  }
  return [NON_TEXT_BLOCK];
}

// 一条事件 → 一小节；不是对话也不进原文，返回 null 让调用方跳过。
export function sectionOf(event) {
  const label = LABELS.get(event?.type);
  if (label === undefined) return null;
  const body = contentOf(event).flatMap(blockLines).filter((line) => line !== '');
  if (body.length === 0) return null;
  const at = isoOf(event.time);
  const seq = Number.isFinite(event.seq) ? `seq ${event.seq}` : 'seq ?';
  return [`### [${seq}] ${label}${at === '' ? '' : ` · ${at}`}`, '', ...body, ''].join('\n');
}

export function renderRaw({ events = [], blockId = '', gen = 1, range = '', at = '', provider = '', model = '', missing = [] } = {}) {
  const list = Array.isArray(events) ? events : [];
  const gone = (Array.isArray(missing) ? missing : []).filter((seq) => Number.isFinite(seq));
  const sections = [];
  let kept = 0;
  const skipped = new Map();
  for (const event of list) {
    const section = sectionOf(event);
    if (section === null) {
      const type = String(event?.type ?? '未知');
      skipped.set(type, (skipped.get(type) ?? 0) + 1);
      continue;
    }
    sections.push(section);
    kept += 1;
  }
  const source = [provider, model].filter((item) => item !== '').join('/');
  const head = [
    `<!-- ${RAW_MARK} block=${String(blockId)} gen=${Math.trunc(Number(gen) || 1)} range=${String(range)} at=${String(at)} events=${list.length} kept=${kept} missing=${gone.length} -->`,
    `# 原文留存 · ${String(blockId)}`,
    '',
    `- 范围：${String(range) === '' ? '未标' : String(range)}`,
    `- 时间：${String(at) === '' ? '未标' : String(at)}`,
    `- 来源：${source === '' ? '未标' : source}`,
    `- 原始事件：${list.length + gone.length} 条，收进 ${kept} 条`,
    '- 说明：这一份只供后期检索，不参与上下文注入——上下文只放摘要。',
    '',
    '---',
    '',
  ];
  if (skipped.size > 0) {
    const tail = [...skipped.entries()].map(([type, count]) => `${type} ${count}`).join('、');
    head.push(`<!-- 未收进原文的事件：${tail} -->`, '');
  }
  // 宿主会单点 prune（一次删掉一条事件）。被删的那些这里取不到——不许装作整份都齐，
  // 缺了哪几条要写在最前面，后期检索的人才不会以为漏的那个 seq 从来没发生过。
  if (gone.length > 0) {
    head.push(`> 缺 ${gone.length} 条：seq ${gone.join('、')}（宿主已 prune，内容取不回来了）`, '');
  }
  return head.concat(sections).join('\n');
}
