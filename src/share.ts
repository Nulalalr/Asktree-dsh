/**
 * 宿主侧分享抓取：DeepSeek 分享链接 -> 对话消息。
 *
 * 通道优先级（与动态插件版一致）：
 * 1. `web.fetch`（需宿主挂载 fetch provider，如 `@deepseek-ai/dsh-web-fetch-http`）
 * 2. `shell` + `curl.exe`（沙箱允许出网时可用）
 * 3. 都失败则经 `api.allorigins.win` 第三方代理兜底（内容会经该代理中转）
 *
 * 全部失败时抛出的错误会说明**可用通道**，便于判断是环境问题还是链接失效。
 */
import type { HostContext } from './llm.js'
import type { ShareBizData } from './types.js'

/** DeepSeek 分享内容接口 */
const SHARE_ENDPOINT = 'https://chat.deepseek.com/api/v0/share/content'

/** 第三方 CORS 代理（仅在直连失败时使用） */
const PROXY_PREFIX = 'https://api.allorigins.win/raw?url='

/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 25_000

/** `web` 服务的最小面 */
interface WebFace {
  fetch(request: { url: string }, signal?: AbortSignal): Promise<{ statusCode?: number; body?: { content?: string } }>
}

/** `shell` 服务的最小面 */
interface ShellFace {
  resolve(request: {
    command: string
    timeoutMs?: number
    stdoutMaxBytes?: number
    signal?: AbortSignal
  }): unknown
  run(spec: unknown): Promise<{ exitCode: number | null; stdout?: { text?: string } }>
}

/** 抓取结果 */
export interface ShareFetchResult {
  data: ShareBizData
  /** 实际使用的通道 */
  via: 'direct' | 'proxy'
}

/** 构造直连 URL */
export function shareUrl(shareId: string): string {
  return `${SHARE_ENDPOINT}?share_id=${encodeURIComponent(shareId)}`
}

/** 当前环境可用的网络通道名（仅用于诊断信息） */
export function availableChannels(ctx: HostContext): string[] {
  const names: string[] = []
  const web = ctx.get('web') as WebFace | undefined
  if (web && typeof web.fetch === 'function') names.push('web')
  const shell = ctx.get('shell') as ShellFace | undefined
  if (shell && typeof shell.resolve === 'function' && typeof shell.run === 'function') names.push('shell(curl)')
  return names
}

/** 经 `web.fetch` 取文本；服务缺失或抛错时返回 null */
async function getViaWeb(ctx: HostContext, url: string, signal?: AbortSignal): Promise<string | null> {
  const web = ctx.get('web') as WebFace | undefined
  if (!web || typeof web.fetch !== 'function') return null
  try {
    const response = await web.fetch({ url }, signal)
    const status = typeof response?.statusCode === 'number' ? response.statusCode : 0
    if (status < 200 || status >= 300) return null
    const content = response?.body?.content
    return typeof content === 'string' && content ? content : null
  } catch {
    return null
  }
}

/** 经 `shell` + curl 取文本；失败返回 null */
async function getViaShell(ctx: HostContext, url: string, signal?: AbortSignal): Promise<string | null> {
  const shell = ctx.get('shell') as ShellFace | undefined
  if (!shell || typeof shell.resolve !== 'function' || typeof shell.run !== 'function') return null
  try {
    const spec = shell.resolve({
      command: `curl.exe -sS -f --max-time 20 "${url}"`,
      timeoutMs: REQUEST_TIMEOUT_MS,
      stdoutMaxBytes: 4_000_000,
      signal,
    })
    const result = await shell.run(spec)
    if (result?.exitCode !== 0) return null
    const text = result?.stdout?.text
    return typeof text === 'string' && text ? text : null
  } catch {
    return null
  }
}

/** 依次尝试两个通道 */
async function fetchText(ctx: HostContext, url: string, signal?: AbortSignal): Promise<string | null> {
  const viaWeb = await getViaWeb(ctx, url, signal)
  if (viaWeb) return viaWeb
  return getViaShell(ctx, url, signal)
}

/** 解析分享响应体 */
function parseBizData(text: string | null): ShareBizData | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { data?: { biz_data?: ShareBizData } }
    return parsed?.data?.biz_data ?? null
  } catch {
    return null
  }
}

/**
 * 抓取一份分享对话。
 *
 * @throws 直连与代理都失败（或链接失效）时抛出，错误文本含可用通道提示
 */
export async function fetchShareData(
  ctx: HostContext,
  shareId: string,
  signal?: AbortSignal,
): Promise<ShareFetchResult> {
  const directUrl = shareUrl(shareId)

  const direct = parseBizData(await fetchText(ctx, directUrl, signal))
  if (direct) return { data: direct, via: 'direct' }

  const proxied = parseBizData(await fetchText(ctx, `${PROXY_PREFIX}${encodeURIComponent(directUrl)}`, signal))
  if (proxied) return { data: proxied, via: 'proxy' }

  const channels = availableChannels(ctx)
  const hint = channels.length
    ? '（当前环境疑似阻止 HTTPS 出网，或 web fetch provider 未挂载/不可用）'
    : '（本机未提供任何网络通道）'
  throw new Error(
    `无法获取分享内容：直连与第三方代理均失败，或链接已失效${hint}。` +
      '可改为手动打开分享页 → 全选复制正文，再用 asktree_parse_chat 导入（并列分支会丢失，但问答内容完整）',
  )
}
