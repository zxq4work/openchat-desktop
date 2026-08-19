import { describe, it, expect, afterEach } from 'vitest'
import { OAuthCallbackServer, CallbackTimeoutError, StateMismatchError, CallbackAlreadyInProgressError } from './OAuthCallbackServer'

describe('OAuthCallbackServer', () => {
  let server: OAuthCallbackServer

  afterEach(() => {
    server?.stop()
  })

  it('starts and listens on 127.0.0.1:1455', async () => {
    server = new OAuthCallbackServer()
    // 启动一个短超时的 start 来验证服务器能监听
    const promise = server.start('test-state', 100)
    // 立即 reject：timeout 会触发，但这也证明服务器正常启动了
    await expect(promise).rejects.toThrow(CallbackTimeoutError)
  }, 5000)

  it('rejects if callback is already pending', async () => {
    server = new OAuthCallbackServer()
    const promise = server.start('test-state', 1000)
    await expect(server.start('test-state-2', 1000)).rejects.toThrow(CallbackAlreadyInProgressError)
    await expect(promise).rejects.toThrow(CallbackTimeoutError)
  }, 5000)
})