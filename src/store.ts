/**
 * 宿主侧树仓：**按会话隔离**的内存存储 + 变更应用。
 *
 * 与动态插件版语义一致：
 * - 每个会话（session）一棵独立的树，互不干扰；
 * - 新建对话从空树开始；关闭画布重开仍读到同一棵；
 * - 进程重启数据即失效（如需持久化，见 INSTALL.md「后续项」）。
 */
import { appendChild, buildContext, removeSubtree, requireNode } from './tree.js'
import type { AskMutation, AskSnapshot, AskTree } from './types.js'

/** 一个会话的树仓条目 */
export interface Repo {
  tree: AskTree | null
  title: string | null
  via: string | null
  notice: string | null
}

/** 回答生成运行时（由宿主 LLM 适配器实现，树仓不直接依赖 llm 服务） */
export interface AnswerRuntime {
  /** 基于「祖先链上下文」生成回答 */
  answer(tree: AskTree, nodeId: string): Promise<string>
}

/** 失败回答的落库前缀（与 `tree.ts` 的跳过逻辑一致） */
const FAIL_PREFIX = '生成失败'

/** 空仓条目 */
function emptyRepo(): Repo {
  return { tree: null, title: null, via: null, notice: null }
}

/** 把仓条目转成对外的快照（结构即 JSON，可直接跨进程传输） */
export function snapshotOf(repo: Repo): AskSnapshot {
  return { tree: repo.tree, title: repo.title, via: repo.via, notice: repo.notice }
}

/** 按会话隔离的树仓 */
export class AskTreeStore {
  private readonly repos = new Map<string, Repo>()

  /** 取（必要时创建）某会话的仓条目；sessionId 为空时归入 `default` */
  repo(sessionId: string | null | undefined): Repo {
    const key = sessionId ? String(sessionId) : 'default'
    let repo = this.repos.get(key)
    if (!repo) {
      repo = emptyRepo()
      this.repos.set(key, repo)
    }
    return repo
  }

  /** 读取某会话的快照 */
  snapshot(sessionId: string | null | undefined): AskSnapshot {
    return snapshotOf(this.repo(sessionId))
  }

  /** 直接写入一棵树（供导入/解析/推送工具使用） */
  set(
    sessionId: string | null | undefined,
    tree: AskTree,
    options: { title?: string | null; via?: string | null; notice?: string | null } = {},
  ): AskSnapshot {
    const repo = this.repo(sessionId)
    repo.tree = tree
    repo.title = options.title ?? null
    repo.via = options.via ?? null
    repo.notice = options.notice ?? null
    return snapshotOf(repo)
  }

  /** 清空某会话（画布上的树被删空时使用） */
  clear(sessionId: string | null | undefined): AskSnapshot {
    const repo = this.repo(sessionId)
    repo.tree = null
    repo.title = null
    repo.via = null
    repo.notice = null
    return snapshotOf(repo)
  }
}

/**
 * 应用一次画布变更（客户端 RPC 与工具共用同一条路径，保证两边看到同一棵树）。
 *
 * @throws 参数非法 / 节点不存在时抛出可读错误
 */
export async function applyMutation(
  repo: Repo,
  mutation: AskMutation,
  runtime: AnswerRuntime,
): Promise<AskSnapshot> {
  switch (mutation.op) {
    case 'load': {
      const tree = mutation.tree
      if (!tree || !tree.nodes || typeof tree !== 'object') throw new Error('load 需要合法的 tree { nodes, rootId }')
      repo.tree = tree
      if (mutation.title !== undefined) repo.title = mutation.title ?? null
      if (mutation.via !== undefined) repo.via = mutation.via ?? null
      repo.notice = null
      return snapshotOf(repo)
    }

    case 'setTitle': {
      repo.title = mutation.title ?? null
      return snapshotOf(repo)
    }
  }

  const tree = repo.tree
  if (!tree) {
    throw new Error('尚未导入任何树：先让模型运行 asktree_import_share / asktree_parse_chat / asktree_show')
  }

  switch (mutation.op) {
    case 'addChild': {
      const parentId = String(mutation.parentId)
      const text = (mutation.text || '').trim()
      requireNode(tree, parentId)
      if (!text) throw new Error('子问题内容为空')
      const node = appendChild(tree, parentId, text)
      if (mutation.autoAnswer !== false) {
        try {
          node.answer = await runtime.answer(tree, node.id)
        } catch (error) {
          node.answer = `${FAIL_PREFIX}：${error instanceof Error ? error.message : String(error)}`
        }
      }
      return snapshotOf(repo)
    }

    case 'answer': {
      const nodeId = String(mutation.nodeId)
      const node = requireNode(tree, nodeId)
      try {
        node.answer = await runtime.answer(tree, nodeId)
      } catch (error) {
        throw new Error(`${FAIL_PREFIX}：${error instanceof Error ? error.message : String(error)}`)
      }
      return snapshotOf(repo)
    }

    case 'save': {
      const node = requireNode(tree, String(mutation.nodeId))
      if (typeof mutation.text === 'string') node.text = mutation.text
      if (typeof mutation.answer === 'string') node.answer = mutation.answer
      return snapshotOf(repo)
    }

    case 'remove': {
      const nodeId = String(mutation.nodeId)
      requireNode(tree, nodeId)
      removeSubtree(tree, nodeId)
      if (!tree.rootId) repo.tree = null
      return snapshotOf(repo)
    }

    default: {
      const never: never = mutation
      throw new Error(`未知操作：${JSON.stringify(never)}`)
    }
  }
}

/** 供工具复用：把「节点 -> 根」的上下文取出来（透传 tree.ts 的实现） */
export { buildContext }
