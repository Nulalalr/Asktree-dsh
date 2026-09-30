/**
 * 树的纯逻辑：建树、祖先链上下文、节点增删、id 分配。
 *
 * 移植自 AskTree（单文件网页版）并经动态插件版验证；
 * 本模块不依赖任何 DSH 运行时，可被 Host 与 Client 共用、可单测。
 */
import type { AskNode, AskTree, AskTurn, ChatLine, ShareMessage } from './types.js'

/** 树形问答专用 system 提示词（与 AskTree 网页版一致） */
export const SYSTEM_PROMPT =
  '你是一个严谨的助手。用户正在用「树形问答」逐层深入一个主题：' +
  '同一层会出现多个并列的追问，请针对当前问题作答，不要重复其他分支的内容；' +
  '回答要具体、可操作，避免空泛。若上下文不足，可指出需要补充的信息。'

/** 回答生成失败时写入 answer 的前缀（buildContext 会跳过这类内容） */
export const ANSWER_FAIL_PREFIX = '生成失败'

/** 建树结果 */
export interface BuildTreeResult {
  tree: AskTree
  rootId: string | null
  warnings: string[]
}

/**
 * 把 DeepSeek 分享接口的消息数组重建为问答树。
 *
 * 关键语义（AskTree 原实现）：
 * - 每条 `USER` 消息建一个节点；
 * - 若其 `parent_id` 指向另一条 `USER` 消息，则那条就是它的父问题（即并列追问）；
 * - 若 `parent_id` 指向 `ASSISTANT`，则上溯到该回答所对应的 `USER` 消息；
 * - 回答取 `role === "ASSISTANT" && parent_id === 该 USER.message_id` 的消息。
 */
export function buildTreeFromMessages(messages: readonly ShareMessage[]): BuildTreeResult {
  const byId = new Map<string, ShareMessage>()
  for (const m of messages) byId.set(String(m.message_id), m)

  const nodes: Record<string, AskNode> = {}
  const nodeByMsg = new Map<string, string>()
  const warnings: string[] = []
  let seq = 1
  let rootId: string | null = null
  let rootCount = 0

  for (const m of messages) {
    if (m.role !== 'USER') continue

    let parentQMsg: string | null = null
    const parent = m.parent_id == null ? undefined : byId.get(String(m.parent_id))
    if (parent) {
      if (parent.role === 'USER') parentQMsg = String(parent.message_id)
      else if (parent.parent_id != null) {
        const grand = byId.get(String(parent.parent_id))
        if (grand && grand.role === 'USER') parentQMsg = String(grand.message_id)
      }
    }

    const id = `n${seq++}`
    const parentNodeId = parentQMsg != null ? nodeByMsg.get(parentQMsg) ?? null : null
    nodes[id] = {
      id,
      text: m.content || '（空问题）',
      answer: '',
      parentId: parentNodeId,
      children: [],
    }
    if (parentNodeId && nodes[parentNodeId]) nodes[parentNodeId].children.push(id)
    nodeByMsg.set(String(m.message_id), id)
    if (parentQMsg == null) {
      rootId = id
      rootCount++
    }

    const ans = messages.find((x) => x.role === 'ASSISTANT' && String(x.parent_id) === String(m.message_id))
    if (ans) nodes[id].answer = ans.content || ''
  }

  if (rootCount > 1) warnings.push(`分享内容中有 ${rootCount} 条无父问题的消息，已取最后一条作为根节点`)
  return { tree: { nodes, rootId }, rootId, warnings }
}

/** 取节点（不存在则抛错，错误信息面向模型/用户可读） */
export function requireNode(tree: AskTree | null, nodeId: string): AskNode {
  const node = tree?.nodes?.[nodeId]
  if (!node) {
    const hint = tree?.rootId ? `可用根节点：${tree.rootId}` : '当前无根节点'
    throw new Error(`节点 ${nodeId} 不存在于树中（${hint}）`)
  }
  return node
}

/** 从根到目标节点的祖先链（含自身），顺序为 根 -> 目标 */
export function lineageOf(tree: AskTree, nodeId: string): AskNode[] {
  const chain: AskNode[] = []
  let cur: AskNode | undefined = tree.nodes[nodeId]
  while (cur) {
    chain.unshift(cur)
    cur = cur.parentId ? tree.nodes[cur.parentId] : undefined
  }
  return chain
}

/**
 * 祖先链上下文（AskTree `buildContext` 移植）。
 *
 * 只沿「该节点 -> 根」的单条祖先链拼装 messages，
 * **不包含兄弟分支**：省 token，且各分支记忆互不串线。
 */
export function buildContext(
  tree: AskTree,
  nodeId: string,
  systemPrompt?: string,
): { system: string; messages: ChatLine[]; chain: string[] } {
  const chain = lineageOf(tree, nodeId)
  if (!chain.length) requireNode(tree, nodeId) // 抛出统一错误
  const messages: ChatLine[] = []
  for (const n of chain) {
    if (n.text) messages.push({ role: 'user', content: String(n.text) })
    if (n.answer && !n.answer.startsWith(ANSWER_FAIL_PREFIX)) {
      messages.push({ role: 'assistant', content: String(n.answer) })
    }
  }
  return { system: systemPrompt || SYSTEM_PROMPT, messages, chain: chain.map((n) => n.id) }
}

/** 问答轮次 -> 线性树（粘贴导入：没有 parent_id，只能是一条链） */
export function linearTreeFromTurns(turns: readonly AskTurn[]): AskTree {
  const nodes: Record<string, AskNode> = {}
  let rootId: string | null = null
  let prev: string | null = null
  let seq = 1
  for (const t of turns) {
    const id = `n${seq++}`
    nodes[id] = { id, text: t.q || '', answer: t.a || '', parentId: prev, children: [] }
    if (prev) nodes[prev].children.push(id)
    else rootId = id
    prev = id
  }
  return { nodes, rootId }
}

/** 分配下一个节点 id（扫描现有 id 取最大序号 + 1，避免与导入的 id 冲突） */
export function nextNodeId(tree: AskTree): string {
  let max = 0
  for (const key of Object.keys(tree.nodes)) {
    const n = Number.parseInt(key.replace(/\D/g, ''), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `n${max + 1}`
}

/** 删除节点及其整棵子树（就地修改；根节点被删则 rootId 置空） */
export function removeSubtree(tree: AskTree, id: string): void {
  const node = tree.nodes[id]
  if (!node) return
  for (const child of node.children) removeSubtree(tree, child)
  delete tree.nodes[id]
  if (node.parentId) {
    const parent = tree.nodes[node.parentId]
    if (parent) parent.children = parent.children.filter((c) => c !== id)
  } else if (tree.rootId === id) {
    tree.rootId = null
  }
}

/** 在一个父节点下追加子问题节点，返回新节点 */
export function appendChild(tree: AskTree, parentId: string, text: string): AskNode {
  const parent = requireNode(tree, parentId)
  const id = nextNodeId(tree)
  const node: AskNode = { id, text, answer: '', parentId, children: [] }
  tree.nodes[id] = node
  parent.children.push(id)
  return node
}

/** 节点总数 */
export function countNodes(tree: AskTree | null): number {
  return tree ? Object.keys(tree.nodes).length : 0
}

/** 已回答节点数（失败回答不计） */
export function countAnswered(tree: AskTree | null): number {
  if (!tree) return 0
  let n = 0
  for (const node of Object.values(tree.nodes)) {
    if (node.answer.trim() && !node.answer.startsWith(ANSWER_FAIL_PREFIX)) n++
  }
  return n
}
