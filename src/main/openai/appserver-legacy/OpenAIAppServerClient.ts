import { AppServerRpcClient } from './AppServerRpcClient'
import type { InitializeParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/InitializeParams'
import type { InitializeResponse } from '../../../../vendor/openai/codex-0.148.0/schema-ts/InitializeResponse'
import type { GetAccountParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/GetAccountParams'
import type { GetAccountResponse } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/GetAccountResponse'
import type { LoginAccountParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/LoginAccountParams'
import type { LoginAccountResponse } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/LoginAccountResponse'
import type { CancelLoginAccountParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/CancelLoginAccountParams'
import type { ModelListParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/ModelListParams'
import type { ModelListResponse } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/ModelListResponse'
import type { ThreadStartParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/ThreadStartParams'
import type { ThreadStartResponse } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/ThreadStartResponse'
import type { ThreadResumeParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/ThreadResumeParams'
import type { ThreadResumeResponse } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/ThreadResumeResponse'
import type { ThreadDeleteParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/ThreadDeleteParams'
import type { TurnStartParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/TurnStartParams'
import type { TurnStartResponse } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/TurnStartResponse'
import type { TurnInterruptParams } from '../../../../vendor/openai/codex-0.148.0/schema-ts/v2/TurnInterruptParams'

/**
 * Protocol Adapter — 统一所有 OpenAI App Server RPC 调用
 * 业务代码不直接调用 rpc.request('thread/start', ...)
 * 这样以后升级协议时只改 adapter
 *
 * @deprecated App Server 已不作为默认 Provider，保留用于兼容。
 */
export class OpenAIAppServerClient {
  private rpc: AppServerRpcClient

  constructor(rpc: AppServerRpcClient) {
    this.rpc = rpc
  }

  async initialize(params: InitializeParams): Promise<InitializeResponse> {
    return this.rpc.request<InitializeResponse>('initialize', params)
  }

  initialized(): void {
    this.rpc.notify('initialized', {})
  }

  async readAccount(params: GetAccountParams = {}): Promise<GetAccountResponse> {
    return this.rpc.request<GetAccountResponse>('account/read', params)
  }

  async loginChatGPT(): Promise<LoginAccountResponse> {
    return this.rpc.request<LoginAccountResponse>('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    } as LoginAccountParams)
  }

  async loginDeviceCode(): Promise<LoginAccountResponse> {
    return this.rpc.request<LoginAccountResponse>('account/login/start', {
      type: 'chatgptDeviceCode',
    } as LoginAccountParams)
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.rpc.request('account/login/cancel', { loginId } as CancelLoginAccountParams)
  }

  async logout(): Promise<void> {
    await this.rpc.request('account/logout', {})
  }

  async listModels(params: ModelListParams): Promise<ModelListResponse> {
    return this.rpc.request<ModelListResponse>('model/list', params)
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return this.rpc.request<ThreadStartResponse>('thread/start', params)
  }

  async resumeThread(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return this.rpc.request<ThreadResumeResponse>('thread/resume', params)
  }

  async deleteThread(params: ThreadDeleteParams): Promise<void> {
    await this.rpc.request('thread/delete', params)
  }

  async startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
    return this.rpc.request<TurnStartResponse>('turn/start', params)
  }

  async interruptTurn(params: TurnInterruptParams): Promise<void> {
    await this.rpc.request('turn/interrupt', params)
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.rpc.onNotification(method, handler)
  }

  offNotification(method: string, handler: (params: unknown) => void): void {
    this.rpc.offNotification(method, handler)
  }
}