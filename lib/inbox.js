/**
 * 往会话里塞一条的形状：`{ id, role, content, source }`，照宿主 `agent/inject` 收的样子。
 *
 * 三处都用这一个（上下文提醒、台账提醒、命令失败回执），别再各写一份——
 * 形状一处分叉，宿主换字段时只改得动一处，另两处静默失效。
 */
export function messageFor(text) {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-whale-pal' },
  }
}
