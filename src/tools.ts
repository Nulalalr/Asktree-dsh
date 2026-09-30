/**
 * 5 个模型可见工具的定义（真实插件形态）。
 *
 * 与动态插件版的三处关键差异：
 * 1. `parameters` 用 `defineTool` 的**扁平属性 map**（每项 `required: true`），
 *    不再是 `{type:'object', properties, required:[]}` 的 JSON-Schema 包装；
 * 2. 工具注册走 `ctx.tools.register(...)`（由宿主半边完成）；
 * 3. 会话 id 从 `exec.agent.session.id` 取（动态版也是这么做的）。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { HostContext } from './llm.js'
import { resolveRoute, streamAnswer } from './llm.js'
import { extractShareId, isMarkerText, parseChatTurns } from './parse.js'
import { fetchShareData } from './share.js'
import type { AskTreeStore } from './store.js'
import { snapshotOf } from './store.js'
import { buildContext, buildTreeFromMessages, linearTreeFromTurns, SYSTEM_PROMPT } from './tree.js'
import type { AskTree, ChatLine, ShareMessage } from './types.js'

/** 工具 execute 的第二参数（只声明用到的字段，避免绑死 DSH 类型版本） */
export interface ToolRunContext {
  signal?: AbortSignal
  agent?: { session?: { id?: string } }
}

/** 工具依赖 */
export interface ToolDeps {
  ctx: HostContext
  store: AskTreeStore
}

/** 从执行上下文解析当前会话 id */
function sessionIdOf(exec: ToolRunContext | undefined): string | null {
  const id = exec?.agent?.session?.id
  return id ? String(id) : null
}

/** 统一的 JSON 文本渲染（工具结果给模型看的形态） */
const jsonOutput = (): {
  schema: { type: 'object'; additionalProperties: true }
  render: (args: unknown, value: unknown) => { type: 'text'; text: string }[]
} => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

/**
 * 工具返回值必须是纯 JSON 对象（`defineTool` 要求 `Record<string, JsonValue>`）。
 * 这里的领域类型（AskNode/AskTree/…）在运行时就是普通 JSON，
 * 但接口类型没有索引签名，故显式收敛一次。
 */
function asJson(value: object): Record<string, never> {
  return value as unknown as Record<string, never>
}

/** 把 `asktree_answer` 的返回值渲染为「回答正文优先」的文本 */
function answerRender(value: { provider?: string; model?: string; answer?: string }): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: `【asktree_answer】${value.provider}/${value.model}\n\n${value.answer ?? ''}` }]
}

/** 构造 5 个工具定义 */
export function createTools(deps: ToolDeps): ReturnType<typeof defineTool>[] {
  const { ctx, store } = deps

  const importShare = defineTool({
    name: 'asktree_import_share',
    description:
      '从 DeepSeek 分享链接（或 share_id）抓取对话并重建为「问答树」JSON，能还原网页对话中同一处发散出的并列追问（父问题 → 多个并列子问题）。' +
      '返回 { ok, title, via, rootId, count, nodeCount, nodes }：nodes 为 { id: { id, text, answer, parentId, children[] } } 的扁平结构，' +
      '可直接喂给 asktree_build_context / asktree_answer，并会自动同步到当前会话的 GUI 画布。' +
      '直连失败时经 api.allorigins.win 第三方代理兜底（内容会经该代理中转）。' +
      '注意：本工具依赖宿主挂载 web fetch provider 或允许 shell 出网；两者都不可用时请改用手动粘贴正文走 asktree_parse_chat。',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'DeepSeek 分享链接（https://chat.deepseek.com/share/xxxx）或纯 share_id',
      },
    },
    output: jsonOutput(),
    async execute(args: unknown, exec: ToolRunContext) {
      const { source } = args as { source?: string }
      const input = (source || '').trim()
      if (!input) throw new Error('缺少 source：请传入 DeepSeek 分享链接或 share_id')

      const shareId = extractShareId(input)
      if (!shareId) throw new Error('无法从链接中识别 share_id，请确认是 https://chat.deepseek.com/share/xxxx 格式')

      const { data, via } = await fetchShareData(ctx, shareId, exec?.signal)
      const messages = (data.messages ?? []) as ShareMessage[]
      if (!messages.length) throw new Error('对话内容为空（分享链接可能已失效）')

      const built = buildTreeFromMessages(messages)
      const title = data.title && data.title !== 'Shared Conversation' ? String(data.title) : null
      store.set(sessionIdOf(exec), built.tree, {
        title,
        via,
        notice: via === 'proxy' ? '内容经 api.allorigins.win 第三方代理中转' : null,
      })

      return asJson({
        ok: true,
        title,
        via,
        rootId: built.rootId,
        count: messages.length,
        nodeCount: Object.keys(built.tree.nodes).length,
        nodes: built.tree.nodes,
        notice: '已同步到当前会话的 GUI 画布（点会话栏 Asktree 按钮查看）',
        ...(built.warnings.length ? { warnings: built.warnings } : {}),
      })
    },
  })

  const parseChat = defineTool({
    name: 'asktree_parse_chat',
    description:
      '把复制的网页对话正文解析为问答轮次并串成线性树。DeepSeek 分享页全选复制的正文识别最准（每条回答自带「本回答由 AI 生成，内容仅供参考」结尾标记）。' +
      '返回 { ok, mode: marker|generic, turns:[{q,a}], tree:{nodes,rootId}, count }，并会自动同步到当前会话的 GUI 画布。' +
      '局限：纯文本没有 parent_id，只能重建线性链，并列分支会丢失；要保留分支请用 asktree_import_share。',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: '复制的对话正文（DeepSeek 分享页全选复制的内容，或任意「问题+回答」交替文本）',
      },
    },
    output: jsonOutput(),
    async execute(args: unknown, exec: ToolRunContext) {
      const { text } = args as { text?: string }
      const input = text || ''
      if (!input.trim()) throw new Error('缺少 text：请粘贴对话正文')
      if (/^https?:\/\//.test(input.trim())) {
        throw new Error('检测到链接而非正文：请改用 asktree_import_share 传入分享链接，或将链接打开后全选复制正文再粘贴')
      }

      const turns = parseChatTurns(input)
      if (!turns?.length) {
        throw new Error('未能识别出对话结构：请确认粘贴的是「问题 + 回答」交替的内容（DeepSeek 分享页复制的内容识别最准）')
      }

      const tree = linearTreeFromTurns(turns)
      store.set(sessionIdOf(exec), tree, { title: null, via: 'paste', notice: null })
      return asJson({
        ok: true,
        mode: isMarkerText(input) ? 'marker' : 'generic',
        turns,
        tree,
        count: turns.length,
        notice: '已同步到当前会话的 GUI 画布（点会话栏 Asktree 按钮查看）',
      })
    },
  })

  const showTree = defineTool({
    name: 'asktree_show',
    description:
      '把一棵问答树同步到当前会话的 GUI 画布显示（不校验来源，适合直接把任意符合 { nodes, rootId } 形状的树推给画布）。' +
      '传 tree 则替换当前画布内容；不传则仅返回当前画布状态。返回 { ok, tree, title, via, notice }。',
    parameters: {
      tree: {
        type: 'object',
        additionalProperties: true,
        description: '可选：问答树 { nodes: { id: {id,text,answer,parentId,children[]} }, rootId }',
      },
      title: { type: 'string', description: '可选：画布标题' },
      via: { type: 'string', description: '可选：来源标注（如 direct/proxy/paste/json）' },
    },
    output: jsonOutput(),
    async execute(args: unknown, exec: ToolRunContext) {
      const { tree, title, via } = args as { tree?: AskTree; title?: string; via?: string }
      const sessionId = sessionIdOf(exec)
      if (tree?.nodes && tree.rootId) {
        store.set(sessionId, tree, { title: title ?? null, via: via ?? 'json', notice: null })
      }
      const snap = store.snapshot(sessionId)
      return asJson({ ok: true, ...snap, notice: '已同步到当前会话的 GUI 画布（点会话栏 Asktree 按钮查看）' })
    },
  })

  const buildContextTool = defineTool({
    name: 'asktree_build_context',
    description:
      'AskTree buildContext 移植：取「从根问题到目标节点的整条祖先链」拼成 messages（[user, assistant, user, assistant, ...]），' +
      '不包含兄弟分支——省 token 且分支记忆不串线。返回 { ok, system, messages, chain, nodeCount }，messages 可直接传给 asktree_answer。' +
      'tree 形状：{ nodes: { id: {id, text, answer, parentId, children[]} }, rootId }。',
    parameters: {
      tree: { type: 'object', additionalProperties: true, required: true, description: '问答树对象 { nodes, rootId }' },
      nodeId: { type: 'string', required: true, description: '目标节点 id，取从根到该节点的祖先链作为上下文' },
      systemPrompt: { type: 'string', description: '可选：覆盖默认 system 提示词' },
    },
    output: jsonOutput(),
    async execute(args: unknown) {
      const { tree, nodeId, systemPrompt } = args as { tree?: AskTree; nodeId?: string; systemPrompt?: string }
      if (!tree || !nodeId) throw new Error('需要 tree（问答树对象）与 nodeId（目标节点 id）')
      const context = buildContext(tree, String(nodeId), systemPrompt)
      return asJson({
        ok: true,
        system: context.system,
        messages: context.messages,
        chain: context.chain,
        nodeCount: context.messages.length,
      })
    },
  })

  const answerTool = defineTool({
    name: 'asktree_answer',
    description:
      '基于祖先链上下文生成回答（AskTree generateAnswer + callApi 的宿主版）：传 tree+nodeId 会自动拼装上下文，或直接传 messages。' +
      '走宿主 llm 路由：provider/model 缺省取当前默认模型选择，可显式覆盖。' +
      '返回 { ok, answer, provider, model, temperature, maxTokens, usage }。',
    parameters: {
      tree: { type: 'object', additionalProperties: true, description: '问答树对象；与 nodeId 一起使用' },
      nodeId: { type: 'string', description: '目标节点 id，自动拼装祖先链上下文后生成回答' },
      messages: {
        type: 'array',
        items: { type: 'object', additionalProperties: true, description: "{ role: 'user'|'assistant', content: string }" },
        description: '直接传入问答消息数组（跳过 tree+nodeId 自动拼装）',
      },
      system: { type: 'string', description: 'system 提示词；缺省使用树形问答专用提示词' },
      provider: { type: 'string', description: 'LLM provider 路由（缺省取当前默认模型选择）' },
      model: { type: 'string', description: '模型 id（缺省取当前默认模型）' },
      temperature: { type: 'number', description: '采样温度，默认 0.6' },
      maxTokens: { type: 'integer', description: '最大输出 token，默认 900' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => answerRender(value as { provider?: string; model?: string; answer?: string }),
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const input = args as {
        tree?: AskTree
        nodeId?: string
        messages?: ChatLine[]
        system?: string
        provider?: string
        model?: string
        temperature?: number
        maxTokens?: number
      }

      let messages: ChatLine[]
      let system: string

      if (input.tree && input.nodeId) {
        const context = buildContext(input.tree, String(input.nodeId), input.system)
        messages = context.messages
        system = context.system
      } else if (Array.isArray(input.messages) && input.messages.length) {
        const collected: ChatLine[] = []
        for (const raw of input.messages) {
          const role = String((raw as ChatLine)?.role ?? '')
          const content = (raw as ChatLine)?.content != null ? String((raw as ChatLine).content) : ''
          if (role === 'system') continue
          if (role !== 'user' && role !== 'assistant') {
            throw new Error('messages 仅支持 role: user / assistant（system 请用 system 字段）')
          }
          collected.push({ role, content })
        }
        if (!collected.length) throw new Error('messages 为空（或只有 system）')
        messages = collected
        system = input.system || SYSTEM_PROMPT
      } else {
        throw new Error('需要提供 tree+nodeId（自动拼装祖先链上下文），或直接传 messages（问答消息数组）')
      }

      const route = resolveRoute(ctx, input.provider, input.model)
      const answer = await streamAnswer(
        route,
        messages,
        system,
        input.temperature ?? 0.6,
        input.maxTokens ?? 900,
        exec?.signal,
      )

      return asJson({
        ok: true,
        answer,
        provider: route.provider,
        model: route.model,
        temperature: input.temperature ?? 0.6,
        maxTokens: input.maxTokens ?? 900,
      })
    },
  })

  return [importShare, parseChat, showTree, buildContextTool, answerTool]
}

/** 画布服务用的快照读取（供宿主远程服务复用） */
export function currentSnapshot(store: AskTreeStore, sessionId: string | null): ReturnType<typeof snapshotOf> {
  return store.snapshot(sessionId)
}
