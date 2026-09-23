// 极简 major.minor.patch 比较，仅用于 ChatGPT model catalog 的
// minimal_client_version 兼容性兜底检查。刻意不引入第三方 semver 依赖。
// 缺失段按 0 处理（'0.155' 视为 0.155.0）；无法解析的段按 0 处理，绝不抛错。

export function parseSemver(input: string | null | undefined): [number, number, number] {
  if (!input) return [0, 0, 0]
  const parts = String(input).trim().split('.')
  const toNum = (v: string | undefined): number => {
    const n = parseInt(v ?? '0', 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  return [toNum(parts[0]), toNum(parts[1]), toNum(parts[2])]
}

// a > b 返回正数，a === b 返回 0，a < b 返回负数。
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  const [a0, a1, a2] = parseSemver(a)
  const [b0, b1, b2] = parseSemver(b)
  if (a0 !== b0) return a0 - b0
  if (a1 !== b1) return a1 - b1
  return a2 - b2
}

// a 是否满足最低版本要求（a >= min）。
export function satisfiesMinVersion(actual: string | null | undefined, min: string | null | undefined): boolean {
  if (!min) return true
  return compareSemver(actual, min) >= 0
}
