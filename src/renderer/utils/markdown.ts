import MarkdownIt from 'markdown-it'

let md: MarkdownIt | null = null

function getMarkdownInstance(): MarkdownIt {
  if (!md) {
    md = new MarkdownIt({
      html: false,
      linkify: true,
      breaks: true,
      typographer: true,
    })
  }
  return md
}

export function renderMarkdown(text: string): string {
  if (!text) return ''
  return getMarkdownInstance().render(text)
}