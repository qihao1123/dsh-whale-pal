# dsh-whale-pal

给 DSH（DeepSeek Harness）的插件：让一个**有名字、有记忆、有边界**的助手常驻在会话里，而不是每开一个会话都从零认识你。

装进一个 profile 就生效。没有第三方依赖，不联网，代码全在这个仓库里。

## 它做什么

- **人格内核**：名称、称呼、自称、底色、价值观、边界、说话风格——十项，写在系统提示词最前面。名字不预设，没填时用占位名「鲸鲸」，设置页会提示去填；填了就一直用，清空回到占位名。
- **模式段**：按会话所在目录切「鲸鲸模式 / 助手模式」，两套口气、两套注入内容，同一个插件。
- **记忆与台账**：你说过的事实、偏好、未完成的事跨会话带着；台账只追加——结论过期不改老行，另起一条「纠正」。
- **上下文压缩档案**：DSH 自动压缩时把被压掉的那一段存成一张卡，压完还能按编号把原文取回来。
- **压缩后仍超阈值，就自己开一个新会话**：助手模式递一张交接条接着干，鲸鲸模式干净开。
- **一张设置页 + 一组 `/whale` 命令 + 9 个工具**，改人格、换笔记库、查档案都在里面。

## 安装

需要：DSH 桌面版（Cordis 插件接口）、Node.js ≥ 22、一个 profile。

**1. 把包装进 profile 的 `node_modules`**

```bash
npm i dsh-whale-pal
```

本地开发想改一次看一眼，用 junction 把仓库链进 `node_modules` 也一样。

**2. 在 profile 的 `cordis.patch.yml` 里挂上**

包自带 patch（`cordis.patch.yml`），`insert` 一条即可：

```yaml
- insert:
    - id: dsh-whale-pal
      name: dsh-whale-pal
```

**3. 重启 DSH**

`index.js`、`lib/host.js`、`lib/settings.js`、`lib/mode.js`、`lib/ledger/*`、`lib/ctx/*` 都是宿主侧代码，改完必须重启。只有 `lib/client.js`（设置页那一段）是浏览器每次加载重读的，刷新页面就行。

装完 Web GUI 里会多出这张设置页；它自己的通道在 `/api/whale-pal`（`/health`、`/status` 都走这里）。

## 五分钟上手

1. **填人格卡。** 设置页十项，能从一段文字里「拆一下」自动填；空白照收，清空就是回默认。
2. **选一个目录当「鲸鲸」的地盘。** `/whale bind` 把当前目录加进名单——在里面开会话就是鲸鲸模式，别处是助手模式。
3. **看一眼解析结果。** `/whale mode` 告诉你当前目录算哪边、名单里有谁。

## 它往会话里放什么

`inject`：`systemPrompt, webServer, commands, tools, workspaceController`。

系统提示词按顺序拼：人格内核 → `【模式】` → `【本轮状态】`（记得 / 一直记着 / 答应过 / 未完成）→ `【处理流程】`进度点 → 上下文档案目录。

模式按**会话当前目录**判，严格相等，子目录不算同一个；会话里 `cd` 走了，下一回合模式就跟着变。

## 命令与工具

| 命令 | 干什么 |
| --- | --- |
| `/whale mode` | 看当前目录算哪个模式、名单里有谁 |
| `/whale bind` / `unbind` | 把工作区加进 / 移出鲸鲸名单 |
| `/whale new` | 立刻开一个新会话（助手模式带交接条） |
| `/whale ctx search\|read\|files\|batch\|entries\|sync` | 查上下文档案 |
| `/whale ctx rollback B00x` | 退一批压缩档案，只挪不删（挪进 `_上下文/回收站/`） |
| `/whale import rollback\|undo` | 回滚 / 撤销旧状态导入 |

工具 9 个：`whale_ctx`、`whale_pal_identity`、`whale_pal_memory`、`whale_pal_ledger`、`whale_pal_progress`、`whale_pal_health`、`whale_pal_open`、`whale_pal_rollback`、`whale_pal_upgrade`。

## 数据在哪

| 东西 | 位置 |
| --- | --- |
| 配置 | `~/.dsh/whale-pal/<profile>/config.json`（`bot_name`、`identity`、`whaleWorkspaces`、`knowledge`、`obsidian`） |
| 状态 | 同目录 `state.json`（自称/称呼、记忆、约定、未完成的事） |
| 处理流程进度 | 同目录 `progress.json` |
| 人格状态快照 | 同目录 `snapshots/`，留最近 20 份 |
| 导入前的世界 | `~/.dsh/whale-pal/import-snapshots/<profile>/` |
| 台账与上下文档案 | 你的笔记库里：`台账/`、`_上下文/` |
| 备份 | 同目录 `.bak-<时间戳>` 留最近 10 份；更旧的挪进 `.bak-archive/`，每个文件在归档里留最近 20 份 |

插件只碰笔记库里自己那两块（`台账/`、`_上下文/`）。人的笔记、项目规划、`.obsidian` 一概不动；换库只复制，不删源。

改错了能退：`whale_pal_rollback` 把一个文件退回最新 `.bak`；`/whale ctx rollback B00x` 退一整批压缩档案。

## 换库

设置页改笔记库路径时，默认把 `台账/` 和 `_上下文/` 复制到新库，先整份复制到临时目录、逐文件比 sha256、全过了才改名落地，然后才写配置。

**配置是提交点**：它之前的每一步失败都整单退（状态退回原样、新库副本撤掉），旧库照旧用。唯一剩下的局面是「配置没写成、写状态也退不回去」——两次写盘都炸——这时会如实告诉你「重存一次就能对齐」，不假装干净。

## 压不动的时候会自己开新会话

自动压缩跑完，下一轮复检**仍超触发点**，说明这次压缩没吃到收益。这时插件不再只劝人开新会话，而是自己开一个：

- 新会话按**同一目录、同一预设**建，Web GUI 里看得见，并且**挂回老会话所在的工作区**（不然侧栏会把它放进「未分组」）。
- **助手模式**带交接条（旧会话编号、当前目录、未完成的事、档案目录），接着干。
- **鲸鲸模式**干净开，不带交接条——聊天不该被一张机器写的纸条打断。
- 旧会话里说一句「已切到新会话 <id>」就停手，自动压缩保持停用，不会再开第二个。
- 开不成都照实说（服务没挂、宿主拒了、交接条递不进去、没归到工作区），不假装开了。

手动想开一个：`/whale new`。

## 验证

```bash
node scripts/verify.mjs     # 语法 + 导入契约 + 单测
```

最近一次：**909 条测试（59 个文件）全通过、65 个文件语法通过、`inject` 契约一致**，Node.js 22 与 24 各跑一遍都是这个数，CI 也是这两档矩阵。

换会话那条路 2026-11-12 在真机上验过手动入口（`/whale new`：会话建出来、交接条递进去、落进同一工作区）；自动入口的**触发条件**真机造不出来（要等真压完还超），但触发之后每一步都被测试盖着。

复制目录不用 `fs.cpSync`：node 22 在 Windows 上 `cpSync(…, {recursive:true})` 会把进程直接打死（0xC0000409，没有异常可 catch），换库和导入回滚正好都走它。所以 `lib/atomic.js` 里的 `copyTree` 自己 walk 一遍，两个版本都验过。

## 已知边界

- **`minimal` 预设下这套等于不存在。** `@deepseek-ai/dsh-persona` 配 `complete: true` 时，它那一段就是完整系统提示词，插件注入的段全部被盖掉——人格、模式、记忆、进度点一个都不进。更坑的是 `whale_pal_health` 照样回 `normal`：**插件挂载了 ≠ 提示词进去了**。验插件别用 `minimal`。
- 「压完仍超就自己开新会话」能验的都验了：判据（`acted='switch'`）、接线层开成/开不成两半、手动入口真机跑通。**没验的只剩「宿主的真实读数会不会出现压完仍超」**——那是环境，不是代码。
- `workspaceController` 的「服务缺席」路径只有单测盖过，真机上造不出这个场面——算测过，不算真机验过。
- 模式按目录判，不跟 `session.header.cwd` 走。
- **平台**：只在 Windows + DSH 桌面版（profile `desktop`）上验过。Linux / macOS 没验过，路径处理和文件锁可能是另一套。
- 旧插件 `dsh-persona-framework` 还挂在 profile 里时，本插件**拒绝启动**——两套人格同时注入会当场分叉，这不是 bug 是护栏。

## 许可

MIT，见 [LICENSE](LICENSE)。
