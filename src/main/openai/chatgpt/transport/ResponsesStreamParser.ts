/**
 * SSE (Server-Sent Events) 解析器
 * 解析 ChatGPT backend-api/codex/responses 的 SSE 流
 */
export interface ParsedSSEEvent {
  event: string
  data: string
}

export class ResponsesStreamParser {
  private buffer = ''

  parse(chunk: string): ParsedSSEEvent[] {
    this.buffer += chunk
    const events: ParsedSSEEvent[] = []
    const parts = this.buffer.split('\n\n')
    this.buffer = parts.pop() ?? ''

    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue

      let eventType = 'message'
      let data = ''

      for (const line of trimmed.split('\n')) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim()
        } else if (line.startsWith('data: ')) {
          data = line.slice(6)
        }
      }

      if (data) {
        events.push({ event: eventType, data })
      }
    }

    return events
  }
}