/**
 * 极简 Markdown 渲染（AskTree 原实现移植，零依赖、XSS 安全）。
 *
 * 输出 HTML 字符串，由客户端以 `dangerouslySetInnerHTML` 挂载；
 * 所有文本先经 `esc` 转义，链接只允许 http(s)/mailto。
 */

/** HTML 转义 */
export function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内标记：代码、链接、粗体、斜体 */
export function inlineMd(raw: string): string {
  let t = esc(raw)
  const codes: string[] = []
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c)
    return `\u0000${codes.length - 1}\u0000`
  })
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt: string, url: string) => {
    const ok = /^(https?:|mailto:)/i.test(url)
    return `<a href="${ok ? url : '#'}" target="_blank" rel="noopener noreferrer">${txt}</a>`
  })
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  t = t.replace(/(^|[^a-zA-Z0-9_])_([^_]+)_/g, '$1<em>$2</em>')
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, idx: string) => `<code class="at-icode">${codes[Number(idx)]}</code>`)
  return t
}

/** 块级渲染：标题、引用、列表、代码块、段落 */
export function mdToHtml(src: string | null | undefined): string {
  if (!src) return ''
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
  let html = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // 围栏代码块
    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++
      html += `<pre class="at-code"><code>${esc(buf.join('\n'))}</code></pre>`
      continue
    }

    if (/^\s*$/.test(line)) {
      i++
      continue
    }

    // 标题
    const hd = line.match(/^(#{1,6})\s+(.*)$/)
    if (hd) {
      const lvl = hd[1].length
      html += `<h${lvl} class="at-h at-h${lvl}">${inlineMd(hd[2])}</h${lvl}>`
      i++
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      html += `<blockquote class="at-quote">${inlineMd(buf.join(' '))}</blockquote>`
      continue
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      html += `<ul class="at-ul">${items.map((it) => `<li>${inlineMd(it)}</li>`).join('')}</ul>`
      continue
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      html += `<ol class="at-ol">${items.map((it) => `<li>${inlineMd(it)}</li>`).join('')}</ol>`
      continue
    }

    // 段落（连续非空行）
    const buf: string[] = []
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^```/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    html += `<p class="at-p">${buf.map((l) => inlineMd(l)).join('<br>')}</p>`
  }
  return html
}
