// Markdown 渲染：GitHub Release 正文等远端内容走这里转 HTML
import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({
  gfm: true,
  // Release 正文里的手动换行是有意义的，按 GitHub 的习惯直接换行
  breaks: true
})

/**
 * 把 Markdown 转成可安全 v-html 的 HTML。
 * 内容来自 GitHub 接口，属于外部输入，必须过一遍 DOMPurify，
 * 否则 Release 正文里的 <script>、onerror、javascript: 都会在渲染进程里生效。
 */
export function renderMarkdown(source: string): string {
  const text = (source || '').trim()
  if (!text) return ''
  const html = marked.parse(text, { async: false })
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}

/**
 * v-html 渲染出来的链接如果直接点会把整个应用窗口导航走，
 * 容器上挂这个处理器，拦下 http(s) 链接改用系统浏览器打开。
 */
export function handleMarkdownClick(event: MouseEvent): void {
  const anchor = (event.target as HTMLElement | null)?.closest('a')
  if (!anchor) return
  event.preventDefault()
  const href = anchor.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href)) void window.api.openExternal(href)
}
