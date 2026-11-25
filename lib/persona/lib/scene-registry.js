/**
 * 场景注册口（记忆分层 P6）：场景类型要能从外部注册。
 *
 * 为什么不能写死一个分支：闭源包想加自己的场景（它自己的那一类），只能通过注册口挂进来。
 * 写死了，它想加场景就得改开源代码，改完两个包就绞在一起，分界白写。
 *
 * 三条约定：
 *   - 开源包不认识任何具体的外部场景，只知道「有个类型注册进来了」；
 *   - 注册进来的是「怎么认这个 id、显示成什么、父节点是谁」，不是代码路径；
 *   - 版本门槛明说：闭源声明它需要哪一版注册口，不够就拒绝加载并写清原因——
 *     静默降级就是功能消失了还报正常。
 */

/** 注册口的版本。外部包声明最低要求时跟它比。 */
export const SCENE_API_VERSION = 1

class SceneApiTooOldError extends Error {
  constructor(needs, current = SCENE_API_VERSION) {
    super(`场景注册口太旧：需要 v${needs}，当前 v${current}`)
    this.name = 'SceneApiTooOldError'
    this.code = 'scene-api-too-old'
    this.needs = needs
    this.current = current
  }
}

const oneLine = (value) => String(value ?? '').trim()

/**
 * 一个注册表。
 *
 * @param {number} apiVersion 当前开源包提供的注册口版本
 */
export function createSceneRegistry(apiVersion = SCENE_API_VERSION) {
  const types = new Map()

  const registry = {
    apiVersion,
    /** 外部包进来第一件事：声明它要哪一版。不够就抛，原因写清。 */
    requireApi(needs) {
      const want = Math.floor(Number(needs) || 0)
      if (want > apiVersion) throw new SceneApiTooOldError(want, apiVersion)
      return true
    },
    /**
     * 注册一个场景类型。
     * @param {{axis: string, label?: string, parentOf?: (id: string) => string|null, labelOf?: (id: string) => string}} type
     * @returns {() => void} 注销函数（插件卸载时用）
     */
    register(type) {
      const axis = oneLine(type?.axis)
      if (axis === '') throw new Error('场景类型必须有一个 axis')
      if (!/^[a-z][a-z0-9-]*$/u.test(axis)) throw new Error(`场景类型的 axis 只能用英文字母开头的小写词：${axis}`)
      if (types.has(axis)) throw new Error(`场景类型已经注册过：${axis}`)
      const record = {
        axis,
        label: oneLine(type?.label) || axis,
        parentOf: typeof type?.parentOf === 'function' ? type.parentOf : null,
        labelOf: typeof type?.labelOf === 'function' ? type.labelOf : null,
        known: typeof type?.known === 'function' ? type.known : null,
      }
      types.set(axis, record)
      return () => {
        if (types.get(axis) === record) types.delete(axis)
      }
    },
    list() {
      return [...types.values()].map((item) => ({ axis: item.axis, label: item.label }))
    },
    /** 这个 id 属于哪个注册类型（认不出就 null）。 */
    typeOf(id) {
      const axis = oneLine(id).split(':')[0]
      return axis === '' ? null : types.get(axis) ?? null
    },
    /**
     * 父节点：开源包只认识自己那几个轴（owner / work / project / group / chat）；
     * 其余问注册进来的类型，问不到就退回主人层。
     */
    parentOf(id) {
      const type = registry.typeOf(id)
      if (!type) return null
      try {
        const parent = type.parentOf ? type.parentOf(String(id)) : null
        return parent === null || parent === undefined ? null : oneLine(parent)
      } catch {
        return null
      }
    },
    /** 显示名：认不出就退回 id 最后一段。 */
    labelOf(id) {
      const scene = oneLine(id)
      const type = registry.typeOf(scene)
      if (type) {
        if (type.labelOf) {
          try {
            const label = oneLine(type.labelOf(scene))
            if (label !== '') return label
          } catch {
            /* 认不出就走下面的兜底 */
          }
        }
        return type.label
      }
      const parts = scene.split(':')
      return parts[parts.length - 1] || scene
    },
    /** 树里有没有这一层：开源的那几个轴 + 注册进来的类型。 */
    isKnown(id) {
      const scene = oneLine(id)
      if (scene === '') return false
      if (['owner', 'work:general', 'chat'].includes(scene)) return true
      const type = registry.typeOf(scene)
      if (type === null) return false
      if (!type.known) return true
      try {
        return type.known(scene) === true
      } catch {
        return false
      }
    },
  }
  return registry
}

/** 开源包默认的那一个注册表：别的包把类型注册到这儿。 */
export const sceneRegistry = createSceneRegistry()

export { SceneApiTooOldError }
