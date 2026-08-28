import type { ProviderPayloadV2, ProviderPayloadItem } from '../../../../shared/types/provider'
import type { Message } from '../../../../shared/types/conversation'

export interface SearchProvenance {
  mode: 'hosted' | 'standalone' | 'custom'
  mechanism: string
  queries: string[]
  assistantMessageId: string
}

// 从 Provider History items 解析所有搜索来源（按时间正序）
export function resolveAllSearchProvenance(
  segmentMessages: Message[]
): SearchProvenance[] {
  const results: SearchProvenance[] = []

  for (let i = 0; i < segmentMessages.length; i++) {
    const msg = segmentMessages[i]
    if (msg.role !== 'assistant' || msg.status !== 'completed') continue
    if (!msg.providerPayloadJson) continue

    let items: ProviderPayloadItem[] = []
    try {
      const payload = JSON.parse(msg.providerPayloadJson) as Record<string, unknown>
      if (payload.items && Array.isArray(payload.items)) {
        items = (payload as unknown as ProviderPayloadV2).items
      } else if (payload.toolCalls && Array.isArray(payload.toolCalls)) {
        const calls = payload.toolCalls as Array<{ id: string; name: string; namespace?: string; arguments: string; output: string }>
        for (const tc of calls) {
          items.push({ type: 'function_call', call_id: tc.id, name: tc.name, namespace: tc.namespace, arguments: tc.arguments })
          if (tc.output) {
            items.push({ type: 'function_call_output', call_id: tc.id, output: tc.output })
          }
        }
      } else if (payload.hostedSearchCalls) {
        continue
      } else {
        continue
      }
    } catch {
      continue
    }

    if (items.length === 0) continue

    const provenance = analyzeItems(items, msg.id)
    if (provenance) {
      results.push(provenance)
    }
  }

  return results
}

function analyzeItems(items: ProviderPayloadItem[], assistantId: string): SearchProvenance | null {
  let lastSearchType: 'hosted' | 'standalone' | 'custom' | null = null
  let queries: string[] = []

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.type === 'web_search_call') {
      lastSearchType = 'hosted'
      if (item.action?.query) queries.unshift(item.action.query)
      if (item.action?.queries) queries.unshift(...item.action.queries)
      break
    }
    if (item.type === 'function_call' && item.name === 'run' && (item.namespace === 'web' || isStandaloneByArgs(item))) {
      lastSearchType = 'standalone'
      try {
        const args = JSON.parse(item.arguments) as Record<string, unknown>
        const searchQuery = args.search_query as Array<{ q: string }> | undefined
        if (searchQuery) {
          queries = searchQuery.map((sq) => sq.q)
        }
      } catch {
        // 无法解析
      }
      break
    }
    if (item.type === 'function_call' && item.name === 'openchat_web_search') {
      lastSearchType = 'custom'
      try {
        const args = JSON.parse(item.arguments) as Record<string, unknown>
        if (typeof args.query === 'string') queries = [args.query]
      } catch {
        // 无法解析
      }
      break
    }
  }

  if (!lastSearchType) return null

  const mechanismMap: Record<string, string> = {
    hosted: 'web_search_call',
    standalone: 'web.run',
    custom: 'openchat_web_search',
  }

  return {
    mode: lastSearchType,
    mechanism: mechanismMap[lastSearchType],
    queries,
    assistantMessageId: assistantId,
  }
}

// 当 namespace 字段缺失时，通过 arguments 内容判断是否为 standalone web.run
function isStandaloneByArgs(item: { type: 'function_call'; name: string; arguments: string }): boolean {
  if (item.name !== 'run') return false
  try {
    const args = JSON.parse(item.arguments) as Record<string, unknown>
    return !!args.search_query || !!args.commands
  } catch {
    return false
  }
}

// 构建 transient developer context（所有历史搜索）
export function buildAllProvenanceContext(provenances: SearchProvenance[]): string {
  if (provenances.length === 0) return ''

  const entries = provenances.map((p, idx) => {
    const queriesStr = p.queries.length > 0
      ? p.queries.map((q) => `      - ${q}`).join('\n')
      : '      (queries not available)'
    return `  ${idx + 1}. mode: ${p.mode}, mechanism: ${p.mechanism}
    queries:
${queriesStr}`
  }).join('\n')

  return `<!-- OPENCHAT_SEARCH_PROVENANCE_V1 -->
All completed searches in this conversation (in chronological order):

${entries}

This metadata is deterministically derived from actual provider history.
When answering questions about which search mechanism was used, treat this metadata as authoritative.
- mode "hosted" = Hosted Web Search (web_search_call). Do NOT call it Standalone or web.run.
- mode "standalone" = Standalone Web Search (web.run). Do NOT call it Hosted.
- mode "custom" = OpenChat Custom Web Search (openchat_web_search).
The current session's search capability does NOT override these historical facts.`
}
