# AskTree × DeepSeek Harness 动态插件

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-blue)](https://polyformproject.org/licenses/noncommercial/1.0.0)

把「树形问答」搬进 DeepSeek Harness（DSH）：**5 个模型工具** + **GUI 交互画布**，数据双向打通。

- 本仓库为**原创项目**：作者先创作了单文件树形问答网页 AskTree，再在其上为 DeepSeek Harness 做 DSH 插件适配。许可见 [LICENSE](./LICENSE)（PolyForm Noncommercial 1.0.0，**禁止商用**）。
- 实现为 DSH 的**动态 Cordis 插件**（进程内运行，非 npm 包；如需可安装的插件包形态，见文末「升级为可安装插件包」）。

## 功能一览

### 5 个模型工具（Agent 可调用）

| 工具 | 作用 | 对应 AskTree 逻辑 |
|---|---|---|
| `asktree_import_share` | DeepSeek 分享链接 → 问答树 JSON，**还原并列分支**（parent_id 语义） | `buildTreeFromMessages` + `fetchShare` |
| `asktree_parse_chat` | 粘贴正文 → 问答轮次 + 线性树（依赖「本回答由 AI 生成」结尾标记） | `parseChatTurns` / `splitQA` / `genericTurns` |
| `asktree_show` | 把任意 `{nodes, rootId}` 树推送到 GUI 画布 | — |
| `asktree_build_context` | 取「节点→根」祖先链拼 messages，不含兄弟分支（省 token、分支记忆不串线） | `buildContext` |
| `asktree_answer` | 基于祖先链上下文生成回答（走宿主 llm 路由，默认当前模型） | `generateAnswer` + `callApi` |

### GUI 画布（Client）

- 会话头「**Asktree**」按钮 → `shell.overlay` 浮层
- AskTree 完整交互：**虚线连线、水平/垂直/自由三种布局、Ctrl+滚轮缩放、平移、双击复位、适配、折叠、拖拽、点选编辑（问题/回答 + Markdown 预览）、＋加子问题（自动回答）、⟳ 重新回答、删除子树**
- **按当前对话隔离**：每个会话一棵树——在 Asktree 里与 AI 交互、关闭重开保持同一棵树；新建对话从空开始；切换对话各自独立（跨会话关联语义为未来计划）
- 与 Host 树仓双向同步：导入/解析/推送的树自动进当前会话的画布（打开时 1.5s 轮询或手动 ⟳）；画布编辑写回宿主，与工具共享同一棵树

## 快速上手（在 DSH 会话中）

1. 在会话里用 `cordis_define` 新建插件（idPrefix 建议 `askt`）：
   - `code.host` ← 粘贴 [`host.js`](./host.js) 全文（去掉文件头注释）
   - `code.client` ← 粘贴 [`client.js`](./client.js) 全文（去掉文件头注释）
2. `cordis_run` 激活。首次含 Client 的版本需要**在 GUI 里点一次授权**。
3. 会话标题栏出现「树」按钮 → 点开即可看到画布。
4. 让 Agent 运行 `asktree_import_share` / `asktree_parse_chat` / `asktree_show` 灌入内容。

> 动态插件是进程内、会话级、生命周期内存——重启进程即失效，重新 define 即可。持久化部署请走文末形态。

## 数据模型

```js
// 节点（与 AskTree node schema 对齐）
{ id, text, answer, parentId, children: [id...] }
// 树
{ nodes: { [id]: node }, rootId }
```

## 已知限制

- `asktree_import_share` 依赖宿主挂载 **`web` fetch provider**（如 `@deepseek-ai/dsh-web-fetch-http`）或允许 shell 出网；沙箱拦截 HTTPS 的环境（如部分 Windows 受限沙箱）会优雅报错并引导走 `asktree_parse_chat`（该通道**会丢失并列分支**，只重建线性链）。
- 回答走宿主 llm 路由（`llm.stream`），**密钥由宿主配置持有，插件代码不含任何密钥**。
- Client 无 `document/window` 全局，全部 UI 用 `React.createElement` 构建（已按此约束实现）。

## 结构

```
asktree-dsh-plugin/
├── host.js      # code.host：工具 + 树仓 + getTree/mutate RPC
├── client.js    # code.client：画布浮层 + 会话头开关
└── README.md
```

## 升级为可安装插件包

如需让任何 DSH 部署可安装（npm 包 + 宿主 `cordis.yml` 挂一行），可在此基础上封装：
- `package.json`（`main` 导出含 `apply(ctx)` 的 Cordis 插件，把 host.js 内容包成模块）
- Client 侧按 DSH web 插件表（`dsh.client` 扫描 + 组合）接入
- 在部署的 host 组合 `cordis.yml` 增加该插件行（参考 `@deepseek-ai/dsh-tool-web` 的挂载方式）

## 许可

本项目为**作者原创**，采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)：

- **允许**：非商业使用——个人研究、学习、实验、教学、公益组织与教育机构等（详见协议 Personal Uses / Noncommercial Organizations 条款）
- **禁止**：一切**商用**（以盈利为目的的使用或活动）；商用需另行获得作者书面授权
- 附赠版权与专利授权，但**不提供任何担保与责任**（No Liability）

> 提醒：非商业许可是「许可限制」而非「防盗」。代码公开可下载，协议提供的是他人违反时你追究责任的法律依据。
