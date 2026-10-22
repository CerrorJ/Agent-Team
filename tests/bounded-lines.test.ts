import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { once } from 'node:events'
import { readBoundedLines } from '../src/cli/bounded-lines.js'

test('CLI 分块 UTF-8、CRLF 和末行保持完整', async () => {
  const stream = new PassThrough()
  const lines: string[] = []
  readBoundedLines({
    stream,
    onLine: (line) => lines.push(line),
    onOverflow: () => assert.fail('unexpected overflow'),
  })
  const ended = once(stream, 'end')
  const text = Buffer.from('中文\r\n末行')
  stream.write(text.subarray(0, 2))
  stream.end(text.subarray(2))
  await ended
  assert.deepEqual(lines, ['中文', '末行'])
})

test('未换行日志洪水只触发一次终止请求且不再解析输出', async () => {
  const stream = new PassThrough()
  let requests = 0
  const lines: string[] = []
  readBoundedLines({
    stream,
    onLine: (line) => lines.push(line),
    onOverflow: () => {
      requests++
    },
  })
  const ended = once(stream, 'end')
  stream.write(Buffer.alloc(1024 * 1024 + 1, 65))
  stream.end('\nignore\n')
  await ended
  assert.equal(requests, 1)
  assert.deepEqual(lines, [])
})
