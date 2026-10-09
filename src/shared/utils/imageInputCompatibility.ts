// 图片输入兼容性判定（Main 与 Renderer 共用的纯函数，保证两侧语义一致）。
//
// 概念上区分两个不同的问题（绝不用一个 supportsImage boolean 混为一谈）：
//   1. canAddImages        —— 当前是否允许「新增图片进入草稿」（paste / drop / picker）
//   2. 发送阻塞原因        —— 当前实际要发送的上下文能否被当前 Provider / Model 接受
//
// 关键原则：
//   - 草稿是用户数据。能力变化只改变「现在能否继续添加 / 能否发送」，
//     绝不反过来删除草稿里的图片。
//   - 能力是当前运行时事实，必须用「当前」Provider / Model 配置重新计算，
//     不得持久化或信任草稿创建时的旧能力快照。
//
// 发送阻塞原因（getSendBlockReason 返回值）：
//   - null                       —— 无阻塞
//   - 'draft_images_unsupported' —— 未发送草稿含图片，当前模型不支持
//   - 'history_images_unsupported' —— 草稿纯文字，但当前 segment 历史含需 replay 的图片，当前模型不支持
// 其它发送阻塞（空草稿 / 生成中 / binding 失效 / 无模型）由各自既有逻辑处理，不在此 helper。

export type SendBlockReason =
  | 'draft_images_unsupported'
  | 'history_images_unsupported'

export interface ImageInputCompatibilityInput {
  // 当前 Provider / Model 是否支持图片输入（由 effective capability resolver 计算）
  supportsImage: boolean
  // 当前草稿中待发送的 Chat 图片输入数量
  draftImageCount: number
  // 当前 segment 历史中是否已有需要 replay 的 Chat 图片输入
  historyNeedsImage: boolean
}

// ── 统一文案 ──
// 三处语义不同，绝不混用同一句话：
//   ADD_REJECTED      —— 用户主动尝试新增图片，但当前不支持（一次性提示）
//   DRAFT_INCOMPATIBLE —— 草稿里已存在图片，但当前不支持（常驻 inline 提示）
//   HISTORY_INCOMPATIBLE —— 草稿纯文字，但历史上下文含图片，当前不支持（常驻 inline 提示）
export const IMAGE_ADD_REJECTED_MESSAGE = '当前模型不支持图片输入'
export const DRAFT_IMAGE_INCOMPATIBLE_MESSAGE = '当前模型不支持草稿中的图片，请移除图片或切换支持图片的模型'
export const HISTORY_IMAGE_INCOMPATIBLE_MESSAGE = '当前模型不支持本会话上下文中的图片，请切换支持图片的模型或开启新话题'

export function blockReasonMessage(reason: SendBlockReason): string {
  return reason === 'draft_images_unsupported'
    ? DRAFT_IMAGE_INCOMPATIBLE_MESSAGE
    : HISTORY_IMAGE_INCOMPATIBLE_MESSAGE
}

// 当前状态是否允许新增图片进入草稿（决定 paste / drop / picker 是否可用）。
// 只要当前 Provider / Model 不支持图片输入，就一律禁止新增；
// 已有草稿图片的保留与此无关（那是发送兼容性问题，不是新增问题）。
export function canAddImages(supportsImage: boolean): boolean {
  return supportsImage
}

// 派生当前草稿的发送图片兼容性。
// 返回阻塞原因；null 表示图片上下文与当前能力兼容（仍可能因其它规则不可发送）。
//
// 优先级：草稿图片阻塞 > 历史图片阻塞。
// 草稿有图片时用户可直接移除图片解除；历史图片无法通过移除草稿图片解除（草稿本就没有图片），
// 因此两者必须给出不同提示，不能互相掩盖。
export function getSendBlockReason(input: ImageInputCompatibilityInput): SendBlockReason | null {
  if (input.supportsImage) return null
  if (input.draftImageCount > 0) return 'draft_images_unsupported'
  if (input.historyNeedsImage) return 'history_images_unsupported'
  return null
}
