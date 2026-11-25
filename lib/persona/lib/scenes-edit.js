/**
 * 记忆分层的人手出口（P4）：纯状态改动，不碰盘、不碰时钟。
 *
 * 规则总会有覆盖不到的地方。没有手动出口，用户只能干看着它记错，
 * 所以这几个动作不是「高级功能」，是这套分层能不能被修的前提。
 *
 * 三个动作：
 *   - 挪一条记忆到别的层：人的判断压过自动归类，理由改成「手动」；
 *   - 把一个目录并进某个项目：改映射，下一次召回立刻按新归属走；
 *   - 决定那条「项目通用层满了」的请求：放进去，或者算了。
 *
 * 全部只在传入的 state 上改，返回 { ok, ... }；调用方负责落盘。
 */

import { findMemoryById } from './memory.js'
import { isWithin } from './project.js'
import { sceneOf } from './scene.js'
import { sceneRegistry } from './scene-registry.js'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** 两个路径是不是同一个目录（斜杠方向、大小写、尾部分隔符都不算差别）。 */
function sameDir(a, b) {
  return isWithin(a, b) && isWithin(b, a)
}

/** 场景清单里有没有这一层（改完要能被人看见，所以不认一个树里不存在的层）。 */
function sceneKnown(scenes, id) {
  if (!isObject(scenes)) return false
  if (id === 'owner' || id === 'work:general' || id === 'chat') return true
  const pools = [
    ...(Array.isArray(scenes.projects) ? scenes.projects : []),
    ...(Array.isArray(scenes.groups) ? scenes.groups : []),
    ...(Array.isArray(scenes.external) ? scenes.external : []),
  ]
  if (pools.some((item) => item?.id === id)) return true
  // 外部注册的类型：注册表认识就算一层（节点还没落盘也能挪过去）。
  return sceneRegistry.isKnown(id)
}

/**
 * 把一条记忆挪到别的层。
 *
 * `id` 是编号（M-042），必须是库里已有的：编号不许编造，挪也不许挪一条不存在的。
 * 挪完 `elevatedBy` 记成 manual、权重回满——人挪的不该再按「计数晋升」打折。
 */
export function moveMemoryToScene(state, options = {}) {
  const id = String(options.id ?? '').trim().toUpperCase()
  const scene = String(options.scene ?? '').trim()
  if (id === '' || scene === '') return { ok: false, error: 'empty' }
  if (!sceneKnown(state?.scenes, scene)) return { ok: false, error: 'no-scene' }
  const found = findMemoryById(state, id)
  if (!found) return { ok: false, error: 'not-found' }
  const from = sceneOf(found.entry)
  found.entry.scene = scene
  found.entry.elevatedBy = 'manual'
  found.entry.weight = 1
  return { ok: true, id, from, to: scene, scope: found.scope, kind: found.kind }
}

/**
 * 把一个目录并进某个项目（手动合并）。
 *
 * 一个目录只属于一个项目：先把它从别的项目里摘掉再挂过来，
 * 否则同一个目录会同时命中两个项目，谁赢取决于遍历顺序——那是最难查的一类错。
 */
export function mergeProjectDir(state, options = {}) {
  const dir = String(options.dir ?? '').trim()
  const scene = String(options.scene ?? '').trim()
  if (dir === '' || scene === '') return { ok: false, error: 'empty' }
  const scenes = isObject(state?.scenes) ? state.scenes : null
  if (scenes === null) return { ok: false, error: 'no-scenes' }
  const projects = Array.isArray(scenes.projects) ? scenes.projects : (scenes.projects = [])
  const project = projects.find((item) => item?.id === scene)
  if (!project) return { ok: false, error: 'no-project' }
  for (const other of projects) {
    if (other === project) continue
    other.dirs = (Array.isArray(other.dirs) ? other.dirs : []).filter((item) => !sameDir(item, dir))
  }
  const dirs = Array.isArray(project.dirs) ? project.dirs : []
  if (!dirs.some((item) => sameDir(item, dir))) dirs.push(dir)
  project.dirs = dirs
  project.updatedAt = Number(options.now) || Date.now()
  return { ok: true, dir, scene }
}

/** 给场景改个名字：人不该被一个自动生成的目录名困住。 */
export function renameScene(state, options = {}) {
  const scene = String(options.scene ?? '').trim()
  const name = String(options.name ?? '').trim().slice(0, 60)
  if (scene === '' || name === '') return { ok: false, error: 'empty' }
  const scenes = isObject(state?.scenes) ? state.scenes : null
  if (scenes === null) return { ok: false, error: 'no-scenes' }
  const nodes = [
    ...(Array.isArray(scenes.projects) ? scenes.projects : []),
    ...(Array.isArray(scenes.groups) ? scenes.groups : []),
  ]
  const node = nodes.find((item) => item?.id === scene)
  if (!node) return { ok: false, error: 'no-scene' }
  node.name = name
  node.updatedAt = Number(options.now) || Date.now()
  return { ok: true, scene, name }
}

/**
 * 决定「项目通用层满了」的那条请求。
 *
 * 放进去了就真的挪过去，并记成手动（不是自动晋升，别让它背七折权重）；
 * 拒绝就只是把请求划掉——原条目留在原层，一条都不丢。
 */
export function decideSceneRequest(state, options = {}) {
  const scene = String(options.scene ?? '').trim()
  const text = String(options.text ?? '').trim()
  const accept = options.accept === true
  const list = Array.isArray(state?.sceneRequests) ? state.sceneRequests : []
  const index = list.findIndex((item) => item?.scene === scene && item?.text === text)
  if (index < 0) return { ok: false, error: 'not-found' }
  const request = list[index]
  let moved = false
  if (accept) {
    const found = request.id ? findMemoryById(state, request.id) : null
    if (found) {
      found.entry.scene = scene
      found.entry.elevatedBy = 'manual'
      found.entry.weight = 1
      moved = true
    }
  }
  list.splice(index, 1)
  return { ok: true, accept, moved, scene, text }
}
