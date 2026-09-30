/**
 * 画布 ↔ 宿主树仓之间的通道抽象。
 *
 * 设计意图：把「客户端如何跨进程调用宿主」这一处**唯一的不确定点**隔离在
 * 本接口之后——`src/client.ts`（画布 UI）只依赖这个接口，
 * 具体实现见 `src/remote-client.ts`（Typert 远程服务适配）。
 * 这样即使远程调用机制的实现细节有出入，UI 部分仍可单独复用与测试。
 */
import type { AskMutation, AskSnapshot } from './types.js'

/** 一次变更的结果：成功时带上最新快照，失败时给出可读原因 */
export type MutateResult = ({ ok: true } & AskSnapshot) | { ok: false; reason: string }

/** 画布与宿主之间的最小契约 */
export interface AskBridge {
  /** 读取当前会话的画布快照；尚未建立树时返回 `tree: null` */
  getTree(sessionId: string | null): Promise<AskSnapshot | null>
  /** 对当前会话的树做一次变更（新增子问题 / 重新回答 / 编辑 / 删除 / 载入） */
  mutate(sessionId: string | null, mutation: AskMutation): Promise<MutateResult>
}

/** 把任意异常规整成 `{ ok: false, reason }`，便于 UI 统一提示 */
export function asFailure(error: unknown): { ok: false; reason: string } {
  const reason = error instanceof Error ? error.message : String(error)
  return { ok: false, reason }
}
