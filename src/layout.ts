/**
 * 画布布局与尺寸估算（AskTree 原实现移植）。
 *
 * 网页版直接用 DOM 的 offsetHeight 测量；这里改为**纯函数估算**，
 * 这样布局可以在 React 渲染前算完（用于画块与画连线使用同一套坐标）。
 */
import type { AskNode, AskLayout, AskTree } from './types.js'

/** 画布左/上留白 */
export const PAD = 60
/** 块宽度（与 CSS `.at-block{width:300px}` 保持一致） */
export const BW = 300
/** 水平布局的层间距 */
export const HGAP = 64
/** 垂直布局的层间距 */
export const VGAP = 26
/** 画布额外留白（保证连线不被裁切） */
export const CANVAS_PAD = 120

/** 位置表：节点 id -> 画布坐标 */
export type PosMap = Record<string, { x: number; y: number }>

/** 布局输入（都来自客户端本地交互状态） */
export interface LayoutInput {
  layout: AskLayout
  /** 折叠的节点（隐藏其子树） */
  collapsed: Record<string, boolean | undefined>
  /** 块内显示回答的节点（影响块高） */
  ansShown: Record<string, boolean | undefined>
  /** 拖拽后的固定坐标（自由布局/手动摆放） */
  positions: PosMap
}

/** 布局输出 */
export interface LayoutOutput {
  pos: PosMap
  /** Q1/Q2... 编号（按先序遍历） */
  labels: Record<string, string>
  /** 画布画布尺寸与平移量（css transform 用） */
  bounds: { x0: number; y0: number; width: number; height: number }
}

/** 问题文本占位高度估算 */
function estQ(text: string | undefined): number {
  return Math.max(1, Math.ceil(String(text || '').length / 26)) * 20 + 14
}

/** 回答渲染高度估算（最多按 6 行计） */
function estA(text: string | undefined): number {
  return Math.min(6, Math.max(1, Math.ceil(String(text || '').length / 36))) * 18 + 10
}

/** 单块高度估算（无 DOM 测量时的近似值） */
export function nodeHeight(node: AskNode, ansShown: boolean): number {
  let h = 42 + estQ(node.text) + 26
  if (ansShown && (node.answer || '').trim()) h += 26 + estA(node.answer)
  h += 44 // 操作行 + 圆形 ＋ 按钮
  return h
}

/** 先序编号 Q1..Qn */
export function computeLabels(tree: AskTree): Record<string, string> {
  const labels: Record<string, string> = {}
  let i = 0
  const walk = (id: string): void => {
    const node = tree.nodes[id]
    if (!node) return
    labels[id] = `Q${++i}`
    for (const child of node.children) walk(child)
  }
  if (tree.rootId) walk(tree.rootId)
  return labels
}

/**
 * 计算整棵树的坐标。
 * 水平布局（根在左）与垂直布局（根在上）都会尽量让父节点居中于其子树；
 * 若某节点已有手动坐标（`positions`），则沿用该坐标。
 */
export function computeLayout(tree: AskTree, input: LayoutInput): LayoutOutput {
  const labels = computeLabels(tree)
  const pos: PosMap = {}
  const ansShown = (id: string): boolean => !!input.ansShown[id]
  const isCollapsed = (id: string): boolean => !!input.collapsed[id]

  const visibleKids = (id: string): string[] => {
    const node = tree.nodes[id]
    if (!node) return []
    return node.children.filter((c) => tree.nodes[c] && !isCollapsed(id))
  }

  const height = (id: string): number => {
    const node = tree.nodes[id]
    if (!node) return 0
    const self = nodeHeight(node, ansShown(id))
    const kids = visibleKids(id)
    if (!kids.length) return self
    let sum = 0
    for (const k of kids) sum += height(k)
    return Math.max(self, sum + (kids.length - 1) * VGAP)
  }

  const width = (id: string): number => {
    const node = tree.nodes[id]
    if (!node) return 0
    const kids = visibleKids(id)
    if (!kids.length) return BW
    let sum = 0
    for (const k of kids) sum += width(k)
    return Math.max(BW, sum + (kids.length - 1) * HGAP)
  }

  const placeH = (id: string, x: number, y: number, totalH: number): void => {
    const node = tree.nodes[id]
    if (!node) return
    const self = nodeHeight(node, ansShown(id))
    const pinned = input.positions[id]
    const px = pinned ? pinned.x : x
    const py = pinned ? pinned.y : y + (totalH - self) / 2
    pos[id] = { x: px, y: py }

    const kids = visibleKids(id)
    let childSum = 0
    for (const k of kids) childSum += height(k)
    let yy = py + Math.max(0, (self - childSum) / 2)
    for (const k of kids) {
      const h = height(k)
      placeH(k, px + BW + HGAP, yy, h)
      yy += h + VGAP
    }
  }

  const placeV = (id: string, y: number, x: number, totalW: number): void => {
    const node = tree.nodes[id]
    if (!node) return
    const self = nodeHeight(node, ansShown(id))
    const pinned = input.positions[id]
    const px = pinned ? pinned.x : x + (totalW - BW) / 2
    const py = pinned ? pinned.y : y
    pos[id] = { x: px, y: py }

    const kids = visibleKids(id)
    let childSum = 0
    for (const k of kids) childSum += width(k)
    let xx = px + Math.max(0, (BW - childSum) / 2)
    for (const k of kids) {
      const w = width(k)
      placeV(k, py + self + VGAP, xx, w)
      xx += w + HGAP
    }
  }

  if (tree.rootId && tree.nodes[tree.rootId]) {
    if (input.layout === 'v') placeV(tree.rootId, PAD, PAD, width(tree.rootId))
    else placeH(tree.rootId, PAD, PAD, height(tree.rootId))
  }

  // 画布范围（含负坐标时平移，保证连线不被裁切）
  let minX = 0
  let minY = 0
  let maxX = BW
  let maxY = 100
  for (const [id, p] of Object.entries(pos)) {
    const node = tree.nodes[id]
    if (!node) continue
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + BW)
    maxY = Math.max(maxY, p.y + nodeHeight(node, ansShown(id)))
  }
  const x0 = Math.min(minX, 0)
  const y0 = Math.min(minY, 0)
  return {
    pos,
    labels,
    bounds: { x0, y0, width: maxX - x0 + CANVAS_PAD, height: maxY - y0 + CANVAS_PAD },
  }
}

/** 一条父子连线的 SVG path（虚线贝塞尔） */
export function linkPath(
  parent: { x: number; y: number; h: number },
  child: { x: number; y: number; h: number },
  mode: 'h' | 'v',
): string {
  if (mode === 'v') {
    const x1 = parent.x + BW / 2
    const y1 = parent.y + parent.h
    const x2 = child.x + BW / 2
    const y2 = child.y
    const my = (y1 + y2) / 2
    return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`
  }
  const x1 = parent.x + BW
  const y1 = parent.y + parent.h / 2
  const x2 = child.x
  const y2 = child.y + child.h / 2
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}
