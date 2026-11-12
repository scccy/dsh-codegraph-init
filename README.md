# dsh-codegraph-init

把 [codegraph](https://github.com/colbymchenry/codegraph) 的接入流程搬进 DSH 侧栏：在**工作区**的「…」菜单里点一下，装 CLI、写 MCP 接线、写 agent 说明，全过程在一个对话框里流式打日志。

它装的是 npm 上的发布版 `@colbymchenry/codegraph`，与任何本地 fork 无关。

## 为什么需要它

`codegraph install` 原本就有 `dsh` 这个 target，但它只存在于上游仓库 2026-10-30 之后的提交里；npm 上最新的 1.6.2（2026-10-03 发布）还没有。所以在发布版上直接跑 `codegraph install -t dsh` 只会得到 `Unknown target: dsh`。

插件因此分两条路：

1. 用 `codegraph install --print-config dsh` 探测当前 CLI 认不认 `dsh` target——认，就交给上游自己写；
2. 不认，就由插件按上游同样的格式自己写接线：`$DSH_HOME/cordis.patch.yml` 里追加一条 `@deepseek-ai/dsh-mcp-client`，`$DSH_HOME/AGENTS.md` 里追加带标记的说明块。

写出来的 YAML 与上游 `src/installer/targets/dsh.ts` 同形，等上游发版后可以直接换回 CLI，不会出现两份格式。

## 入口

侧栏工作区「…」菜单，落在「在 Finder 中显示」之后、「删除工作区」之前：

- **安装 codegraph**（order 240，带分隔线）
- **卸载 codegraph**（order 250）

两个入口共用同一个对话框；对话框第一次打开时会读一次宿主状态，把 DSH 目录、CLI 版本、当前是否已接线一并列出来，再决定按钮文案。

## 装上插件就已经接好线

装插件这一步本身就是安装：插件首次激活时会自己写接线，不用非得点菜单。

1. 读 `$DSH_HOME` 与所有 profile 的 `cordis.patch.yml`，只要已经存在 `codegraph` 的 MCP 行就**什么都不写**——那条行可能是 CLI 或你自己写的，卸插件时也不会去删别人的东西。
2. `command -v codegraph` 找不到 CLI 就跳过：接线的 `command:` 会指向空，装 CLI 是对话框的活。
3. 都没有才动手：`cordis.patch.yml` 写 MCP 行（`command` 用 CLI 绝对路径），`AGENTS.md` 追加 `<!-- CODEGRAPH_START -->` 块。
4. 卸载/禁用插件时只撤掉**它自己写的那两处**：patch 文件回到 `[]`，`AGENTS.md` 若被清空则整个删除。

关掉这个行为：`DSH_CODEGRAPH_AUTO_WIRE=0`，此后只有侧栏对话框会写接线。

## 安装时发生了什么

从侧栏菜单点「安装 codegraph」走的是完整流程（装 CLI、修复接线、校验）：

1. **检查 CLI**：`command -v codegraph`，找不到就 `npm install -g @colbymchenry/codegraph@latest`。
2. **判断 target**：`codegraph install --print-config dsh` 能通过就走 CLI，否则插件自己写。
3. **写接线**：`cordis.patch.yml` 追加 MCP 客户端条目；`AGENTS.md` 追加 `<!-- CODEGRAPH_START -->` 块。
4. **校验**：重新解析两个文件，确认接线真的落地。

一个刻意的偏离：写进 `command:` 的是**绝对路径**，不是上游那份裸 `codegraph`。从 Finder/桌面图标启动的 DSH 进程，PATH 里通常没有 node bin 目录，裸命令会在 MCP 拉起时直接失败。

## 卸载时发生了什么

1. 先试 `codegraph uninstall -y -l global -t dsh`；
2. 不支持（发布版就是这样）或失败，就由插件精确摘掉自己写的那条 `- insert:` 块和 `AGENTS.md` 里的标记块，其它内容原样保留；
3. 可勾选「同时移除全局 CLI」，跑 `npm uninstall -g @colbymchenry/codegraph`。

**`.codegraph/` 索引不受影响**——那是仓库里的东西，归 `codegraph uninit` 管，不是接线。

## 落盘位置

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/cordis.patch.yml` | MCP 客户端条目（上游同形） |
| `$DSH_HOME/AGENTS.md` | `<!-- CODEGRAPH_START -->` … `<!-- CODEGRAPH_END -->` 说明块 |

接好之后需要**新开一个会话**才生效；如果 `dsh-hmr` 关着，要重启 DSH。MCP 工具名形如 `mcp__codegraph__*`。

## 宿主与客户端

- 宿主半（`lib/index.js`）：一个 `TypertRemoteService`，命名空间 `codegraphInstall`，方法 `status` / `start` / `poll` / `cancel` / `forget`。运行日志放在内存环形缓冲里（上限 4000 行），客户端按游标 `poll` 增量取，同一时刻只允许一个 run。
- 客户端半（`lib/client.js`）：只依赖 `react`，不 import 任何 Harness 客户端包；样式全部走 `--dsw-alias-*` token 自绘，跟随主题。

## 开发注记

从本地目录 `link:` 装进 profile 时，裸 import `@deepseek-ai/dsh-typert-protocol` 会失败：DSH 只对**位于 profile 目录内**的模块做 `@deepseek-ai/*` 路由，软链到别处的包会退化成普通 Node 解析。`lib/index.js` 顶部的 `importTypertProtocol()` 因此带一条兜底：从 `DSH_INSTALL_DIR` 和 `process.argv` 推断安装目录，直接按文件 URL 加载同一个包。npm 安装的正常形态走不到这条兜底。

## 许可

MIT。
