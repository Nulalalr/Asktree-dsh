# 打包与安装（INSTALL.md）

本仓库提供两种形态：

| 形态 | 位置 | 特点 |
|---|---|---|
| **可安装插件**（推荐） | `src/*.ts` → 构建为 `lib/` | npm 包形态，挂进宿主组合；**重启不丢、免逐次授权** |
| **动态插件**（源码参考） | `host.js` / `client.js` | 贴进 DSH 会话的 `cordis_define` 即用；进程重启即失效，需重新定义 + 授权 |

---

## 一、工程结构

```
src/
├── index.ts          宿主入口：注册 5 个工具 + 建仓 + 挂画布 RPC 频道
├── client.ts         客户端入口：具名导出 apply/inject；画布浮层 + 会话头/输入框入口
├── tools.ts          5 个模型工具的 defineTool 定义（扁平参数 DSL）
├── store.ts          按会话隔离的树仓 + 变更应用
├── llm.ts            走宿主 llm 服务的回答生成（不含任何密钥）
├── share.ts          分享链接抓取（web.fetch → shell curl → 代理兜底）
├── remote-host.ts    宿主侧画布桥：connection.rpc 频道 /asktree
├── remote-client.ts  客户端侧画布桥：connection.rpc.call
├── tree.ts / parse.ts / markdown.ts / layout.ts / css.ts / bridge.ts / types.ts
scripts/
└── build-client.mjs  用 esbuild 生成 DSH 要求的 window.__ModuleLoader__ 信封
```

## 二、构建与自检

```bash
npm install          # 需要能访问 npm（或已在 DSH 部署的 workspace 内）
npm run typecheck    # 类型检查（对真实的 @deepseek-ai/dsh-tools 类型）
npm run build        # tsc -> lib/*.js + lib/types/*.d.ts，再生成 lib/client.js
```

产物：`lib/index.js`（宿主）、`lib/client.js`（客户端 bundle）、`lib/types/**`（声明）。

> **客户端 bundle 不是普通 ESM**：DSH 客户端模块必须包在
> `window.__ModuleLoader__.load({ id, factory })` 信封里，并**具名导出** `apply` / `inject`
> （见 `dsh-client-ui-cordis/lib/client.js` 的 `exports.apply = apply`）。
> 该信封由 DSH monorepo 内部的 `clientBundle()` helper 生成、**未随包发布**，
> 所以 `scripts/build-client.mjs` 用 esbuild 自行拼装（`react` 等走平台冻结的 external 表）。
> 客户端源码一改动就要重新 `npm run build`，否则宿主启动会报
> `MissingClientBundleError`（"client bundle not found; run `pnpm run build` before launch"）。

## 三、安装到本机 DSH

DSH 官方支持 profile 级的外挂插件（外挂包装在 profile 自己的 `node_modules` 里）：

```powershell
# 1. 装进 profile（DSH_PROFILE=desktop）
dsh plugin --profile desktop add <本仓库路径 | tarball | git URL>
#    等价于在 C:\Users\ASUS\.dsh\profiles\desktop 下执行 pnpm add ...

# 2. 在该 profile 的 cordis.patch.yml 追加一行
#    - id: asktree
#      name: "asktree-dsh"

# 3. 重启 DSH 使组合生效
```

## 四、画布桥的实现选择（关键设计说明）

宿主与浏览器是两个进程，画布必须跨进程读写树仓。DSH 里可用的通道有三种，本插件选第 3 种：

| 方案 | 结论 |
|---|---|
| **Typert `@Remote` 远程服务**（DSH 官方服务所用） | ❌ 第三方包基本不可行，四条硬约束：① 客户端代理是**编译期生成**的 `lib/typert.remote-client.js`（生成器 `@deepseek-ai/dsh-typert-generator` 的 `./tsdown` 插件）；② 客户端 `@deepseek-ai/dsh-api-remotes/client` **硬编码挂载 15 个内置 contribution**，第三方产物不会自动挂载，必须自行 `ctx.remote.$mount(...)`；③ 生成器要求包位于**拥有 `tsconfig.host.json` 的工作区根的子目录**（monorepo 形状），扁平的单个包仓库**不产出任何产物**；④ 客户端 bundle 仍需自行拼装 `__ModuleLoader__` 信封 |
| 宿主 `webServer.register({kind:'exact', path, handler})` 裸路由 | ⚠️ 可用，但要自己处理信任/鉴权，且与 DSH 连接层的策略脱节 |
| **`ctx.connection.rpc`（连接层逻辑 RPC 频道）** ✅ 本插件采用 | 运行期注册认证频道：`ctx.connection.rpc.handle('/asktree', handler)` + 客户端 `ctx.connection.rpc.call('/asktree', endpoint, payload)`。**无需代码生成、无布局约束**，信任/来源/浏览器令牌由 `dsh-client-connection` 统一负责 |

契约（已对照 `dsh-client-connection/lib/types/rpc.d.ts`）：

```ts
// 宿主
ctx.connection.rpc.handle(
  '/asktree',
  async (endpoint, payload, signal) => ({ ok: true, value }) // 或 { ok:false, error:{code,message,details} }
): Promise<() => Promise<void>>
// 客户端
await ctx.connection.rpc.call('/asktree', 'getTree', { sessionId })
// => { ok: true, value } | { ok: false, error: { code, message, details } }
```

若将来要改为官方 Typert 机制，只需替换 `src/remote-host.ts` 与 `src/remote-client.ts`——
`src/client.ts` 只依赖 `src/bridge.ts` 的接口。

## 五、已知限制

- `asktree_import_share` 依赖宿主挂载 `web` fetch provider（如 `@deepseek-ai/dsh-web-fetch-http`）或允许 shell 出网；受限沙箱内会降级到 `asktree_parse_chat`（丢失并列分支）。
- 树仓是**进程内内存**（按会话隔离）；跨重启持久化需接入 storage/session 存储（后续项）。
- `dsh.client.inject` 是**信息性的包依赖顺序声明**（不是 Cordis 服务注入）；模块级 Cordis `inject` 才是服务依赖（本插件为 `['slots','connection']`）。
- 若你的部署里 `/asktree` 频道名已被占用，改 `RPC_CHANNEL` 常量（两处需一致）。
