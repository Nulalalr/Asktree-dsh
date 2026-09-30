/**
 * 宿主侧画布桥：把树仓暴露给浏览器半边。
 *
 * **为什么用 `ctx.connection.rpc`（Cordis 连接层的逻辑 RPC 频道）而不是 Typert `@Remote`：**
 *
 * Typert 是 DSH 官方服务用的机制，但对**第三方包**几乎不可行（已核实）：
 * 1. 客户端代理是**编译期生成**的 `lib/typert.remote-client.js`（生成器
 *    `@deepseek-ai/dsh-typert-generator` 的 `./tsdown` 插件）；
 * 2. 客户端 `@deepseek-ai/dsh-api-remotes/client` **硬编码**挂载 15 个内置 contribution，
 *    第三方产物不会被自动挂载（须自行 `ctx.remote.$mount(...)`）；
 * 3. 生成器要求包位于**拥有 `tsconfig.host.json` 的工作区根的子目录**（monorepo 形状），
 *    扁平的单个包仓库不会产出任何产物；
 * 4. 客户端 bundle 还必须手工包成 `window.__ModuleLoader__.load({id, factory})` 信封，
 *    而该 bundler helper 未随包发布。
 *
 * 而 `ctx.connection.rpc` 是**运行期注册的认证频道**：无需代码生成、无布局约束，
 * 普通 `tsc` 即可构建，安全/信任策略由连接层统一负责（同源 + 浏览器令牌）。
 */
import type { HostContext } from './llm.js'
import type { AnswerRuntime, AskTreeStore } from './store.js'
import { applyMutation } from './store.js'
import type { AskMutation } from './types.js'

/** 画布 RPC 逻辑频道（绝对路径） */
export const RPC_CHANNEL = '/asktree'

/** 连接层的结果信封 */
export type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }

/** `connection.rpc` 最小面 */
interface ConnectionRpcFace {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>,
  ): () => Promise<void>
}

/** 客户端请求载荷 */
interface RpcRequest {
  sessionId?: string | null
  mutation?: AskMutation
}

/** 失败信封 */
function fail(code: string, message: string): RpcResult {
  return { ok: false, error: { code, message, details: {} } }
}

/** 成功信封 */
function succeed(value: unknown): RpcResult {
  return { ok: true, value }
}

/**
 * 注册画布 RPC 频道。
 *
 * @returns 是否注册成功（宿主缺少 `connection` 服务时返回 false：
 *          模型工具仍可用，只是没有 GUI 画布）
 */
export function registerCanvasBridge(
  ctx: HostContext & { effect?: (fn: () => unknown, label?: string) => unknown },
  store: AskTreeStore,
  runtime: AnswerRuntime,
): boolean {
  const connection = ctx.get('connection') as { rpc?: ConnectionRpcFace } | undefined
  const rpc = connection?.rpc
  if (!rpc || typeof rpc.handle !== 'function') return false

  const handler = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult> => {
    const request = (payload ?? {}) as RpcRequest
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : null
    try {
      if (signal.aborted) return fail('aborted', '调用方已取消')
      switch (endpoint) {
        case 'getTree':
          return succeed(store.snapshot(sessionId))

        case 'mutate': {
          if (!request.mutation || typeof request.mutation !== 'object') {
            return fail('bad-request', '缺少 mutation')
          }
          const snapshot = await applyMutation(store.repo(sessionId), request.mutation, runtime)
          return succeed(snapshot)
        }

        default:
          return fail('unknown-endpoint', `未知端点：${endpoint}`)
      }
    } catch (error) {
      // 业务错误（节点不存在、未载入树等）以 ok:false 返回，便于客户端统一提示
      return fail('handler-error', error instanceof Error ? error.message : String(error))
    }
  }

  if (typeof ctx.effect === 'function') ctx.effect(() => rpc.handle(RPC_CHANNEL, handler), 'asktree: canvas rpc channel')
  else void rpc.handle(RPC_CHANNEL, handler)

  return true
}
