/**
 * 宿主侧 LLM 适配：把「祖先链上下文」发给宿主已配置的模型路由。
 *
 * 与动态插件版一致：**不接收 API Key**，走宿主 `llm` 服务
 * （provider/model 缺省取当前默认模型选择），因此插件代码里没有凭据。
 */
import { buildContext, SYSTEM_PROMPT } from './tree.js'
import type { AnswerRuntime } from './store.js'
import type { AskTree, ChatLine } from './types.js'

/** 会话默认模型选择的读取面 */
interface DefaultModelFace {
  currentSelection(): { provider?: string; model?: string } | undefined
}

/** provider 目录（用于兜底挑选） */
interface LlmProviderInfo {
  id: string
}

/** 流式分片（只声明用得到的字段） */
interface StreamChunk {
  type: string
  text?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  reason?: { kind?: string; failure?: { message?: string; code?: string } }
}

/** `llm` 服务的最小面 */
interface LlmFace {
  stream(options: Record<string, unknown>): AsyncIterable<StreamChunk>
  listProviders?(): LlmProviderInfo[]
}

/** 取服务上下文的最小面 */
export interface HostContext {
  get(name: string): unknown
}

/** 解析出的调用路由 */
export interface Route {
  llm: LlmFace
  provider: string
  model: string
}

/** 回答生成参数（与 AskTree 网页版默认值一致） */
export interface AnswerOptions {
  temperature: number
  maxTokens: number
  system: string
}

/** 默认回答参数 */
export const DEFAULT_ANSWER_OPTIONS: AnswerOptions = {
  temperature: 0.6,
  maxTokens: 900,
  system: SYSTEM_PROMPT,
}

/**
 * 解析本次调用的 provider / model。
 * 优先级：显式入参 > 当前默认模型选择 > provider 目录里带 "deepseek" 的第一个 > 目录第一个。
 */
export function resolveRoute(ctx: HostContext, providerArg?: string, modelArg?: string): Route {
  const llm = ctx.get('llm') as LlmFace | undefined
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主未提供 llm 服务，无法生成回答')

  let provider = providerArg && providerArg.trim() ? providerArg.trim() : null
  let model = modelArg && modelArg.trim() ? modelArg.trim() : null

  const defaults = ctx.get('agentDefaultModel') as DefaultModelFace | undefined
  if (defaults && typeof defaults.currentSelection === 'function') {
    try {
      const selection = defaults.currentSelection()
      if (selection) {
        if (!provider && selection.provider) provider = String(selection.provider)
        if (!model && selection.model) model = String(selection.model)
      }
    } catch {
      /* 未配置默认模型时忽略 */
    }
  }

  if (!provider && typeof llm.listProviders === 'function') {
    try {
      const providers = llm.listProviders() || []
      const deepseek = providers.find((p) => /deepseek/i.test(String(p.id)))
      if (deepseek) provider = String(deepseek.id)
      else if (providers.length) provider = String(providers[0].id)
    } catch {
      /* 目录不可用时保持 null */
    }
  }

  if (!provider) throw new Error('无法确定 provider：请显式指定，或确认宿主已配置 LLM 提供方')
  if (!model) throw new Error('无法确定 model：请显式指定，或确认宿主已配置默认模型')
  return { llm, provider, model }
}

/**
 * 把对话消息转成宿主 `llm` 服务要求的 wire 形态。
 *
 * 两个硬性要求（动态插件版实测所得，务必保留）：
 * 1. `content` 必须是 `[{ type: 'text', text }]` 块数组；
 * 2. `assistant` 消息必须带 `source`，否则 runtime 读取 `source.kind` 会抛错。
 */
export function toWireMessages(
  messages: readonly ChatLine[],
  route: { provider: string; model: string },
): Record<string, unknown>[] {
  return messages.map((m) => ({
    role: m.role,
    content: [{ type: 'text', text: String(m.content) }],
    ...(m.role === 'assistant' ? { source: { kind: 'model', provider: route.provider, model: route.model } } : {}),
  }))
}

/** 流式调用一次模型，聚合出完整文本 */
export async function streamAnswer(
  route: Route,
  messages: readonly ChatLine[],
  system: string,
  temperature: number,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  let text = ''
  let failure: string | null = null

  for await (const chunk of route.llm.stream({
    provider: route.provider,
    model: route.model,
    messages: toWireMessages(messages, route),
    system,
    temperature,
    maxTokens,
    signal,
  })) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
      failure = chunk.reason.failure?.message || chunk.reason.failure?.code || '模型调用失败'
    }
  }

  if (failure) throw new Error(failure)
  if (!text) throw new Error('模型返回为空（可能是 maxTokens 过小或上下文过长）')
  return text
}

/**
 * 生成某个节点的回答：只带「该节点 -> 根」的祖先链上下文（不含兄弟分支）。
 */
export async function answerNode(
  ctx: HostContext,
  tree: AskTree,
  nodeId: string,
  options: Partial<AnswerOptions> & { provider?: string; model?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const context = buildContext(tree, nodeId, options.system ?? DEFAULT_ANSWER_OPTIONS.system)
  const route = resolveRoute(ctx, options.provider, options.model)
  return streamAnswer(
    route,
    context.messages,
    context.system,
    options.temperature ?? DEFAULT_ANSWER_OPTIONS.temperature,
    options.maxTokens ?? DEFAULT_ANSWER_OPTIONS.maxTokens,
    options.signal,
  )
}

/** 构造树仓需要的回答运行时（把 llm 服务包成 `AnswerRuntime`） */
export function createAnswerRuntime(
  ctx: HostContext,
  overrides: { provider?: string; model?: string } = {},
): AnswerRuntime {
  return {
    answer(tree: AskTree, nodeId: string) {
      return answerNode(ctx, tree, nodeId, overrides)
    },
  }
}
