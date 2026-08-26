import type { OpenChatToolDefinition, CanonicalToolResult } from '../../shared/types/provider'

export interface ToolExecutionContext {
  signal?: AbortSignal
  conversationId?: string
  segmentId?: string
}

export interface OpenChatTool {
  readonly definition: OpenChatToolDefinition
  execute(args: unknown, context: ToolExecutionContext): Promise<CanonicalToolResult>
}

export class ToolRegistry {
  private tools: Map<string, OpenChatTool> = new Map()

  register(name: string, tool: OpenChatTool): void {
    this.tools.set(name, tool)
  }

  getDefinitions(): OpenChatToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  getExecutor(name: string): OpenChatTool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }
}