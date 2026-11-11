/**
 * 台账的表格原语：markdown 表格的行渲染与解析。
 *
 * 口径出处：`融合计划-v2.md` §11.6（一行一条、六列、判断与教训分栏）与 §7 第 5 条
 * （台账只追加，不修改历史行）。
 *
 * 为什么是裸 markdown 表格而不是 JSON/数据库：台账要「普通人能读能删」（§11.6 末句），
 * 所以落盘就是 `| a | b |` 这样的行——用户拿任何编辑器删掉一行，别的行不受影响，
 * 也不需要工具才能看懂。说明文字走 `>` 引用行，不参与数据解析。
 *
 * **一格在 JS 里始终是原样文本，只有 renderRow 落盘时才转义**（`|` → `\|`，换行压成空格）。
 * 反过来 parseCells 负责还原。这条分界不清就会出现两种错：写进文件的行读回来变了样，
 * 或者读回来的行再写一次多一层反斜线（第一版踩过，所以口径写在这）。
 *
 * 纯模块：不碰盘、不读环境变量、不看时钟。
 */

/** 没当场定论的那几格先写这个，事后只替换它——替换规则见 books.js。 */
export const PLACEHOLDER = '待补';

/** 转义后的竖线在拆分时先换成掩码，拆完再还原；不然一格的竖线会把行拆成两格。 */
const PIPE_MASK = '\u0001';

/** 压成一行：多一行就多一条假账，解析时列数对不上。 */
export function oneLine(value) {
  return String(value ?? '')
    .replace(/\r\n|\r|\n/gu, ' ')
    .trim();
}

/** 落盘形态：一行、竖线转义。 */
export function cellText(value) {
  return oneLine(value).replace(/\|/gu, '\\|');
}

/** 读回形态：把转义（或拆分用的掩码）还原成原样的竖线。 */
export function cellRaw(text) {
  return String(text ?? '')
    .replaceAll(PIPE_MASK, '|')
    .replaceAll('\\|', '|');
}

/** 数据行：`| a | b | c |`。 */
export function renderRow(cells) {
  const list = Array.isArray(cells) ? cells : [];
  return `| ${list.map(cellText).join(' | ')} |`;
}

/** 分隔行：markdown 靠它认出这是一张表，列宽跟表头对齐。 */
export function renderSeparator(count) {
  const width = Number.isInteger(count) && count > 0 ? count : 0;
  return `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
}

/** 拆一行成若干格。首尾那两根竖线不算格子，转义过的竖线不算分隔符。 */
export function parseCells(line) {
  const masked = String(line ?? '')
    .replaceAll('\\|', PIPE_MASK)
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '');
  return masked.split('|').map((cell) => cellRaw(cell.trim()));
}

/** 是不是分隔行（`| --- | :--: |`）。空行、说明行都不是。 */
export function isSeparator(line) {
  const trimmed = String(line ?? '').trim();
  if (trimmed.startsWith('|') === false) return false;
  const cells = parseCells(trimmed);
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/u.test(cell.trim()));
}

/**
 * 取数据行：跳过表头与分隔行。
 *
 * 判法不是「前两行一定是表头」——手写的台账被人删过表头也得能读。
 * 所以只按内容认：第一个 `|` 行当表头丢掉，分隔行一律丢，剩下的才是一条条账。
 */
export function parseRows(text) {
  const rows = [];
  let headerSeen = false;
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') === false) continue;
    if (isSeparator(trimmed)) continue;
    if (headerSeen === false) {
      headerSeen = true;
      continue;
    }
    rows.push({ index: rows.length, cells: parseCells(trimmed) });
  }
  return rows;
}

/** 两份文本一模一样。写之前拿它挡住「无事也重写」——重写会刷 mtime、多一堆 .bak。 */
export function sameText(left, right) {
  return String(left ?? '') === String(right ?? '');
}

/** 文末补一个换行：追加时不让新行粘在旧行尾巴上。 */
export function ensureNewline(text) {
  const body = String(text ?? '');
  return body === '' || body.endsWith('\n') ? body : `${body}\n`;
}

/**
 * 替换第 index 条数据行的内容，别的字节一律不动。
 *
 * 这是全模块**唯一**会改已有文字的地方，只给「补齐占位格」和「标结状态」用；
 * 调用方（books.js）先把「只许替换占位符」判完才走到这里。
 */
export function replaceRow(text, index, cells) {
  const body = String(text ?? '');
  const lines = body.split('\n');
  let headerSeen = false;
  let seen = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('|') === false) continue;
    if (isSeparator(trimmed)) continue;
    if (headerSeen === false) {
      headerSeen = true;
      continue;
    }
    seen += 1;
    if (seen !== index) continue;
    lines[i] = renderRow(cells);
    return lines.join('\n');
  }
  return null;
}
