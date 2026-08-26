/**
 * Responses API Tool Calling Protocol Probe
 *
 * 用法：node scripts/probe-responses-tools.mjs
 *
 * 通过环境变量配置：
 *   OPENCHAT_PROBE_BASE_URL  — 默认 https://example.com/api-proxy/v1
 *   OPENCHAT_PROBE_API_KEY   — API Key
 *   OPENCHAT_PROBE_MODEL     — 默认 qwen3.8-max
 *   HTTPS_PROXY              — 可选代理
 */

import * as https from 'https'
import * as http from 'http'

const BASE_URL = (process.env.OPENCHAT_PROBE_BASE_URL || 'https://example.com/api-proxy/v1').replace(/\/+$/, '')
const API_KEY = process.env.OPENCHAT_PROBE_API_KEY || ''
const MODEL = process.env.OPENCHAT_PROBE_MODEL || 'qwen3.8-max'

let RESPONSES_PATH = '/responses'
if (BASE_URL.endsWith('/v1')) {
  RESPONSES_PATH = '/responses'
} else {
  RESPONSES_PATH = '/v1/responses'
}

// --- Proxy (from httpsClient.ts) ---
function getProxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    null
  )
}

function isPrivateOrLocalHost(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true
  if (hostname.endsWith('.local')) return true
  const parts = hostname.split('.')
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const a = parseInt(parts[0], 10)
    const b = parseInt(parts[1], 10)
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 0) return true
  }
  return false
}

function getProxyAgent() {
  const proxyUrl = getProxyUrl()
  if (!proxyUrl) return undefined
  // Lazy-load https-proxy-agent
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent')
    return new HttpsProxyAgent(proxyUrl)
  } catch {
    return undefined
  }
}

function getProxyAgentForHost(hostname) {
  if (isPrivateOrLocalHost(hostname)) return undefined
  return getProxyAgent()
}

// --- SSE Parser (from SSEParser.ts) ---
class SSEParser {
  constructor() {
    this.buffer = ''
  }
  parse(chunk) {
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const events = []
    const parts = this.buffer.split('\n\n')
    this.buffer = parts.pop() ?? ''

    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue

      let eventType = 'message'
      const dataLines = []
      for (const line of trimmed.split('\n')) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
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

// --- Stream Request ---
function streamRequest(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const bodyStr = JSON.stringify(body)
    const bodyBytes = Buffer.byteLength(bodyStr)
    const headers = {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Content-Length': String(bodyBytes),
    }
    const isHttps = parsed.protocol === 'https:'
    const lib = isHttps ? https : http
    const defaultPort = isHttps ? 443 : 80
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : defaultPort,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        agent: getProxyAgentForHost(parsed.hostname),
      },
      (res) => {
        if (res.statusCode != null && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res)
          return
        }
        let errBody = ''
        res.on('data', (chunk) => { errBody += chunk.toString() })
        res.on('end', () => {
          reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`))
        })
      }
    )
    req.on('error', reject)
    req.write(bodyStr)
    req.end()
  })
}

async function* streamEvents(url, body) {
  const stream = await streamRequest(url, body)
  const chunks = []
  let streamEnded = false
  let streamError = null
  let notify = null

  stream.on('data', (chunk) => { chunks.push(chunk); if (notify) { const n = notify; notify = null; n() } })
  stream.on('end', () => { streamEnded = true; if (notify) { const n = notify; notify = null; n() } })
  stream.on('error', (err) => { streamError = err; streamEnded = true; if (notify) { const n = notify; notify = null; n() } })

  const parser = new SSEParser()
  let chunkIdx = 0
  while (true) {
    while (chunkIdx >= chunks.length && !streamEnded) {
      await new Promise((resolve) => { notify = resolve })
    }
    if (chunkIdx >= chunks.length && streamEnded) {
      if (streamError) throw streamError
      return
    }
    const chunk = chunks[chunkIdx++]
    const events = parser.parse(chunk.toString())
    for (const sseEvent of events) {
      if (sseEvent.data === '[DONE]') return
      yield sseEvent.data
    }
  }
}

// --- Probe Runner ---
async function runProbe(label, probeConfig) {
  console.log(`\n${'='.repeat(70)}`)
  console.log(`[Probe ${label}]`)
  console.log(`${'='.repeat(70)}`)

  const { tools, toolChoice, input, instructions } = probeConfig

  const body = {
    model: MODEL,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }],
    stream: true,
    tools,
    tool_choice: toolChoice,
  }
  if (instructions) {
    body.instructions = instructions
  }

  console.log(`[Probe ${label}] Request body:`)
  console.log(JSON.stringify({ ...body, input: '[truncated]' }, null, 2))

  const url = `${BASE_URL}${RESPONSES_PATH}`
  const eventTypes = []
  let functionCalls = []
  let webSearchCalls = []
  let outputText = ''
  let responseOutput = null
  let error = null

  try {
    for await (const eventData of streamEvents(url, body)) {
      try {
        const parsed = JSON.parse(eventData)
        const eventType = parsed.type ?? 'unknown'
        eventTypes.push(eventType)

        if (eventType === 'response.output_text.delta') {
          outputText += (parsed.delta || '')
        }
        if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
          const item = parsed.item
          if (item?.type === 'function_call') {
            functionCalls.push({
              source: eventType,
              call_id: item.call_id,
              name: item.name,
              arguments: item.arguments,
              id: item.id,
            })
          }
        }
        if (eventType === 'response.function_call_arguments.done') {
          functionCalls.push({
            source: 'function_call_arguments.done',
            item_id: parsed.item_id,
            name: parsed.name,
            arguments: parsed.arguments,
          })
        }
        if (eventType.startsWith('response.web_search_call')) {
          webSearchCalls.push({ type: eventType, item_id: parsed.item_id })
          if (eventType === 'response.web_search_call.completed') {
            const action = parsed.action
            if (action) {
              webSearchCalls[webSearchCalls.length - 1].query = action.query
              webSearchCalls[webSearchCalls.length - 1].sources = action.sources
            }
          }
        }
        if (eventType === 'response.completed') {
          responseOutput = parsed.response?.output
          if (parsed.response?.usage) {
            const usage = parsed.response.usage
            console.log(`[Probe ${label}] Usage:`, JSON.stringify({
              total_tokens: usage.total_tokens,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              x_tools: usage.x_tools,
            }))
          }
        }
        if (eventType === 'response.failed') {
          error = { code: parsed.code || 'response.failed', message: parsed.message || JSON.stringify(parsed).slice(0, 500) }
        }
        if (eventType === 'error') {
          error = { code: parsed.code, message: parsed.message }
        }
      } catch {
        // skip
      }
    }
  } catch (err) {
    error = { code: 'STREAM_ERROR', message: err.message }
  }

  console.log(`[Probe ${label}] Event types:`, eventTypes.join(', '))
  console.log(`[Probe ${label}] Output text:`, outputText.slice(0, 200) || '(empty)')

  if (functionCalls.length > 0) {
    console.log(`[Probe ${label}] Function calls:`)
    for (const fc of functionCalls) {
      console.log(`  source=${fc.source}  name=${fc.name}  call_id=${fc.call_id}  args=${(fc.arguments || '').slice(0, 200)}`)
    }
  } else {
    console.log(`[Probe ${label}] Function calls: NONE`)
  }

  if (webSearchCalls.length > 0) {
    console.log(`[Probe ${label}] Web search calls:`)
    for (const wsc of webSearchCalls) {
      console.log(`  type=${wsc.type}  query=${wsc.query || 'N/A'}  sources=${wsc.sources ? wsc.sources.length : 'N/A'}`)
    }
  } else {
    console.log(`[Probe ${label}] Web search calls: NONE`)
  }

  if (error) {
    console.log(`[Probe ${label}] Error:`, JSON.stringify(error))
  }

  if (responseOutput && functionCalls.length === 0) {
    // Show output summary for function_call detection
    const outputTypes = responseOutput.map((o) => o.type)
    console.log(`[Probe ${label}] Response output types:`, outputTypes.join(', '))
  }

  return {
    label,
    eventTypes,
    functionCalls,
    webSearchCalls,
    error,
    hasFunctionCall: functionCalls.length > 0,
    hasWebSearchCall: webSearchCalls.length > 0,
  }
}

// --- Main ---
console.log(`Base URL: ${BASE_URL}${RESPONSES_PATH}`)
console.log(`Model: ${MODEL}`)
console.log(`API Key: ${API_KEY ? '***' + API_KEY.slice(-4) : '(not set)'}`)

if (!API_KEY) {
  console.error('\nERROR: OPENCHAT_PROBE_API_KEY is required.')
  console.error('  export OPENCHAT_PROBE_API_KEY="your-api-key"')
  process.exit(1)
}

// Probe A: Non-conflicting custom function name
const resultA = await runProbe('A', {
  tools: [{
    type: 'function',
    name: 'openchat_probe',
    description: 'Return information requested by the user.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }],
  toolChoice: 'required',
  input: '请调用提供的工具查询 hello',
})

// Probe B: OpenChat search function with new namespaced name
const resultB = await runProbe('B', {
  tools: [{
    type: 'function',
    name: 'openchat_web_search',
    description: 'Search the web using the search service provided by OpenChat.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }],
  toolChoice: 'required',
  input: '搜索 OpenAI 最新消息',
})

// Probe C: Confirm web_search name collision
const resultC = await runProbe('C', {
  tools: [{
    type: 'function',
    name: 'web_search',
    description: 'Search the web.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }],
  toolChoice: 'required',
  input: '搜索 OpenAI 最新消息',
})

// Probe D: Built-in web_search (type=web_search, not type=function)
const resultD = await runProbe('D', {
  tools: [{ type: 'web_search' }],
  toolChoice: 'required',
  input: 'OpenAI 最新消息',
})

// Probe E: openchat_web_search with tool_choice: auto (not required)
const resultE = await runProbe('E', {
  tools: [{
    type: 'function',
    name: 'openchat_web_search',
    description: 'Search the web using the search service provided by OpenChat.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }],
  toolChoice: 'auto',
  input: '搜索 OpenAI 最新消息',
})

// Probe F: openchat_probe with tool_choice: auto (not required)
const resultF = await runProbe('F', {
  tools: [{
    type: 'function',
    name: 'openchat_probe',
    description: 'Return information requested by the user.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  }],
  toolChoice: 'auto',
  input: '请调用提供的工具查询 hello',
})

// --- Summary ---
console.log(`\n${'='.repeat(70)}`)
console.log('SUMMARY')
console.log(`${'='.repeat(70)}`)

console.log(`\nProbe A (openchat_probe):`)
console.log(`  event types: ${resultA.eventTypes.join(', ')}`)
console.log(`  function_call: ${resultA.hasFunctionCall ? 'YES' : 'NO'}`)
if (resultA.hasFunctionCall) {
  for (const fc of resultA.functionCalls) {
    console.log(`  function name: ${fc.name}`)
  }
}

console.log(`\nProbe B (openchat_web_search):`)
console.log(`  event types: ${resultB.eventTypes.join(', ')}`)
console.log(`  function_call: ${resultB.hasFunctionCall ? 'YES' : 'NO'}`)
if (resultB.hasFunctionCall) {
  for (const fc of resultB.functionCalls) {
    console.log(`  function name: ${fc.name}`)
  }
}

console.log(`\nProbe C (web_search):`)
console.log(`  became web_search_call: ${resultC.hasWebSearchCall ? 'YES' : 'NO'}`)
console.log(`  function_call: ${resultC.hasFunctionCall ? 'YES' : 'NO'}`)

console.log(`\nProbe D (built-in web_search):`)
if (resultD.hasWebSearchCall) {
  for (const wsc of resultD.webSearchCalls) {
    if (wsc.query) console.log(`  action.query: ${wsc.query}`)
    if (wsc.sources !== undefined) console.log(`  sources count: ${wsc.sources.length}`)
  }
} else {
  console.log(`  web_search_call: NO`)
}
if (resultD.error) console.log(`  error: ${JSON.stringify(resultD.error)}`)

console.log(`\nProbe E (openchat_web_search, tool_choice=auto):`)
console.log(`  event types: ${resultE.eventTypes.join(', ')}`)
console.log(`  function_call: ${resultE.hasFunctionCall ? 'YES' : 'NO'}`)
if (resultE.hasFunctionCall) {
  for (const fc of resultE.functionCalls) {
    console.log(`  function name: ${fc.name}`)
  }
}
if (resultE.error) console.log(`  error: ${JSON.stringify(resultE.error)}`)

console.log(`\nProbe F (openchat_probe, tool_choice=auto):`)
console.log(`  event types: ${resultF.eventTypes.join(', ')}`)
console.log(`  function_call: ${resultF.hasFunctionCall ? 'YES' : 'NO'}`)
if (resultF.hasFunctionCall) {
  for (const fc of resultF.functionCalls) {
    console.log(`  function name: ${fc.name}`)
  }
}
if (resultF.error) console.log(`  error: ${JSON.stringify(resultF.error)}`)

console.log(`\nFinal conclusion:`)
console.log(`  1. Custom function supported (F): ${resultF.hasFunctionCall ? 'YES' : 'NO'}`)
console.log(`  2. openchat_web_search function_call (E): ${resultE.hasFunctionCall ? 'YES' : 'NO'}`)
console.log(`  3. tool_choice=required causes failure: ${resultA.error ? 'YES (all failed)' : 'NO'}`)
console.log(`  4. PreSearch still needed: ${resultE.hasFunctionCall ? 'NO (standard ToolLoop works)' : 'YES'}`)
console.log(`  5. Can restore standard ToolLoop: ${resultE.hasFunctionCall ? 'YES' : 'NO'}`)