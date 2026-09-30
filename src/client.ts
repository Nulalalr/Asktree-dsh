/**
 * 客户端半边（浏览器）：Asktree 交互画布 + 会话头/输入框入口。
 *
 * 与宿主的通信全部经 `AskBridge`（见 `src/bridge.ts`），
 * 因此本文件不关心跨进程调用的实现细节，只关心 UI 与交互。
 *
 * 说明：DSH 客户端模块运行在浏览器里，本文件用 `React.createElement`
 * 而非 JSX —— 与已在动态插件中验证过的实现保持同构，便于逐段比对。
 */
import * as React from 'react'
import type { AskBridge, MutateResult } from './bridge.js'
import { CANVAS_CSS } from './css.js'
import { BW, HGAP, VGAP, computeLayout, linkPath, nodeHeight } from './layout.js'
import { mdToHtml } from './markdown.js'
import { createCanvasBridge } from './remote-client.js'
import type { AskLayout, AskNode, AskSnapshot, AskTheme, AskTree } from './types.js'

/* ============================ 服务面（结构化最小类型） ============================ */

/** slots 服务的最小面（真实类型由 DSH 客户端包导出，这里避免硬依赖） */
export interface SlotFace {
  inject(key: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: (props: Record<string, unknown>) => unknown): unknown
}

/** styles 服务的最小面 */
export interface StylesFace {
  insert(css: string): unknown
}

/** timer 服务的最小面 */
export interface TimerFace {
  interval(callback: () => void, delay: number): () => void
  timeout(callback: () => void, delay: number): () => void
}

/** 客户端插件拿到的上下文（结构化最小类型） */
export interface ClientContext {
  get(name: string): unknown
}

/* ============================ 画布本地状态 ============================ */

interface Point {
  x: number
  y: number
}

/** 画布拖拽状态：平移画布 vs 拖动单个节点 */
interface DragState {
  mode: 'pan' | 'block' | null
  id: string | null
  sx: number
  sy: number
  moved: boolean
}

type DragRef = React.MutableRefObject<DragState>

interface UiState {
  /** 当前会话 id（由会话作用域的槽位 props 捕获） */
  sessionId: string | null
  open: boolean
  snapshot: AskSnapshot | null
  layout: AskLayout
  zoom: number
  selectedId: string | null
  /** 手动拖拽后的坐标（自由布局/微调） */
  positions: Record<string, Point>
  collapsed: Record<string, boolean>
  /** 块内是否展开回答 */
  ansShown: Record<string, boolean>
  /** 正在生成回答的节点 */
  loading: Record<string, boolean>
  busy: boolean
  /** 新增子问题后是否自动回答 */
  autoAnswer: boolean
  /** 正在输入子问题的节点 */
  addBoxFor: string | null
  theme: AskTheme
  msg: string | null
  /** 二次确认删除的节点 */
  confirmDelete: string | null
}

/** 画布宿主组件（Panel / 入口按钮）共享的运行时依赖 */
interface Runtime {
  h: typeof React.createElement
  bridge: AskBridge
  ui: UiState
  bump(): void
  useVersion(): number
  setMsg(text: string | null): void
  timer: TimerFace | undefined
}

/* ============================ 插件工厂 ============================ */

/**
 * 创建客户端插件。
 *
 * @param bridge 跨进程通道（真实插件里由 Typert 远程服务实现）
 */
export function createAskTreeClientPlugin(bridge: AskBridge) {
  return {
    name: 'asktree-client',
    inject: ['slots'],
    apply(ctx: ClientContext) {
      const runtime = createRuntime(bridge, ctx)
      bindSlots(runtime, ctx)
    },
  }
}

/**
 * 客户端模块入口（与 `package.json` 的 `exports["./client"]` 对应）。
 *
 * 注意：DSH 客户端 bundle 的契约是**具名导出** `apply` / `inject`
 * （见 `dsh-client-ui-cordis/lib/client.js` 末尾的 `exports.apply = apply`），
 * 不是 default export；`lib/client.js` 还必须包在
 * `window.__ModuleLoader__.load({ id, factory })` 信封里（由构建脚本生成）。
 */
export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  // 画布桥：经连接层逻辑 RPC 频道调用宿主（见 src/remote-client.ts）
  createAskTreeClientPlugin(createCanvasBridge(ctx)).apply(ctx)
}

/* ============================ 运行时 ============================ */

function createRuntime(bridge: AskBridge, ctx: ClientContext): Runtime {
  const h = React.createElement
  const ui: UiState = {
    sessionId: null,
    open: false,
    snapshot: null,
    layout: 'h',
    zoom: 1,
    selectedId: null,
    positions: {},
    collapsed: {},
    ansShown: {},
    loading: {},
    busy: false,
    autoAnswer: true,
    addBoxFor: null,
    theme: 'dark',
    msg: null,
    confirmDelete: null,
  }

  let version = 0
  const listeners = new Set<() => void>()
  const bump = (): void => {
    version++
    for (const fn of listeners) fn()
  }

  const runtime: Runtime = {
    h,
    bridge,
    ui,
    bump,
    useVersion() {
      const [v, setV] = React.useState(0)
      React.useEffect(() => {
        const fn = (): void => setV(version)
        listeners.add(fn)
        return () => {
          listeners.delete(fn)
        }
      }, [])
      return v
    },
    setMsg(text) {
      ui.msg = text || null
      bump()
      if (text) {
        runtime.timer?.timeout(() => {
          if (ui.msg === text) {
            ui.msg = null
            bump()
          }
        }, 3500)
      }
    },
    timer: ctx.get('timer') as TimerFace | undefined,
  }

  return runtime
}

/* ============================ 数据同步 ============================ */

function snapshotKey(snapshot: AskSnapshot | null): string {
  return snapshot ? JSON.stringify(snapshot) : ''
}

function pruneLocal(rt: Runtime): void {
  const tree = rt.ui.snapshot?.tree ?? null
  const ids = new Set(tree ? Object.keys(tree.nodes) : [])
  for (const bag of [rt.ui.positions, rt.ui.collapsed, rt.ui.ansShown, rt.ui.loading]) {
    for (const key of Object.keys(bag)) if (!ids.has(key)) delete bag[key]
  }
  if (rt.ui.selectedId && !ids.has(rt.ui.selectedId)) rt.ui.selectedId = null
}

function applySnapshot(rt: Runtime, result: MutateResult): void {
  if (result.ok === false) return
  rt.ui.snapshot = {
    tree: result.tree,
    title: result.title ?? null,
    via: result.via ?? null,
    notice: result.notice ?? null,
  }
  pruneLocal(rt)
}

/** 从宿主拉取快照（内容变化才触发重渲染） */
async function refresh(rt: Runtime): Promise<void> {
  let snap: AskSnapshot | null = null
  try {
    snap = await rt.bridge.getTree(rt.ui.sessionId)
  } catch {
    return
  }
  if (!snap) return
  if (snapshotKey(snap) === snapshotKey(rt.ui.snapshot)) return
  rt.ui.snapshot = snap
  pruneLocal(rt)
  rt.bump()
}

/** 发起一次变更 */
async function mutate(rt: Runtime, mutation: Parameters<AskBridge['mutate']>[1]): Promise<MutateResult> {
  try {
    return await rt.bridge.mutate(rt.ui.sessionId, mutation)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/* ============================ 交互动作 ============================ */

function select(rt: Runtime, id: string): void {
  rt.ui.selectedId = id
  rt.bump()
}

function setLayout(rt: Runtime, mode: AskLayout): void {
  rt.ui.layout = mode
  if (mode !== 'free') rt.ui.positions = {}
  rt.bump()
}

async function reanswer(rt: Runtime, id: string): Promise<void> {
  if (rt.ui.loading[id]) return
  rt.ui.loading[id] = true
  rt.ui.busy = true
  rt.bump()
  const result = await mutate(rt, { op: 'answer', nodeId: id })
  rt.ui.loading[id] = false
  rt.ui.busy = false
  if (result.ok === false) rt.setMsg(result.reason)
  else applySnapshot(rt, result)
  rt.bump()
}

async function removeNode(rt: Runtime, id: string): Promise<void> {
  if (!rt.ui.confirmDelete) {
    rt.ui.confirmDelete = id
    rt.setMsg('再次点击「删除」确认删除该节点及其子树')
    rt.timer?.timeout(() => {
      if (rt.ui.confirmDelete === id) {
        rt.ui.confirmDelete = null
        rt.bump()
      }
    }, 4000)
    return
  }
  rt.ui.confirmDelete = null
  rt.ui.busy = true
  rt.bump()
  const result = await mutate(rt, { op: 'remove', nodeId: id })
  rt.ui.busy = false
  if (result.ok === false) rt.setMsg(result.reason)
  else {
    applySnapshot(rt, result)
    if (rt.ui.selectedId === id) rt.ui.selectedId = null
  }
  rt.bump()
}

async function addChild(rt: Runtime, parentId: string, text: string): Promise<void> {
  rt.ui.busy = true
  rt.ui.addBoxFor = null
  rt.bump()
  const result = await mutate(rt, { op: 'addChild', parentId, text, autoAnswer: rt.ui.autoAnswer })
  rt.ui.busy = false
  if (result.ok === false) rt.setMsg(result.reason)
  else applySnapshot(rt, result)
  rt.bump()
}

async function saveNode(rt: Runtime, id: string, text: string, answer: string): Promise<void> {
  rt.ui.busy = true
  rt.bump()
  const result = await mutate(rt, { op: 'save', nodeId: id, text, answer })
  rt.ui.busy = false
  if (result.ok === false) rt.setMsg(result.reason)
  else applySnapshot(rt, result)
  rt.bump()
}

/* ============================ 组件 ============================ */

function OverlayEntry(rt: Runtime): React.ReactElement | null {
  rt.useVersion()
  if (!rt.ui.open) return null
  return rt.h(Panel, { rt })
}

function useSyncSession(rt: Runtime, props: Record<string, unknown> | undefined): void {
  const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : null
  React.useEffect(() => {
    if (sessionId && sessionId !== rt.ui.sessionId) {
      rt.ui.sessionId = sessionId
      void refresh(rt)
    }
  }, [sessionId])
}

function toggleButton(rt: Runtime, compact: boolean): React.ReactElement {
  const count = rt.ui.snapshot?.tree ? Object.keys(rt.ui.snapshot.tree.nodes).length : 0
  return rt.h(
    'button',
    {
      className: 'at-toggle' + (compact ? ' at-compact' : '') + (rt.ui.open ? ' at-on' : ''),
      title: 'Asktree 问答树画布' + (count ? `（${count} 个节点）` : ''),
      onClick: () => {
        rt.ui.open = !rt.ui.open
        if (rt.ui.open) void refresh(rt)
        rt.bump()
      },
    },
    'Asktree',
  )
}

function HeaderAction(rt: Runtime, props?: Record<string, unknown>): React.ReactElement {
  rt.useVersion()
  useSyncSession(rt, props)
  return toggleButton(rt, false)
}

function ComposerAction(rt: Runtime, props?: Record<string, unknown>): React.ReactElement | null {
  rt.useVersion()
  useSyncSession(rt, props)
  // 全新对话（空白会话）会把会话标题栏整体隐藏，因此在输入框工具行再放一个入口；
  // 只在「确定是非空白会话」时隐藏它，避免与标题栏入口重复。
  const useSession = props?.useSession
  const blank =
    typeof useSession === 'function'
      ? (useSession as (fn: (s: unknown) => unknown) => unknown)((s: unknown) =>
          s === undefined ? undefined : (s as { blank?: boolean }).blank === true,
        )
      : true
  if (blank === false) return null
  return toggleButton(rt, true)
}

function Panel(props: { rt: Runtime }): React.ReactElement {
  const { rt } = props
  rt.useVersion()
  const bodyRef = React.useRef<HTMLDivElement | null>(null)
  const drag = React.useRef<DragState>({ mode: null, id: null, sx: 0, sy: 0, moved: false })

  React.useEffect(() => {
    void refresh(rt)
    if (!rt.timer) return
    return rt.timer.interval(() => {
      if (rt.ui.open) void refresh(rt)
    }, 1500)
  }, [])

  const tree = rt.ui.snapshot?.tree ?? null
  const title = rt.ui.snapshot?.title || '问答树'
  const via = rt.ui.snapshot?.via ?? null
  const count = tree ? Object.keys(tree.nodes).length : 0

  const fitView = (): void => {
    const el = bodyRef.current
    if (!el || !rt.ui.snapshot?.tree) return
    const { pos } = computeLayout(rt.ui.snapshot.tree, {
      layout: rt.ui.layout,
      collapsed: rt.ui.collapsed,
      ansShown: rt.ui.ansShown,
      positions: rt.ui.positions,
    })
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = 0
    let maxY = 0
    for (const [id, p] of Object.entries(pos)) {
      const node = rt.ui.snapshot.tree.nodes[id]
      if (!node) continue
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x + BW)
      maxY = Math.max(maxY, p.y + nodeHeight(node, !!rt.ui.ansShown[id]))
    }
    if (!Number.isFinite(minX)) return
    const availW = el.clientWidth - 80
    const availH = el.clientHeight - 80
    if (availW <= 0 || availH <= 0) return
    rt.ui.zoom = Math.max(0.15, Math.min(1, Math.min(availW / (maxX - minX + 120), availH / (maxY - minY + 120))))
    rt.bump()
  }

  const button = (key: string, className: string, onClick: () => void, label: string, title?: string): React.ReactElement =>
    rt.h('button', { key, className, onClick, title }, label)

  return rt.h(
    'div',
    { className: 'at-panel' + (rt.ui.theme === 'light' ? ' at-light' : '') },
    rt.h(
      'div',
      { className: 'at-head' },
      rt.h('span', { className: 'at-title' }, `Asktree · ${title}`),
      via ? rt.h('span', { className: 'at-badge via' }, via) : null,
      rt.h('span', { className: 'at-count' }, `${count} 节点`),
      rt.ui.busy ? rt.h('span', { className: 'at-spinner-wrap' }, rt.h('span', { className: 'at-spinner' }), ' 处理中…') : null,
      rt.h('div', { className: 'at-head-spacer' }),
      button('refresh', 'at-hbtn', () => void refresh(rt), '⟳', '重新从宿主同步'),
      button('h', 'at-hbtn' + (rt.ui.layout === 'h' ? ' at-on' : ''), () => setLayout(rt, 'h'), '水平'),
      button('v', 'at-hbtn' + (rt.ui.layout === 'v' ? ' at-on' : ''), () => setLayout(rt, 'v'), '垂直'),
      button('free', 'at-hbtn' + (rt.ui.layout === 'free' ? ' at-on' : ''), () => setLayout(rt, 'free'), '自由'),
      button(
        'auto',
        'at-hbtn' + (rt.ui.autoAnswer ? ' at-on' : ''),
        () => {
          rt.ui.autoAnswer = !rt.ui.autoAnswer
          rt.bump()
        },
        rt.ui.autoAnswer ? '自动回答' : '手动回答',
        '添加子问题后是否自动回答',
      ),
      button(
        'theme',
        'at-hbtn',
        () => {
          rt.ui.theme = rt.ui.theme === 'light' ? 'dark' : 'light'
          rt.bump()
        },
        rt.ui.theme === 'light' ? '☀️ 浅色' : '🌙 深色',
        '切换深色/浅色',
      ),
      button('fit', 'at-hbtn', fitView, '适配'),
      button(
        'close',
        'at-hbtn at-close',
        () => {
          rt.ui.open = false
          rt.bump()
        },
        '✕',
        '关闭',
      ),
    ),
    rt.ui.msg ? rt.h('div', { className: 'at-msg' }, rt.ui.msg) : null,
    tree
      ? rt.h(TreeBody, { rt, tree, bodyRef, drag })
      : rt.h(
          'div',
          { className: 'at-empty' },
          rt.h('p', null, '还没有问答树。在对话里让模型运行 asktree_import_share / asktree_parse_chat / asktree_show 即可生成。'),
        ),
  )
}

interface TreeBodyProps {
  rt: Runtime
  tree: AskTree
  bodyRef: React.MutableRefObject<HTMLDivElement | null>
  drag: DragRef
}

function TreeBody(props: TreeBodyProps): React.ReactElement {
  const { rt, tree, bodyRef, drag } = props
  rt.useVersion()

  const { pos, labels, bounds } = computeLayout(tree, {
    layout: rt.ui.layout,
    collapsed: rt.ui.collapsed,
    ansShown: rt.ui.ansShown,
    positions: rt.ui.positions,
  })

  const links: React.ReactElement[] = []
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (rt.ui.collapsed[id]) continue
    for (const childId of node.children) {
      const child = tree.nodes[childId]
      const pa = pos[id]
      const ch = pos[childId]
      if (!child || !pa || !ch || rt.ui.collapsed[childId]) continue
      const mode: 'h' | 'v' =
        rt.ui.layout === 'free' ? (Math.abs(ch.x - pa.x) >= Math.abs(ch.y - pa.y) ? 'h' : 'v') : rt.ui.layout
      links.push(
        rt.h('path', {
          key: `${id}>${childId}`,
          d: linkPath(
            { x: pa.x, y: pa.y, h: nodeHeight(node, !!rt.ui.ansShown[id]) },
            { x: ch.x, y: ch.y, h: nodeHeight(child, !!rt.ui.ansShown[childId]) },
            mode,
          ),
          className: 'at-link',
        }),
      )
    }
  }

  const blocks: React.ReactElement[] = []
  const walk = (id: string): void => {
    const node = tree.nodes[id]
    if (!node) return
    const p = pos[id] ?? { x: 0, y: 0 }
    blocks.push(rt.h(Block, { key: id, rt, node, pos: p, label: labels[id] ?? '', drag }))
    if (!rt.ui.collapsed[id]) for (const child of node.children) walk(child)
  }
  if (tree.rootId) walk(tree.rootId)

  return rt.h(
    'div',
    {
      className: 'at-body',
      ref: (el: HTMLDivElement | null): void => {
        bodyRef.current = el
      },
      onWheel: (e: React.WheelEvent) => {
        if (!e.ctrlKey) return
        e.preventDefault()
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
        rt.ui.zoom = Math.min(2, Math.max(0.15, rt.ui.zoom * f))
        rt.bump()
      },
      onPointerDown: (e: React.PointerEvent) => {
        if ((e.target as HTMLElement).closest('.at-block')) return
        drag.current = { mode: 'pan', id: null, sx: e.clientX, sy: e.clientY, moved: false }
      },
      onPointerMove: (e: React.PointerEvent) => {
        const state = drag.current
        if (state.mode === 'pan') {
          const el = bodyRef.current
          if (el) {
            el.scrollLeft -= e.clientX - state.sx
            el.scrollTop -= e.clientY - state.sy
            state.sx = e.clientX
            state.sy = e.clientY
          }
        } else if (state.mode === 'block' && state.id) {
          const el = bodyRef.current
          if (!el) return
          if (Math.abs(e.clientX - state.sx) + Math.abs(e.clientY - state.sy) > 3) state.moved = true
          const rect = el.getBoundingClientRect()
          rt.ui.positions[state.id] = {
            x: (e.clientX - rect.left) / rt.ui.zoom,
            y: (e.clientY - rect.top) / rt.ui.zoom,
          }
          rt.bump()
        }
      },
      onPointerUp: () => {
        drag.current = { mode: null, id: null, sx: 0, sy: 0, moved: false }
      },
      onDoubleClick: (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('.at-block')) return
        rt.ui.zoom = 1
        rt.bump()
      },
    },
    rt.h(
      'div',
      { className: 'at-tinner', style: { transform: `scale(${rt.ui.zoom})`, transformOrigin: '0 0' } },
      rt.h(
        'div',
        {
          className: 'at-canvas',
          style: {
            width: `${bounds.width}px`,
            height: `${bounds.height}px`,
            transform: `translate(${-bounds.x0}px,${-bounds.y0}px)`,
          },
        },
        rt.h('svg', { className: 'at-links', width: bounds.width, height: bounds.height }, links),
        blocks,
      ),
    ),
    rt.ui.selectedId ? rt.h(Inspector, { rt, tree }) : null,
  )
}

interface BlockProps {
  rt: Runtime
  node: AskNode
  pos: Point
  label: string
  drag: DragRef
}

function Block(props: BlockProps): React.ReactElement {
  const { rt, node, pos, label, drag } = props
  const id = node.id
  const selected = rt.ui.selectedId === id
  const collapsed = !!rt.ui.collapsed[id]
  const showAns = !!rt.ui.ansShown[id]
  const loading = !!rt.ui.loading[id]
  const kids = node.children.filter((c) => rt.ui.snapshot?.tree?.nodes[c]).length

  return rt.h(
    'div',
    {
      className: 'at-block' + (selected ? ' at-selected' : '') + (collapsed ? ' at-collapsed' : ''),
      style: { left: `${pos.x}px`, top: `${pos.y}px` },
      onPointerDown: (e: React.PointerEvent) => {
        const target = e.target as HTMLElement
        if (target.closest('button,textarea,input')) return
        e.preventDefault()
        drag.current = { mode: 'block', id, sx: e.clientX, sy: e.clientY, moved: false }
        try {
          ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
        } catch {
          /* setPointerCapture 在部分环境不可用，忽略即可 */
        }
      },
      onClick: (e: React.MouseEvent) => {
        if (drag.current.moved) {
          drag.current.moved = false
          return
        }
        if ((e.target as HTMLElement).closest('button,textarea,input')) return
        select(rt, id)
      },
    },
    rt.h(
      'div',
      { className: 'at-block-head' },
      rt.h(
        'button',
        {
          className: 'at-chev' + (collapsed ? '' : ' at-rot'),
          title: collapsed ? '展开' : '折叠',
          disabled: !kids,
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation()
            rt.ui.collapsed[id] = !rt.ui.collapsed[id]
            rt.bump()
          },
        },
        '▸',
      ),
      rt.h('span', { className: 'at-badge' }, label + (kids ? ` ${kids}` : '')),
      rt.h('span', { className: 'at-grip', title: '按住拖动' }, '⠿'),
    ),
    rt.h('div', { className: 'at-q' }, node.text || '（空）'),
    rt.h(
      'div',
      {
        className: 'at-meta',
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation()
          select(rt, id)
        },
      },
      loading
        ? rt.h('span', { className: 'at-spinner' })
        : rt.h('span', { className: 'at-dot' + (node.answer.trim() ? ' at-ok' : '') }),
      loading ? ' AI 正在回答…' : node.answer.trim() ? ' 已回答 · 点击查看' : ' 未回答',
    ),
    showAns && (loading || node.answer.trim())
      ? rt.h(
          'div',
          { className: 'at-ans' },
          loading
            ? rt.h('span', { className: 'at-spinner' }, ' AI 正在回答…')
            : rt.h('div', { className: 'at-md', dangerouslySetInnerHTML: { __html: mdToHtml(node.answer) } }),
        )
      : null,
    collapsed && kids > 0 ? rt.h('div', { className: 'at-note' }, `已折叠 ${kids} 个子问题`) : null,
    rt.ui.addBoxFor === id ? rt.h(AddBox, { rt, parentId: id }) : null,
    rt.h(
      'div',
      { className: 'at-actions' },
      rt.h(
        'button',
        {
          className: 'at-cbtn at-go',
          title: '基于祖先链上下文重新生成回答',
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation()
            void reanswer(rt, id)
          },
        },
        '⟳ 重新回答',
      ),
      rt.h(
        'button',
        {
          className: 'at-cbtn',
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation()
            rt.ui.ansShown[id] = !showAns
            rt.bump()
          },
        },
        showAns ? '隐藏回答' : '显示回答',
      ),
      rt.h(
        'button',
        {
          className: 'at-cbtn at-danger',
          title: '删除该节点及以下所有内容',
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation()
            void removeNode(rt, id)
          },
        },
        '删除',
      ),
    ),
    rt.h(
      'button',
      {
        className: 'at-add',
        title: '添加子问题',
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation()
          rt.ui.addBoxFor = rt.ui.addBoxFor === id ? null : id
          rt.bump()
        },
      },
      '+',
    ),
  )
}

function AddBox(props: { rt: Runtime; parentId: string }): React.ReactElement {
  const { rt, parentId } = props
  const [text, setText] = React.useState('')
  const submit = (): void => {
    const value = text.trim()
    if (value) void addChild(rt, parentId, value)
  }
  return rt.h(
    'div',
    { className: 'at-addbox', onClick: (e: React.MouseEvent) => e.stopPropagation() },
    rt.h('textarea', {
      className: 'at-ta',
      placeholder: '输入一个子问题…',
      value: text,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          submit()
        }
      },
    }),
    rt.h(
      'div',
      { className: 'at-addbox-row' },
      rt.h(
        'button',
        {
          className: 'at-cbtn',
          onClick: () => {
            rt.ui.addBoxFor = null
            rt.bump()
          },
        },
        '取消',
      ),
      rt.h('button', { className: 'at-cbtn at-go', onClick: submit }, '添加' + (rt.ui.autoAnswer ? '并回答' : '')),
    ),
  )
}

function Inspector(props: { rt: Runtime; tree: AskTree }): React.ReactElement | null {
  const { rt, tree } = props
  rt.useVersion()
  const id = rt.ui.selectedId
  const node = id ? tree.nodes[id] : undefined
  if (!node) return null
  return rt.h(InspectorInner, { key: id, rt, node })
}

function InspectorInner(props: { rt: Runtime; node: AskNode }): React.ReactElement {
  const { rt, node } = props
  const id = node.id
  const [q, setQ] = React.useState(node.text || '')
  const [a, setA] = React.useState(node.answer || '')

  const chain: string[] = []
  {
    const nodes = rt.ui.snapshot?.tree?.nodes ?? {}
    let cur: AskNode | undefined = node
    const path: AskNode[] = []
    while (cur) {
      path.unshift(cur)
      cur = cur.parentId ? nodes[cur.parentId] : undefined
    }
    for (const p of path) chain.push(`${(p.text || '').slice(0, 18)}`)
  }

  return rt.h(
    'div',
    { className: 'at-inspector' },
    rt.h(
      'div',
      { className: 'at-insp-head' },
      rt.h('span', { className: 'at-badge' }, `Q · ${id}`),
      rt.h('span', { className: 'at-insp-path' }, chain.join(' → ')),
      rt.h('div', { className: 'at-head-spacer' }),
      rt.h(
        'button',
        {
          className: 'at-cbtn at-danger',
          onClick: () => {
            void removeNode(rt, id)
            rt.ui.selectedId = null
            rt.bump()
          },
        },
        '删除子树',
      ),
      rt.h(
        'button',
        {
          className: 'at-cbtn',
          onClick: () => {
            rt.ui.addBoxFor = id
            rt.bump()
          },
        },
        '添加子问题',
      ),
      rt.h(
        'button',
        {
          className: 'at-cbtn at-go',
          onClick: () => {
            rt.ui.loading[id] = true
            rt.bump()
            void reanswer(rt, id)
          },
        },
        '重新回答',
      ),
      rt.h('button', { className: 'at-cbtn at-go', onClick: () => void saveNode(rt, id, q, a) }, '保存修改'),
    ),
    rt.h(
      'div',
      { className: 'at-insp-grid' },
      rt.h(
        'div',
        { className: 'at-insp-col' },
        rt.h('div', { className: 'at-label' }, '问题（可编辑）'),
        rt.h('textarea', {
          className: 'at-ta',
          value: q,
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setQ(e.target.value),
        }),
        rt.h('div', { className: 'at-label' }, '回答（可编辑）'),
        rt.h('textarea', {
          className: 'at-ta at-ta-ans',
          value: a,
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setA(e.target.value),
        }),
      ),
      rt.h(
        'div',
        { className: 'at-insp-col' },
        rt.h('div', { className: 'at-label' }, 'Markdown 预览'),
        rt.h('div', { className: 'at-md at-preview', dangerouslySetInnerHTML: { __html: mdToHtml(a) } }),
      ),
    ),
  )
}

/* ============================ 槽位注册 ============================ */

function bindSlots(rt: Runtime, ctx: ClientContext): void {
  const slots = ctx.get('slots') as SlotFace | undefined
  if (!slots) return

  const styles = ctx.get('styles') as StylesFace | undefined
  styles?.insert(CANVAS_CSS)

  slots.inject('shell.overlay', () =>
    slots.register({ name: 'shell.overlay', id: 'asktree-canvas', order: 30 }, () => OverlayEntry(rt)),
  )
  slots.inject('conversation.session.header.actions', () =>
    slots.register({ name: 'conversation.session.header.actions', id: 'asktree-toggle', order: 15 }, (props) =>
      HeaderAction(rt, props),
    ),
  )
  slots.inject('conversation.input.left', () =>
    slots.register({ name: 'conversation.input.left', id: 'asktree-toggle-input', order: 5 }, (props) =>
      ComposerAction(rt, props),
    ),
  )
}

/** 供测试使用的常量导出 */
export { BW, HGAP, VGAP }
