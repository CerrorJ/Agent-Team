import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { ShutdownExit } from '../src/kernel/shutdown-exit.js'

test('新宿主收到停机应答后才允许退出，旧/非法ACK不能释放当前停机', () => {
  const exits: number[] = []
  const gate = new ShutdownExit((code) => exits.push(code))
  const requestId = randomUUID()

  const request = {
    protocolVersion: 1,
    requestId,
    method: 'kernel.shutdown',
    acknowledgeExit: true,
  }

  gate.responded(request, {
    protocolVersion: 1,
    requestId,
    status: 'completed',
    result: { state: 'stopped' },
  })
  assert.deepEqual(exits, [])
  assert.equal(
    gate.receive({
      kind: 'shutdown-ack',
      protocolVersion: 1,
      requestId: randomUUID(),
    }),
    true,
  )
  assert.equal(
    gate.receive({
      kind: 'shutdown-ack',
      protocolVersion: 1,
      requestId,
      extra: true,
    }),
    false,
  )
  assert.deepEqual(exits, [])
  gate.receive({ kind: 'shutdown-ack', protocolVersion: 1, requestId })
  assert.deepEqual(exits, [0])
  gate.receive({ kind: 'shutdown-ack', protocolVersion: 1, requestId })
  assert.deepEqual(exits, [0])
})

test('旧宿主保持兼容；非停机结果或被拒绝停机均不能结束进程', async () => {
  const exits: number[] = []
  const gate = new ShutdownExit((code) => exits.push(code))
  const requestId = randomUUID()

  const response = {
    protocolVersion: 1 as const,
    requestId,
    status: 'completed' as const,
    result: { state: 'stopped' },
  }

  gate.responded(
    { protocolVersion: 1, requestId, method: 'kernel.health' },
    response,
  )
  gate.responded(
    { protocolVersion: 1, requestId, method: 'kernel.shutdown' },
    { ...response, result: { state: 'running' } },
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(exits, [])
  gate.responded(
    { protocolVersion: 1, requestId, method: 'kernel.shutdown' },
    response,
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(exits, [0])
})

test('宿主未收讫的停机有限等待并以非零退出，不能伪造确认', async () => {
  const exits: number[] = []
  const gate = new ShutdownExit((code) => exits.push(code), 10)
  const requestId = randomUUID()
  gate.responded(
    {
      protocolVersion: 1,
      requestId,
      method: 'kernel.shutdown',
      acknowledgeExit: true,
    },
    {
      protocolVersion: 1,
      requestId,
      status: 'completed',
      result: { state: 'stopped' },
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(exits, [1])
})
