import { describe, it, expect } from 'vitest'
import { cleanIpcErrorMessage } from './ipcError'

describe('cleanIpcErrorMessage', () => {
  it('strips the Electron handler prefix and error class name', () => {
    const raw = new Error(
      "Error occurred in handler for 'image-generation:generate': ImageGenerationError: 当前图片供应商不支持参数「输出格式」"
    )
    expect(cleanIpcErrorMessage(raw)).toBe('当前图片供应商不支持参数「输出格式」')
  })

  it('strips only the error class name when no handler prefix is present', () => {
    expect(cleanIpcErrorMessage(new Error('ImageGenerationError: 图片服务返回 HTTP 400：xxx'))).toBe(
      '图片服务返回 HTTP 400：xxx'
    )
  })

  it('keeps a plain message untouched', () => {
    expect(cleanIpcErrorMessage(new Error('请输入图片描述'))).toBe('请输入图片描述')
  })

  it('handles non-Error values', () => {
    expect(cleanIpcErrorMessage('something broke')).toBe('something broke')
    expect(cleanIpcErrorMessage(undefined)).toBe('')
  })

  it('drops serialized stack frames appended to the message', () => {
    const raw = new Error(
      "Error occurred in handler for 'image-generation:generate': ImageGenerationError: 请输入图片描述\n    at ImageGenerationService.generate (/app/x.js:1:2)\n    at processTicks (node:internal/1:2)"
    )
    expect(cleanIpcErrorMessage(raw)).toBe('请输入图片描述')
  })
})
