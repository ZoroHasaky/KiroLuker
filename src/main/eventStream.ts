// AWS event-stream 帧解析
//
// generateAssistantResponse 的响应是 AWS event-stream：一串二进制帧，
// 每帧带 headers（:event-type / :message-type 等）与 JSON 负载。
// 对话测活与网关用量统计都要解析它，所以抽到这里共用。

/** 头部值的字节长度，用于跳过我们不关心的类型 */
function headerValueSize(buf: Buffer, offset: number, type: number): number {
  switch (type) {
    case 0:
    case 1:
      return 0
    case 2:
      return 1
    case 3:
      return 2
    case 4:
      return 4
    case 5:
    case 8:
      return 8
    case 6:
    case 7:
      return 2 + buf.readUInt16BE(offset)
    case 9:
      return 16
    default:
      return 0
  }
}

function parseHeaders(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let i = 0
  while (i < buf.length) {
    const nameLen = buf[i]
    i += 1
    const name = buf.toString('utf8', i, i + nameLen)
    i += nameLen
    const type = buf[i]
    i += 1
    const size = headerValueSize(buf, i, type)
    // 只有字符串类型对我们有意义（:event-type / :exception-type 等）
    if (type === 7) out[name] = buf.toString('utf8', i + 2, i + size)
    i += size
  }
  return out
}

export interface EventFrame {
  headers: Record<string, string>
  payload: Buffer
}

/**
 * 从累积缓冲里切出完整帧，剩余的不完整字节由调用方留到下一次。
 * 帧结构：4B 总长 + 4B 头部长 + 4B prelude CRC + 头部 + 负载 + 4B 消息 CRC。
 * CRC 不校验：真出错的话 JSON 解析会失败，没必要为此引入依赖。
 */
export function takeFrames(buffer: Buffer): { frames: EventFrame[]; rest: Buffer } {
  const frames: EventFrame[] = []
  let offset = 0
  while (buffer.length - offset >= 16) {
    const total = buffer.readUInt32BE(offset)
    if (total < 16 || buffer.length - offset < total) break
    const headersLen = buffer.readUInt32BE(offset + 4)
    const headersStart = offset + 12
    const payloadStart = headersStart + headersLen
    const payloadEnd = offset + total - 4
    frames.push({
      headers: parseHeaders(buffer.subarray(headersStart, payloadStart)),
      payload: buffer.subarray(payloadStart, payloadEnd)
    })
    offset += total
  }
  return { frames, rest: buffer.subarray(offset) }
}

export function jsonOf(payload: Buffer): Record<string, unknown> {
  try {
    return JSON.parse(payload.toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}
