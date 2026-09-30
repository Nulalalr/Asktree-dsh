/**
 * AskTree 共享类型。
 *
 * 与动态插件版（host.js / client.js）的数据结构完全一致，
 * 便于两边互换与既有数据兼容。
 */

/** 一个问答节点（问题 + 回答，挂成树） */
export interface AskNode {
  /** 节点 id，形如 "n1" / "n2" */
  id: string
  /** 问题正文 */
  text: string
  /** AI 回答（或手动填写），空字符串表示未回答 */
  answer: string
  /** 父问题节点 id；根节点为 null */
  parentId: string | null
  /** 子问题节点 id 列表（顺序即展示顺序） */
  children: string[]
}

/** 一棵完整的问答树 */
export interface AskTree {
  /** 扁平节点表：id -> 节点 */
  nodes: Record<string, AskNode>
  /** 根问题节点 id；空树为 null */
  rootId: string | null
}

/** 画布快照：Host 树仓向 Client 暴露的完整状态 */
export interface AskSnapshot {
  tree: AskTree | null
  /** 画布标题（分享对话标题 / 用户设置） */
  title: string | null
  /** 来源标记：direct | proxy | paste | json */
  via: string | null
  /** 附加提示（如「经第三方代理中转」） */
  notice: string | null
}

/** 一轮问答（粘贴文本解析的最小结果） */
export interface AskTurn {
  q: string
  a: string
}

/** DeepSeek 分享接口返回的一条原始消息 */
export interface ShareMessage {
  message_id: string | number
  parent_id?: string | number | null
  role: string
  content?: string
}

/** 分享接口的业务数据 */
export interface ShareBizData {
  title?: string
  messages?: ShareMessage[]
}

/** 一行对话消息（provider 无关的最小形态） */
export interface ChatLine {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 画布可用的布局模式 */
export type AskLayout = 'h' | 'v' | 'free'

/** 画布配色主题 */
export type AskTheme = 'dark' | 'light'

/**
 * 画布变更操作（Client -> Host 的 RPC 载荷）。
 * 与动态插件版 `asktree.mutate` 的 op 集合一致。
 */
export type AskMutation =
  | { op: 'load'; tree: AskTree; title?: string | null; via?: string | null }
  | { op: 'addChild'; parentId: string; text: string; autoAnswer?: boolean }
  | { op: 'answer'; nodeId: string }
  | { op: 'save'; nodeId: string; text?: string; answer?: string }
  | { op: 'remove'; nodeId: string }
  | { op: 'setTitle'; title: string | null }
