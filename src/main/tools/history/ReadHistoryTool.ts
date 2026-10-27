// 统一只读历史工具（OpenChat 提供，协议无关）。
//
// 与「模型当前可调用的联网工具」（openchat_web_search / openchat_web_fetch / Codex run）严格区分：
// 本工具**只读本地已持久化的历史工具结果**，绝不再联网、绝不重新执行任何历史工具、
// 绝不从模型此前的回答推断结果。
//
// 作用域：构造时注入**当前会话**的消息（由调用方按 conversationId 解析）。
// 因此工具只能读取当前授权会话的历史，无法跨会话读取其它会话或私有数据。
//
// 为什么由 OpenChat 提供而非目标 Provider：
//   历史工具调用可能来自别的 Provider（如 Codex standalone 的 run@web）。
//   目标 Provider 的历史里本没有可调用的原工具，本工具让任意具备 tool-calling 能力的
//   Provider 都能通过统一接口按需读取真实历史结果，无需目标 Provider 理解原工具名。

import type { OpenChatTool, ToolExecutionContext } from '../ToolRegistry'
import type { OpenChatToolDefinition, CanonicalToolResult } from '../../../shared/types/provider'
import type { Message } from '../../../shared/types/conversation'
import { collectHistoryToolCalls, readHistoryCallChunk } from './historyToolResultReader'

export const READ_HISTORY_TOOL_NAME = 'openchat_read_history'

// 单次 read 返回的最大字符数（默认分页大小）。分页让长结果可被连续读取直至取完。
const DEFAULT_PAGE_SIZE = 4000

export const READ_HISTORY_TOOL_DEFINITION: OpenChatToolDefinition = {
  name: READ_HISTORY_TOOL_NAME,
  description:
    'Read the COMPLETE, real content of tool results recorded EARLIER in THIS conversation ' +
    '(web searches, page fetches, and other past tool calls), regardless of which provider produced them. ' +
    'This reads local saved history only: it does NOT search the web again, does NOT re-run any past tool, ' +
    'and does NOT rely on what an earlier assistant message claimed. ' +
    'Use this when the user asks to list, enumerate, quote, or re-examine anything produced by past tool calls ' +
    '(for example: "list all sources from the previous search", "show me the full result you got earlier"). ' +
    'Call it with action="list" first to see available calls (each with callId, name, outputLength). ' +
    'Then call action="read" with a callId to get the real output; long outputs are paged — ' +
    'continue reading with the returned nextOffset until hasMore is false. ' +
    'Source attribution: callSources is a single call\'s OWN returned sources (null means unknown / not recorded per-call); ' +
    'messageSources is the whole assistant message aggregate and must NOT be attributed to one call.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read'],
        description: 'list = enumerate historical tool calls in this conversation; read = fetch one call\'s real output by callId.',
      },
      callId: {
        type: 'string',
        description: 'The callId from a previous list result. Required when action="read".',
      },
      offset: {
        type: 'number',
        description: 'Character offset to start reading from (for paging long outputs). Default 0.',
      },
      limit: {
        type: 'number',
        description: 'Maximum characters to return in this page. Default 4000, capped per call; long outputs are paged via nextOffset.',
      },
    },
    required: ['action'],
  },
}

interface ReadHistoryArgs {
  action?: unknown
  callId?: unknown
  offset?: unknown
  limit?: unknown
}

export class ReadHistoryTool implements OpenChatTool {
  definition = READ_HISTORY_TOOL_DEFINITION
  // 当前会话的消息快照（构造时注入，作用域限定在该会话）。
  private scopedMessages: Message[]

  constructor(scopedMessages: Message[]) {
    this.scopedMessages = scopedMessages
  }

  async execute(args: unknown, _context: ToolExecutionContext): Promise<CanonicalToolResult> {
    const a = (args ?? {}) as ReadHistoryArgs
    const action = a.action === 'read' ? 'read' : a.action === 'list' ? 'list' : null

    if (!action) {
      return this.error('HISTORY_INVALID_ACTION', 'action must be "list" or "read"')
    }

    if (action === 'list') {
      const calls = collectHistoryToolCalls(this.scopedMessages).map((c) => ({
        callId: c.callId,
        kind: c.kind,
        name: c.name,
        ...(c.namespace ? { namespace: c.namespace } : {}),
        arguments: c.arguments,
        outputLength: c.outputLength,
        isError: c.isError,
        ...(c.sourceProvider ? { sourceProvider: c.sourceProvider } : {}),
        ...(c.sourceProtocol ? { sourceProtocol: c.sourceProtocol } : {}),
        createdAt: c.createdAt,
        // 单次调用自身来源数量；null = 持久化未保存按调用归属的来源（归属未知）。
        callSourceCount: c.callSourceCount,
        // 整条助手消息聚合来源数量（message-level，非该调用自身）。
        messageSourceCount: c.messageSourceCount,
      }))
      return {
        callId: '',
        name: READ_HISTORY_TOOL_NAME,
        output: JSON.stringify({
          action: 'list',
          count: calls.length,
          calls,
          note:
            calls.length === 0
              ? 'No historical tool calls are recorded in this conversation.'
              : 'Use action="read" with a callId to fetch the real recorded output. Long outputs are paged via nextOffset. ' +
                'Source counts: callSourceCount is this call\'s OWN returned sources (null = unknown / not recorded per-call); ' +
                'messageSourceCount is the whole assistant message\'s aggregate and must NOT be attributed to a single call.',
        }),
      }
    }

    // action === 'read'
    if (typeof a.callId !== 'string' || !a.callId.trim()) {
      return this.error('HISTORY_MISSING_CALL_ID', 'callId is required when action="read"')
    }
    const offset = typeof a.offset === 'number' ? a.offset : 0
    const limit = typeof a.limit === 'number' ? a.limit : DEFAULT_PAGE_SIZE

    const chunk = readHistoryCallChunk(this.scopedMessages, a.callId.trim(), offset, limit)
    if (!chunk) {
      return this.error(
        'HISTORY_CALL_NOT_FOUND',
        `No recorded tool call with callId="${a.callId}" in this conversation. Call action="list" to see available callIds.`
      )
    }

    // Hosted 服务端搜索：上游未回传完整网页正文，只能列举来源元数据。
    if (chunk.kind === 'hosted_search') {
      return {
        callId: '',
        name: READ_HISTORY_TOOL_NAME,
        output: JSON.stringify({
          action: 'read',
          callId: chunk.callId,
          kind: 'hosted_search',
          name: chunk.name,
          arguments: chunk.arguments,
          sourceProvider: chunk.sourceProvider,
          sourceProtocol: chunk.sourceProtocol,
          createdAt: chunk.createdAt,
          totalLength: 0,
          hasMore: false,
          nextOffset: null,
          content: '',
          // 该次 hosted 搜索自身返回的来源（action.sources）。
          callSources: chunk.callSources,
          // 整条助手消息的聚合来源（message-level），不可归属到单次调用。
          messageSources: chunk.messageSources,
          note:
            'This was a hosted (server-side) web search. OpenChat saved only the source metadata returned by the server; ' +
            'the full webpage bodies were never provided to OpenChat, so they cannot be read in full. ' +
            'callSources are this search call\'s OWN sources; messageSources is the whole assistant message aggregate and must NOT be attributed to this call.',
        }),
      }
    }

    return {
      callId: '',
      name: READ_HISTORY_TOOL_NAME,
      output: JSON.stringify({
        action: 'read',
        callId: chunk.callId,
        kind: chunk.kind,
        name: chunk.name,
        ...(chunk.namespace ? { namespace: chunk.namespace } : {}),
        arguments: chunk.arguments,
        sourceProvider: chunk.sourceProvider,
        sourceProtocol: chunk.sourceProtocol,
        createdAt: chunk.createdAt,
        offset: chunk.offset,
        limit: chunk.limit,
        returnedLength: chunk.returnedLength,
        totalLength: chunk.totalLength,
        hasMore: chunk.hasMore,
        nextOffset: chunk.nextOffset,
        content: chunk.content,
        // 该单次调用自身来源；null = 持久化未保存按调用归属的来源（归属未知，绝不伪造）。
        callSources: chunk.callSources,
        // 整条助手消息的聚合来源（message-level），不可归属到单次调用。
        messageSources: chunk.messageSources,
        note: chunk.callSources
          ? 'callSources are this call\'s OWN returned sources. messageSources is the whole assistant message aggregate — do NOT attribute it to this single call.'
          : 'callSources is null: OpenChat did NOT persist per-call source attribution for this tool call, so its own sources are UNKNOWN. ' +
            'messageSources is the whole assistant message aggregate and must NOT be presented as this call\'s own sources.',
      }),
    }
  }

  private error(code: string, message: string): CanonicalToolResult {
    return {
      callId: '',
      name: READ_HISTORY_TOOL_NAME,
      output: JSON.stringify({ error: code, message }),
      isError: true,
    }
  }
}
