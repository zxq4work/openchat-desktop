/**
 * HAST → React 渲染器
 *
 * 接收 render-ready HAST（已经过 post-transform），
 * 直接调用 toJsxRuntime 渲染为 React elements。
 *
 * 与 react-markdown v9.0.1 内部 toJsxRuntime 调用参数完全一致。
 * 不做任何 visit/mutate——缓存命中后直接使用。
 */

import type { Root } from 'hast'
import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'
import type { Components } from 'react-markdown'

/**
 * 将 render-ready hast tree 渲染为 React elements。
 *
 * 参数与 react-markdown v9.0.1 内部 toJsxRuntime 调用完全一致。
 * 缓存的 HAST 已经过 post-transform（raw→text, URL sanitize），
 * 不需要再次处理。
 */
export function renderHastToReact(hast: Root, components: Components): JSX.Element {
  return toJsxRuntime(hast, {
    Fragment,
    components,
    ignoreInvalidStyle: true,
    jsx,
    jsxs,
    passKeys: true,
    passNode: true,
  }) as JSX.Element
}
