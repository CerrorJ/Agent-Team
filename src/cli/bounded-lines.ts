import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'

/** 以字节和单行双重上限读取 CLI 输出；超限后继续排空管道，由调用方确认进程结束。 */
export const readBoundedLines = (input: {
  stream: Readable
  onLine: (line: string) => void
  onOverflow: () => void
}): void => {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  let total = 0
  let overflowing = false

  const consume = (text: string) => {
    pending += text
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      input.onLine(pending.slice(0, newline).replace(/\r$/, ''))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  }

  input.stream.on('data', (chunk: Buffer) => {
    if (overflowing) return
    total += chunk.length
    if (
      total > 32 * 1024 * 1024 ||
      Buffer.byteLength(pending, 'utf8') + chunk.length > 1024 * 1024
    ) {
      overflowing = true
      pending = ''
      input.onOverflow()
      return
    }
    consume(decoder.write(chunk))
  })
  input.stream.on('end', () => {
    if (overflowing) return
    consume(decoder.end())
    if (pending) input.onLine(pending)
  })
}
