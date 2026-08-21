import type { SearchRequest, SearchResponse } from '../../../../shared/types/webSearch'

export interface WebSearchExecutionRequest {
  searchRequest: SearchRequest
}

export interface WebSearchExecutionResult {
  output: string
  rawResults: unknown[]
  encryptedOutput?: string
}

export interface WebSearchProvider {
  id: string

  execute(
    request: WebSearchExecutionRequest,
    signal?: AbortSignal
  ): Promise<WebSearchExecutionResult>
}