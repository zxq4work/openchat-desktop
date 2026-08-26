/**
 * 通用 SSE 流解析器，同时支持 Chat Completions 和 Responses 格式
 */
export interface ParsedSSEEvent {
  event: string
  data: string
}

export class SSEParser {
  private buffer = ''

  parse(chunk: string): ParsedSSEEvent[] {
    // 统一换行符：\r\n 和 \r 都规范化为 \n，避免服务器用 CRLF 分隔导致解析不到事件
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const events: ParsedSSEEvent[] = []
    const parts = this.buffer.split('\n\n')
    this.buffer = parts.pop() ?? ''

    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue

      let eventType = 'message'
      const dataLines: string[] = []

      for (const line of trimmed.split('\n')) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          // 兼容 `data:xxx` 与 `data: xxx`，多行 data 拼接
          dataLines.push(line.slice(5).replace(/^ /, ''))
        }
      }

      const data = dataLines.join('\n')
      if (data) {
        events.push({ event: eventType, data })
      }
    }

    return events
  }
}