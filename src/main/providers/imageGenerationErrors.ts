// Image Generation 专用错误语义。
// UI 不展示 Provider 原始长错误，只按 code 映射为用户可读的简短提示。
export type ImageGenerationErrorCode =
  | 'IMAGE_GENERATION_UNSUPPORTED'
  | 'IMAGE_GENERATION_INVALID_PARAMETER'
  | 'IMAGE_GENERATION_TEXT_TO_IMAGE_UNSUPPORTED'
  | 'IMAGE_GENERATION_IMAGE_INPUT_UNSUPPORTED'
  | 'IMAGE_GENERATION_TOO_MANY_INPUT_IMAGES'
  | 'IMAGE_GENERATION_INPUT_IMAGE_NOT_FOUND'
  | 'IMAGE_GENERATION_INPUT_IMAGE_INVALID'
  | 'IMAGE_GENERATION_INPUT_IMAGE_READ_FAILED'
  | 'IMAGE_GENERATION_FAILED'
  | 'IMAGE_GENERATION_INVALID_RESPONSE'
  | 'IMAGE_GENERATION_DOWNLOAD_FAILED'
  | 'IMAGE_GENERATION_DECODE_FAILED'
  | 'IMAGE_GENERATION_ABORTED'

export class ImageGenerationError extends Error {
  code: ImageGenerationErrorCode
  constructor(code: ImageGenerationErrorCode, message: string) {
    super(message)
    this.name = 'ImageGenerationError'
    this.code = code
  }
}
