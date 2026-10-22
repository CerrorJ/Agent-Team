import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createKernel } from '../src/kernel/kernel.js'
import { handshakeSchema, type KernelRequest } from '../src/kernel/protocol.js'

const sourceCommit = 'a'.repeat(40)

const request = (method: KernelRequest['method']) => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  method,
})

test('无飞书配置创建，协议与真实运行时可查，未实现能力不伪装可用', async () => {
  const directory = mkdtempSync(join(tmpdir(), '纬舟 kernel '))
  const kernel = createKernel({ dataDirectory: directory, sourceCommit })
  try {
    const response = await kernel.dispatch(request('kernel.handshake'))
    assert.equal(response.status, 'completed')
    if (response.status !== 'completed') throw new Error('握手失败')
    const handshake = handshakeSchema.parse(response.result)
    assert.equal(handshake.sourceCommit, sourceCommit)
    assert.equal(handshake.runtime.node, process.versions.node)
    assert.ok(handshake.unavailable.includes('feishu'))
    assert.equal(
      (
        await kernel.dispatch({
          ...request('kernel.health'),
          protocolVersion: 2,
        })
      ).status,
      'rejected',
    )
    assert.equal(
      (
        await kernel.dispatch({
          ...request('kernel.health'),
          command: 'anything',
        })
      ).status,
      'rejected',
    )
  } finally {
    await kernel.shutdown()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('实例互斥、停止幂等、事件在重启后可补读', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'weftpilot-recovery-'))
  const kernel = createKernel({ dataDirectory: directory, sourceCommit })
  try {
    assert.throws(() =>
      createKernel({ dataDirectory: directory, sourceCommit }),
    )
    await kernel.shutdown()
    await kernel.shutdown()
    assert.equal(
      (await kernel.dispatch(request('kernel.health'))).status,
      'rejected',
    )
    const reopened = createKernel({ dataDirectory: directory, sourceCommit })
    try {
      const result = await reopened.dispatch({
        ...request('kernel.events'),
        after: 0,
      })

      assert.equal(result.status, 'completed')
      if (result.status !== 'completed') throw new Error('事件读取失败')
      assert.deepEqual(
        (result.result as { type: string }[]).map((event) => event.type),
        ['kernel.started', 'kernel.stopped', 'kernel.started'],
      )
    } finally {
      await reopened.shutdown()
    }
  } finally {
    await kernel.shutdown()
    rmSync(directory, { recursive: true, force: true })
  }
})
