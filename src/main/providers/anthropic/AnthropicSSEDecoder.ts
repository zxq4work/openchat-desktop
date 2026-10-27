// Anthropic Messages API 的字节级 SSE 解码器。
//
// 与通用 SSEParser 的区别：Anthropic 的流必须能抵抗
//   - UTF-8 多字节字符被拆分到两个 chunk
//   - 单个事件跨越多个网络包
//   - 一个包包含多个事件
//   - \n\n 与 \r\n\r\n 两种分隔
//   - data: 多行拼接、注释行、空行、未知字段
//   - EOF 时尚未闭合的事件（合法收尾）
// 因此使用流式 TextDecoder + 跨 chunk 的行/事件缓冲区，绝不 chunk.toString().split('\n\n')。
//
// 输出只包含「完整事件」；残余不完整数据留在内部缓冲区，由 flush() 在 EOF 时收尾。

export interface AnthropicSSEEvent {
  event: string
  data: string
}

export class AnthropicSSEDecoder {
  private decoder = new TextDecoder('utf-8')
  // 尚未遇到事件分隔符的原始文本缓冲（已解码）。
  private buffer = ''
  // 当前事件已读取到的字段。
  private currentEvent = ''
  private dataLines: string[] = []
  private hasData = false

  // 喂入一个 Uint8Array；返回本次能确定的完整事件列表。
  feed(chunk: Uint8Array): AnthropicSSEEvent[] {
    const text = this.decoder.decode(chunk, { stream: true })
    return this.consume(text, false)
  }

  // EOF 收尾：刷新解码器，并把缓冲中最后一个合法事件（若完整）产出。
  flush(): AnthropicSSEEvent[] {
    const tail = this.decoder.decode()
    const events = this.consume(tail, true)
    // 处理缓冲区中最后一个未以空行结束的事件：只要它有 data 即视为完整事件（合法 EOF）。
    const trailing = this.drainTrailing()
    if (trailing) events.push(trailing)
    return events
  }

  private consume(text: string, eof: boolean): AnthropicSSEEvent[] {
    this.buffer += text
    const events: AnthropicSSEEvent[] = []

    // 统一 \r\n / \r 为 \n，再按行处理。注意：只在完整行上做归一，
    // 保留末尾可能被拆分的 \r（等待下一段）。
    while (true) {
      const nl = this.buffer.indexOf('\n')
      if (nl === -1) break
      let line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      const ev = this.processLine(line)
      if (ev) events.push(ev)
    }

    if (eof) {
      // 末尾无换行的残余行也处理掉（合法 EOF）
      if (this.buffer.length > 0) {
        let line = this.buffer
        if (line.endsWith('\r')) line = line.slice(0, -1)
        this.buffer = ''
        const ev = this.processLine(line)
        if (ev) events.push(ev)
      }
    }
    return events
  }

  // 处理一行；遇到空行（事件分隔）时返回已累积事件。
  private processLine(line: string): AnthropicSSEEvent | null {
    if (line === '') {
      return this.finishEvent()
    }
    if (line.startsWith(':')) {
      // SSE 注释 / 心跳行，忽略
      return null
    }
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // 规范：字段名后单个可选空格需移除
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') {
      this.currentEvent = value
    } else if (field === 'data') {
      this.hasData = true
      this.dataLines.push(value)
    }
    // 其它字段（id / retry 等）忽略
    return null
  }

  private finishEvent(): AnthropicSSEEvent | null {
    if (!this.hasData && !this.currentEvent) return null
    const ev: AnthropicSSEEvent = {
      event: this.currentEvent || 'message',
      data: this.dataLines.join('\n'),
    }
    this.currentEvent = ''
    this.dataLines = []
    this.hasData = false
    // 只有 data 的事件才产出；纯 event 行无意义。
    if (!ev.data) return null
    return ev
  }

  // EOF 时缓冲区可能剩一个「未以空行结束」的事件。
  private drainTrailing(): AnthropicSSEEvent | null {
    // consume(eof) 已把残余行交给 processLine，事件字段仍累积在 currentEvent/dataLines 中。
    return this.finishEvent()
  }
}
