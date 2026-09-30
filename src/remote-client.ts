/**
 * 客户端侧画布桥：经连接层的逻辑 RPC 频道调用宿主。
 *
 * 与 `src/remote-host.ts` 的 `/asktree` 频道配对；两者共同实现 `AskBridge`。
 * 不使用 Typert 远程服务，因此无需编译期代码生成（详见 remote-host.ts 的说明）。
 */
import type { AskBridge, MutateResult } from './bridge.js'
import type { AskMutation, AskSnapshot } from './types.js'

/** 与宿主约定一致的频道名 */
export const RPC_CHANNEL = '/asktree'

/** 连接层的结果信封 */
type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: object } }

/** `connection.rpc` 客户端最小面 */
interface ClientConnectionRpcFace {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult>
}

/** 客户端上下文最小面 */
export interface ClientContextLike {
  get(name: string): unknown
}

/**
 * 从客户端上下文解析 `connection.rpc`。
 * @throws 宿主/客户端未挂载连接层时抛出可读错误
 */
function connectionRpc(ctx: ClientContextLike): ClientConnectionRpcFace {
  const connection = ctx.get('connection') as { rpc?: ClientConnectionRpcFace } | undefined
  const rpc = connection?.rpc
  if (!rpc || typeof rpc.call !== 'function') {
    throw new Error('未找到 connection.rpc：AskTree 画布需要 DSH 连接层（@deepseek-ai/dsh-client-connection）')
  }
  return rpc
}

/**
 * 创建基于连接层 RPC 的画布桥。
 *
 * @param ctx 客户端插件上下文（用于取 `connection` 服务）
 * @param signal 可选的调用方取消信号
 */
export function createCanvasBridge(ctx: ClientContextLike, signal?: AbortSignal): AskBridge {
  return {
    async getTree(sessionId: string | null): Promise<AskSnapshot | null> {
      const result = await connectionRpc(ctx).call(RPC_CHANNEL, 'getTree', { sessionId }, signal)
      if (!result.ok) throw new Error(result.error.message)
      return (result.value ?? null) as AskSnapshot | null
    },

    async mutate(sessionId: string | null, mutation: AskMutation): Promise<MutateResult> {
      const result = await connectionRpc(ctx).call(RPC_CHANNEL, 'mutate', { sessionId, mutation }, signal)
      if (!result.ok) return { ok: false, reason: result.error.message }
      return { ok: true, ...(result.value as AskSnapshot) }
    },
  }
}
