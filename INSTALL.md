# 打包为可安装插件（INSTALL.md）

本文档说明如何把本仓库的**动态插件**（`host.js` / `client.js`，随会话/进程走、重启即丢）改造成 **DSH 可安装插件**（npm 包、挂进宿主组合、重启不丢、免逐次授权）。

> 状态：骨架与步骤已按 DSH 真实机制核实；**含 TypeScript + Typert 构建的最终实现**仍需在具备构建工具链的环境完成（本仓库当前提供的是动态插件的纯 JS 源码）。

## 一、已核实的关键事实（决定打包方式）

1. **部署组合**：本机 `DSH_PROFILE=desktop`，宿主组合在 `C:\Users\ASUS\.dsh\profiles\desktop\`：
   - `package.json` 里 `dsh.profile.bundles` 列出基础 bundle；
   - `cordis.patch.yml` 是用户补丁层（按 `{id, name, config}` 追加插件行）。
2. **真实插件包**（对照动态插件）：
   | 动态插件（本仓库现状） | 真实插件（目标形态） |
   |---|---|
   | `harness.defineTool` + `harness.registerTool` | `ctx.tools.register(defineTool({...}))`，`defineTool` 来自 `@deepseek-ai/dsh-tools` |
   | `harness.handle` + `host.call` | **Typert `@Remote` 远程服务**（`@deepseek-ai/dsh-api-remotes` 客户端 + 宿主 `@Remote` 方法，编译期生成 `typert.remote-client.js`） |
   | 客户端 `styles.insert` / `slots.inject/register` | 相同（`ctx.get('slots')`、`ctx.get('styles')` 真实服务） |
3. **`defineTool` 的 `parameters` 是「扁平属性 map」**，不是 JSON-Schema 包装。例如动态版的
   ```js
   parameters: { type:"object", properties:{ source:{type:"string"} }, required:["source"] }
   ```
   要改成
   ```js
   parameters: { source: { type: "string", required: true, description: "..." } }
   ```
   `output.schema` 保持 `{ type:"object", additionalProperties:true }` 即可。
4. **客户端声明**（`package.json` 的 `dsh` 字段）：
   ```json
   "dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-connection", "..."], "platform": "web" } }
   ```
   且 `exports["./client"]` 指向客户端入口（参考 `@deepseek-ai/dsh-client-ui-cordis`）。

## 二、改造步骤

1. **建 TypeScript 工程**（建议 `src/host.ts` + `src/client.ts`），把 `host.js`/`client.js` 的纯逻辑原样搬运：
   - 解析/导入/上下文拼装/回答这些**纯函数**直接搬；
   - 工具注册改用 `defineTool` 的扁平 `parameters`（见上表）；
   - RPC 改为宿主 `@Remote` 服务 + 客户端 `ctx.remote.xxx.yyy()`（Typert 编译生成）。
2. **构建**：`pnpm build`（用 `tsdown` + Typert，参考 `dsh-tool-web`/`dsh-client-ui-cordis` 的 `scripts.bundle`）。
3. **安装到本机**：
   ```powershell
   cd C:\Users\ASUS\.dsh\profiles\desktop
   pnpm add <你的包名>
   ```
   然后在 `cordis.patch.yml` 追加一行（或加入 `package.json` 的 `dsh.profile.bundles`）：
   ```yaml
   - id: asktree
     name: "<你的包名>"
   ```
4. **重启 DSH** 使组合生效。

## 三、已知限制（沿用动态版）

- `asktree_import_share` 依赖宿主挂载 `web` fetch provider（如 `@deepseek-ai/dsh-web-fetch-http`）或允许 shell 出网；受限沙箱内会降级到 `asktree_parse_chat`。
- 树仓为进程内内存；如需跨重启持久化，需额外接入 storage/session 存储（后续项）。
