/**
 * 宿主半边（插件入口，`exports["."]`）：
 *
 * - 注册 5 个模型可见工具（`ctx.tools.register`）
 * - 维护**按会话隔离**的内存树仓
 * - 通过宿主 web 路由暴露画布 RPC（见 `src/remote-host.ts`）
 *
 * 回答生成走宿主 `llm` 服务（provider/model 取当前默认模型选择），
 * 因此插件代码里**不含任何 API Key / 凭据**。
 */
import type { HostContext } from './llm.js'
import { createAnswerRuntime } from './llm.js'
import { registerCanvasBridge } from './remote-host.js'
import { AskTreeStore } from './store.js'
import { createTools } from './tools.js'

/** 插件名（cordis 用） */
export const name = 'asktree'

/** 硬依赖：工具注册表（`ctx.tools`） */
export const inject = ['tools']

/** 宿主上下文最小面（避免绑死 DSH 类型版本，便于独立构建） */
export interface HostPluginContext extends HostContext {
  tools: {
    register(definition: unknown): () => void
  }
  effect?(callback: () => unknown, label?: string): unknown
}

/**
 * 插件入口。
 *
 * 装配顺序：先建仓与运行时，再注册工具，最后挂画布桥；
 * 任何一步失败都不影响其余部分（例如没有 webServer 时工具照常可用）。
 */
export function apply(ctx: HostPluginContext): void {
  const store = new AskTreeStore()
  const answerRuntime = createAnswerRuntime(ctx)

  // 1) 5 个工具
  for (const tool of createTools({ ctx, store })) {
    ctx.effect?.(() => ctx.tools.register(tool), `asktree: tool ${tool.name}`)
  }

  // 2) 画布桥（可选：宿主未挂载 webServer 时降级为「只有工具、没有画布」）
  const bridged = registerCanvasBridge(ctx, store, answerRuntime)
  if (!bridged) {
    console.warn('[asktree] 宿主未提供 webServer 服务：GUI 画布不可用（模型工具仍可用）')
  }
}

export default { name, inject, apply }
