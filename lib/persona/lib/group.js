/**
 * 群聊说话人（记忆分层 P5）：群里谁说的话要分得清，重启之后还分得清。
 *
 * 三条口径（2026-11-19 定）：
 *   - 群的键是群 id，不是会话、不是目录。会话只是壳，换掉、删掉都不影响记忆；
 *   - 群的会话寿命：长期一个；
 *   - 所有群共用一个空目录（插件数据区里那一个），不每群建目录、不进鲸鲸名单。
 *
 * 为什么说话人要挂在「来源」对象里：宿主的会话日志会连来源一起存、一起重放，
 * 压缩之后也还在；另外记一张「消息编号 → 说话人」的旁表，一压缩就跟正文错位。
 * **多出来的字段只能挂在来源里**，事件那一层加一个字段都会让整份日志读不出来（已实测）。
 *
 * 唤醒也得说清楚：现有的 `agent.inject` 是「插到下一步、不唤醒」，群里来消息用它，
 * 她会静静躺着不开口。要用 `agent.send(message, 'nextTurn', true)` 这个会唤醒的入口。
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { groupScene, scenePart, speakerScene } from './scene.js'

const TEXT_MAX = 4000
const NAME_MAX = 60

const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

/** 群记录里存的会话编号：宿主建会话时不收自定义字段，标记只能存在这边。 */
export function groupSceneOf(platform, groupId) {
  return groupScene(platform, groupId)
}

/** 说话人所在的池子：群 → 人。 */
export function groupSpeakerScene(record, speakerId) {
  const groupId = oneLine(record?.id) || groupScene(record?.platform, record?.groupId)
  if (groupId === '') return ''
  const who = scenePart(speakerId)
  // 没给说话人 id 就退回群这一层：宁可少一层，也不编一个人。
  if (who === '') return groupId
  return speakerScene(groupId, who)
}

/** 所有群共用的那个空目录。 */
export function groupDirOf(paths) {
  const root = oneLine(paths?.root)
  return root === '' ? '' : join(root, 'groups')
}

/**
 * 入口收到的身体归一：说话人和内容一起送进来，缺一样就明确拒绝。
 * @returns {{ok: true, platform: string, groupId: string, groupName: string, speakerId: string, speakerName: string, text: string} | {ok: false, error: string}}
 */
export function normalizeIncomingGroup(body) {
  const source = body && typeof body === 'object' ? body : {}
  const platform = scenePart(source.platform)
  const groupId = oneLine(source.groupId ?? source.group)
  const speaker = oneLine(source.speakerId ?? source.speaker)
  const text = String(source.text ?? '').trim()
  if (platform === '' || groupId === '') return { ok: false, error: 'missing-group' }
  if (speaker === '') return { ok: false, error: 'missing-speaker' }
  if (text === '') return { ok: false, error: 'empty-text' }
  return {
    ok: true,
    platform,
    groupId: groupId.slice(0, 80),
    groupName: oneLine(source.groupName ?? source.name).slice(0, NAME_MAX),
    speakerId: speaker.slice(0, 80),
    speakerName: oneLine(source.speakerName ?? speaker).slice(0, NAME_MAX),
    text: text.slice(0, TEXT_MAX),
  }
}

/**
 * 造一条用户消息。
 *
 * 来源必须是 `kind: 'user'`：模型和界面都当「有人说话」；
 * 换成插件来源虽然也存得住，但语义变成插件通知，模型不会把它当对话。
 */
export function groupMessageOf(incoming) {
  const groupId = groupSceneOf(incoming.platform, incoming.groupId)
  const speakerId = scenePart(incoming.speakerId)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: incoming.text }],
    source: {
      kind: 'user',
      // 多出来的字段只挂这里（事件层一个字段都不能加）。
      group: {
        platform: incoming.platform,
        id: incoming.groupId,
        scene: groupId,
        name: incoming.groupName || incoming.groupId,
      },
      speaker: {
        id: speakerId,
        name: incoming.speakerName || incoming.speakerId,
      },
    },
  }
}

/** 场景树里找这个群。 */
export function findGroupRecord(scenes, platform, groupId) {
  const want = groupSceneOf(platform, groupId)
  const groups = Array.isArray(scenes?.groups) ? scenes.groups : []
  return groups.find((item) => item?.id === want) ?? null
}

/**
 * 群里来了消息：记录在就复用，记录不在就建一条。
 * 说话人进成员表（按人配额，最多 200 个，和场景归一的上限一致）。
 */
export function upsertGroupRecord(scenes, incoming, now = Date.now()) {
  const timestamp = Number(now) || Date.now()
  const id = groupSceneOf(incoming.platform, incoming.groupId)
  const groups = Array.isArray(scenes?.groups) ? scenes.groups : (scenes.groups = [])
  let record = groups.find((item) => item?.id === id) ?? null
  let created = false
  if (record === null) {
    record = {
      id,
      platform: incoming.platform,
      groupId: incoming.groupId,
      name: incoming.groupName || incoming.groupId,
      members: [],
      sessionId: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    groups.push(record)
    created = true
  }
  if (record.name === '' || record.name === undefined) record.name = incoming.groupName || incoming.groupId
  record.updatedAt = timestamp
  const who = scenePart(incoming.speakerId)
  const members = Array.isArray(record.members) ? record.members : (record.members = [])
  if (who !== '' && !members.some((member) => member?.id === who)) {
    members.push({ id: who, name: incoming.speakerName || incoming.speakerId })
    while (members.length > 200) members.shift()
  }
  return { group: record, created }
}

/**
 * 常驻自检：群记录里那条会话还认不认得。
 *
 * 最坏的情况不是难看，是静默降级：会话被手删、编号写坏，那个群就退化成普通助手会话，
 * 语气和记忆归属一起变，界面上看不出来。所以这条要在启动时和每次看状态时都跑。
 */
export function checkGroupSessions(groups, sessionIds) {
  const known = new Set((Array.isArray(sessionIds) ? sessionIds : []).map((id) => oneLine(id)).filter(Boolean))
  return (Array.isArray(groups) ? groups : []).map((group) => {
    const sessionId = oneLine(group?.sessionId)
    if (sessionId === '') return { id: oneLine(group?.id), sessionId: '', ok: false, reason: 'no-session' }
    return { id: oneLine(group?.id), sessionId, ok: known.has(sessionId), reason: known.has(sessionId) ? '' : 'missing' }
  })
}
