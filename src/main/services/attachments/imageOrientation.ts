// 图片方向（EXIF Orientation）归一化的纯函数工具（不依赖 electron，便于单元测试）。
//
// 背景：Electron 的 nativeImage.createFromBuffer 解码时不应用 EXIF Orientation，
// 因此在 prepare（缩放/重编码缩略图）阶段会把方向信息丢掉：
//   - renderer 的 <img> 拿到的缩略图是未旋转的
//   - Provider 收到的也是未旋转的像素
// 手机竖拍照片常以 Orientation=6/8 存成"横着"的像素，于是表现为 90° 旋转。
//
// 解决：导入时读 JPEG 的 EXIF Orientation，把旋转/镜像烘焙进像素，
// 之后统一按"已归一化"的像素存储与发送。

// 读取 JPEG 的 EXIF Orientation（1..8）；非 JPEG / 无 EXIF / 解析失败一律返回 1（不处理）。
export function readJpegExifOrientation(buffer: Buffer): number {
  // JPEG SOI
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return 1

  let offset = 2
  while (offset + 4 <= buffer.length) {
    // 期望 marker：0xFF 后跟非 0x00/0xFF 的 marker 字节
    if (buffer[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buffer[offset + 1]
    // 填充字节 0xFF：跳过
    if (marker === 0xff) { offset++; continue }
    // SOS（0xDA）之后是压缩数据，不再有 EXIF
    if (marker === 0xda) return 1
    // 无长度字段的 marker（如 RSTn / SOI / EOI）
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    if (offset + 4 > buffer.length) return 1
    const segLen = buffer.readUInt16BE(offset + 2)
    if (segLen < 2) return 1
    const segStart = offset + 4
    const segEnd = offset + 2 + segLen
    if (segEnd > buffer.length) return 1

    // APP1 + "Exif\0\0"
    if (marker === 0xe1 && segStart + 6 <= segEnd) {
      if (
        buffer[segStart] === 0x45 && buffer[segStart + 1] === 0x78 &&
        buffer[segStart + 2] === 0x69 && buffer[segStart + 3] === 0x66 &&
        buffer[segStart + 4] === 0x00 && buffer[segStart + 5] === 0x00
      ) {
        return readOrientationFromTiff(buffer, segStart + 6, segEnd)
      }
    }

    offset = segEnd
  }
  return 1
}

// 从 TIFF 头解析 IFD0 的 Orientation tag。
function readOrientationFromTiff(buffer: Buffer, tiffStart: number, end: number): number {
  if (tiffStart + 8 > end) return 1
  const byteOrder = buffer.toString('latin1', tiffStart, tiffStart + 2)
  let little: boolean
  if (byteOrder === 'II') little = true
  else if (byteOrder === 'MM') little = false
  else return 1

  const readU16 = (pos: number): number =>
    little ? buffer.readUInt16LE(pos) : buffer.readUInt16BE(pos)
  const readU32 = (pos: number): number =>
    little ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos)

  if (readU16(tiffStart + 2) !== 0x002a) return 1

  const ifd0Offset = readU32(tiffStart + 4)
  const ifd0 = tiffStart + ifd0Offset
  if (ifd0 + 2 > end) return 1

  const entryCount = readU16(ifd0)
  for (let i = 0; i < entryCount; i++) {
    const entry = ifd0 + 2 + i * 12
    if (entry + 12 > end) return 1
    const tag = readU16(entry)
    if (tag !== 0x0112) continue
    // type 应为 SHORT(3)，值放在 entry+8 的前 2 字节
    const value = readU16(entry + 8)
    return value >= 1 && value <= 8 ? value : 1
  }
  return 1
}

// 判断某个 orientation 是否需要变换像素（1 = 无需处理）。
export function orientationNeedsTransform(orientation: number): boolean {
  return orientation >= 2 && orientation <= 8
}

// 对 BGRA 像素做方向归一化。bgra 长度必须为 width*height*4。
// 返回归一化后的像素与新尺寸；orientation 为 1 或参数非法时原样返回。
export function normalizeBitmapOrientation(
  bgra: Buffer,
  width: number,
  height: number,
  orientation: number
): { data: Buffer; width: number; height: number } {
  if (!orientationNeedsTransform(orientation) || width <= 0 || height <= 0) {
    return { data: bgra, width, height }
  }
  // toBitmap 返回 width*height*4 无行填充的 BGRA 像素；长度不符时不做变换，避免越界。
  if (bgra.length !== width * height * 4) {
    return { data: bgra, width, height }
  }

  const swapped = orientation >= 5
  const destW = swapped ? height : width
  const destH = swapped ? width : height
  const out = Buffer.alloc(destW * destH * 4)

  for (let y = 0; y < destH; y++) {
    for (let x = 0; x < destW; x++) {
      let sx: number
      let sy: number
      switch (orientation) {
        case 2: sx = width - 1 - x; sy = y; break          // 水平镜像
        case 3: sx = width - 1 - x; sy = height - 1 - y; break // 旋转 180°
        case 4: sx = x; sy = height - 1 - y; break          // 垂直镜像
        case 5: sx = y; sy = x; break                       // 沿主对角线转置
        case 6: sx = y; sy = height - 1 - x; break          // 顺时针 90°
        case 7: sx = width - 1 - y; sy = height - 1 - x; break // 沿副对角线转置
        case 8: sx = width - 1 - y; sy = x; break           // 逆时针 90°
        default: sx = x; sy = y
      }
      const si = (sy * width + sx) * 4
      const di = (y * destW + x) * 4
      out[di] = bgra[si]
      out[di + 1] = bgra[si + 1]
      out[di + 2] = bgra[si + 2]
      out[di + 3] = bgra[si + 3]
    }
  }
  return { data: out, width: destW, height: destH }
}
