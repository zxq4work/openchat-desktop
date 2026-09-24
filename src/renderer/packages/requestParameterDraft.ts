import type { RequestParameterValues } from '../../shared/types/provider'

// 会话级动态参数值的纯函数助手（供 Composer / ImageComposer 共用）。
// 值语义：key 不存在 = unset = 不发送该字段。这里绝不用 0 / "default" / "" 表示「默认」。

// 设置某参数值（返回新对象，不修改入参）。
export function setParameterValue(
  values: RequestParameterValues,
  id: string,
  value: string | number | boolean
): RequestParameterValues {
  return { ...values, [id]: value }
}

// 重置某参数（删除 key = unset = 请求不发送该字段）。
export function unsetParameterValue(values: RequestParameterValues, id: string): RequestParameterValues {
  if (!Object.prototype.hasOwnProperty.call(values, id)) return values
  const next = { ...values }
  delete next[id]
  return next
}
