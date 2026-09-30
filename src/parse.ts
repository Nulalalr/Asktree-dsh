/**
 * 对话文本解析与分享链接识别（AskTree 原实现的纯逻辑移植）。
 *
 * DeepSeek 分享页复制的正文里，每条回答末尾自带
 * 「本回答由 AI 生成，内容仅供参考，请仔细甄别」之类的标记，
 * 据此切段再用启发式打分拆出「问题 / 回答」最准。
 */
import type { AskTurn } from './types.js'

/** 回答结尾标记（AskTree 同款正则） */
export const AI_END_RE = /本回答由 AI 生成|内容仅供参考，请仔细甄别|由 AI 生成，仅供参考/

/** 口语化/回应式开头（更像「追问」而非「回答」） */
const Q_SPEECH_RE = /^(ok|好的|嗯|好|这样|我|感谢|谢谢|明白了|原来|但是|不过|那|那么|所以|能否|能|请|帮忙|可以|老师|您好|hi|hello)/i

/** 去掉空行并 trim */
export function chatLines(text: string): string[] {
  return String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/** 一段文本像「问题」的分数 */
export function qScore(q: string): number {
  let s = 0
  if (Q_SPEECH_RE.test(q)) s += 4
  if (/[?？]\s*$/.test(q)) s += 4
  if (q.length < 150) s += 1
  return s
}

/** 一段文本像「回答」的分数 */
export function aScore(a: string, nLines: number): number {
  let s = 0
  const first = String(a).split('\n')[0] || ''
  if (first.length >= 40) s += 2
  if (/(^#|\*\*|\||^\s*[-*]\s|^\d+[.、]\s)/m.test(a)) s += 1
  if (nLines >= 3) s += 1
  return s
}

/** 把一段（问题+回答）按最佳切分点拆开 */
export function splitQA(seg: readonly string[]): AskTurn {
  const raw = seg.slice()
  if (raw.length === 1) {
    return { q: raw[0].replace(AI_END_RE, '').replace(/\s+$/, '').trim(), a: '' }
  }
  let best = { score: -1, i: 1 }
  for (let i = 1; i < raw.length; i++) {
    const q = raw.slice(0, i).join('\n')
    const aLines = raw.slice(i)
    const score = qScore(q) + aScore(aLines.join('\n'), aLines.length)
    if (score > best.score) best = { score, i }
  }
  return {
    q: raw.slice(0, best.i).join('\n').trim(),
    a: raw
      .slice(best.i)
      .map((l) => l.replace(/\*{0,2}\s*本回答由 AI 生成[\s\S]*$/, '').trim())
      .filter(Boolean)
      .join('\n')
      .replace(/\s+$/, '')
      .trim(),
  }
}

/** 无标记文本的兜底切分：以「句尾是问号且较短」判为问题 */
export function genericTurns(lines: readonly string[]): AskTurn[] {
  const turns: AskTurn[] = []
  let q: string | null = null
  for (const l of lines) {
    if (!q) {
      q = l
      continue
    }
    if (/[?？]\s*$/.test(l) && l.length < 200) {
      q += `\n${l}`
      continue
    }
    turns.push({ q, a: l })
    q = null
  }
  if (q && turns.length) turns[turns.length - 1].a += `\n${q}`
  return turns
}

/**
 * 解析粘贴的对话正文 -> 问答轮次。
 * 优先按回答结尾标记切段；没有任何标记时退回 `genericTurns`。
 * 无法识别时返回 null。
 */
export function parseChatTurns(text: string): AskTurn[] | null {
  const lines = chatLines(text)
  if (!lines.length) return null

  const segs: string[][] = []
  let buf: string[] = []
  let hasMarker = false
  for (const l of lines) {
    buf.push(l)
    if (AI_END_RE.test(l)) {
      hasMarker = true
      segs.push(buf)
      buf = []
    }
  }
  if (buf.length) segs.push(buf)

  let turns: AskTurn[] = []
  if (hasMarker) {
    for (const seg of segs) {
      const { q, a } = splitQA(seg)
      if (q) turns.push({ q, a })
    }
  }
  if (!turns.length) turns = genericTurns(lines)
  return turns.length ? turns : null
}

/** 从分享链接或裸 id 中取出 share_id */
export function extractShareId(input: string): string | null {
  const s = String(input || '').trim()
  if (/^[a-zA-Z0-9]+$/.test(s)) return s
  const m = s.match(/share\/([a-zA-Z0-9]+)/) || s.match(/[?&]share_id=([a-zA-Z0-9]+)/i)
  return m ? m[1] : null
}

/** 解析结果是否走了「回答结尾标记」通道 */
export function isMarkerText(text: string): boolean {
  return AI_END_RE.test(text)
}
