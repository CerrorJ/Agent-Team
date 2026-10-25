import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { test } from 'node:test'
import { writeCliInput } from '../src/cli/input-stream.js'

test('输入管道异步失败只报告一次，不泄露正文或让error逃逸', async () => {
  let calls = 0

  const stream = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error('SYNTHETIC_PRIVATE_ERROR'))
    },
  })

  const closed = new Promise<void>((resolve) => stream.once('close', resolve))
  writeCliInput({
    stream,
    prompt: 'SYNTHETIC_PRIVATE_PROMPT',
    failed: () => {
      calls++
    },
  })
  await closed
  stream.emit('error', new Error('late error'))
  assert.equal(calls, 1)
})

test('同步写入异常也报告失败，随后error不重复通知', () => {
  let calls = 0

  const stream = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })

  Object.defineProperty(stream, 'end', {
    value: () => {
      throw new Error('SYNTHETIC_WRITE')
    },
  })
  writeCliInput({
    stream,
    prompt: 'fixture',
    failed: () => {
      calls++
    },
  })
  stream.emit('error', new Error('late error'))
  assert.equal(calls, 1)
  stream.destroy()
})

test('argv模式只收口stdin，断管不等于未交付提示，但仍不能崩溃', () => {
  let calls = 0

  const stream = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })

  writeCliInput({
    stream,
    prompt: undefined,
    failed: () => {
      calls++
    },
  })
  stream.emit('error', new Error('empty stdin closed'))
  assert.equal(calls, 0)
  stream.destroy()
})

test('stdin完整写完后的晚到断管不反写成未送达', async () => {
  let calls = 0

  const stream = new Writable({
    write(_chunk, _encoding, done) {
      done()
    },
  })

  const finished = new Promise<void>((resolve) =>
    stream.once('finish', resolve),
  )

  writeCliInput({
    stream,
    prompt: 'fully delivered',
    failed: () => {
      calls++
    },
  })
  await finished
  assert.equal(stream.writableFinished, true)
  stream.emit('error', new Error('late close after delivery'))
  assert.equal(calls, 0)
  stream.destroy()
})
