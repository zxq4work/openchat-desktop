import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as http from 'http'
import { ResponsesStreamParser } from './ResponsesStreamParser'

/**
 * 本地 HTTP 服务器模拟 SSE 流，用于测试 ResponsesStreamParser
 */
function createSSEServer(events: string[]): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      })
      for (const event of events) {
        res.write(event)
      }
      res.end()
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ port: addr.port, close: () => server.close() })
    })
    server.on('error', reject)
  })
}

describe('ResponsesStreamParser', () => {
  it('parses standard SSE events', () => {
    const parser = new ResponsesStreamParser()
    const events = parser.parse(
      'data: {"type":"response.created","response":{"id":"1"}}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n'
    )

    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('message')
    expect(JSON.parse(events[0].data).type).toBe('response.created')
    expect(JSON.parse(events[1].data).delta).toBe('Hello')
  })

  it('handles named events', () => {
    const parser = new ResponsesStreamParser()
    const events = parser.parse(
      'event: custom\ndata: {"value": 42}\n\n'
    )

    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('custom')
    expect(JSON.parse(events[0].data).value).toBe(42)
  })

  it('handles [DONE] marker', () => {
    const parser = new ResponsesStreamParser()
    const events = parser.parse('data: [DONE]\n\n')

    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('[DONE]')
  })

  it('handles partial chunks (buffering)', () => {
    const parser = new ResponsesStreamParser()

    const events1 = parser.parse('data: {"type":"response.created"')
    expect(events1).toHaveLength(0) // incomplete

    const events2 = parser.parse(',"response":{"id":"1"}}\n\n')
    expect(events2).toHaveLength(1)
    expect(JSON.parse(events2[0].data).type).toBe('response.created')
  })

  it('ignores empty SSE blocks', () => {
    const parser = new ResponsesStreamParser()
    const events = parser.parse('\n\n\n\n')
    expect(events).toHaveLength(0)
  })

  it('handles malformed JSON gracefully', () => {
    const parser = new ResponsesStreamParser()
    const events = parser.parse('data: not-json\n\n')
    // 解析出来的事件存在，但 JSON.parse 在调用方处理
    expect(events).toHaveLength(1)
    expect(events[0].data).toBe('not-json')
  })
})

describe('MockChatGPTCodexClient', () => {
  it('sendsResponses yields all event types', async () => {
    const { MockChatGPTCodexClient } = await import('./ChatGPTCodexClient')

    const client = new MockChatGPTCodexClient()
    const events: unknown[] = []

    for await (const event of client.sendResponses({
      model: 'gpt-5',
      instructions: 'You are helpful.',
      input: [{ role: 'user', content: 'Hello' }],
    })) {
      events.push(event)
    }

    // 至少应该包含 response.created, delta, response.output_text.done, response.completed
    expect(events.length).toBeGreaterThanOrEqual(4)
    expect(events[0]).toHaveProperty('type', 'response.created')
  })

  it('respects AbortSignal', async () => {
    const { MockChatGPTCodexClient } = await import('./ChatGPTCodexClient')

    const client = new MockChatGPTCodexClient()
    const controller = new AbortController()
    const events: unknown[] = []

    // 立即中断
    controller.abort()

    try {
      for await (const event of client.sendResponses({
        model: 'gpt-5',
        instructions: '',
        input: [{ role: 'user', content: 'Hi' }],
      }, controller.signal)) {
        events.push(event)
      }
    } catch {
      // 预期行为
    }

    expect(events.length).toBe(0)
  })
})