import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { downloadSkillTree } from '../src/kernel/skill-download.js'
import { publicError } from '../src/kernel/public-errors.js'
import type { SkillSource } from '../src/kernel/skill-contracts.js'

const source: SkillSource = {
  id: randomUUID(),
  version: 1,
  name: '合成来源',
  repository: 'https://github.com/example/skills',
  commit: 'a'.repeat(40),
  createdAt: new Date().toISOString(),
}

const read = (fetcher: typeof fetch) =>
  downloadSkillTree({ source, signal: new AbortController().signal, fetcher })

test('技能HTTP失败只发布有限码：限流与403/404/5xx分开，不读取或保留服务器正文', async () => {
  for (const [status, remaining, expected] of [
    [403, '0', 'SKILL_DOWNLOAD_RATE_LIMITED'],
    [429, '', 'SKILL_DOWNLOAD_RATE_LIMITED'],
    [403, '10', 'SKILL_DOWNLOAD_FORBIDDEN'],
    [404, '', 'SKILL_DOWNLOAD_NOT_FOUND'],
    [503, '', 'SKILL_DOWNLOAD_SERVER_UNAVAILABLE'],
    [418, '', 'SKILL_DOWNLOAD_HTTP_FAILED'],
  ] as const) {
    let cancelled = false

    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })

    await assert.rejects(
      read(async (_url, init) => {
        assert.equal(init?.redirect, 'error')
        assert.equal(init?.credentials, 'omit')
        return new Response(body, {
          status,
          headers: { 'x-ratelimit-remaining': remaining },
        })
      }),
      { message: expected },
    )
    assert.equal(cancelled, true)
    assert.equal(publicError(new Error(expected)).code, expected)
  }
})

test('网络cause仅白名单分类，不暴露错误正文、凭据、路径或伪造SKILL前缀', async () => {
  for (const [code, expected] of [
    ['ENOTFOUND', 'SKILL_DOWNLOAD_DNS_FAILED'],
    ['EAI_AGAIN', 'SKILL_DOWNLOAD_DNS_FAILED'],
    ['UND_ERR_CONNECT_TIMEOUT', 'SKILL_DOWNLOAD_TIMEOUT'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'SKILL_DOWNLOAD_TLS_FAILED'],
    ['ECONNRESET', 'SKILL_DOWNLOAD_NETWORK_FAILED'],
    ['__proto__', 'SKILL_DOWNLOAD_NETWORK_FAILED'],
  ] as const) {
    const error = new Error('SKILL_private-token-local-path', {
      cause: { code, message: 'private-token' },
    })

    await assert.rejects(
      read(async () => {
        throw error
      }),
      (failure: unknown) => {
        assert.equal((failure as Error).message, expected)
        assert.equal(
          JSON.stringify(publicError(failure)).includes('private-token'),
          false,
        )
        assert.equal((failure as Error).cause, undefined)
        return true
      },
    )
  }
})

test('读取中断与超时也被分类，大小上限和安全错误不被网络分类覆盖', async () => {
  await assert.rejects(
    read(async () => {
      throw new DOMException('private-token', 'TimeoutError')
    }),
    { message: 'SKILL_DOWNLOAD_TIMEOUT' },
  )
  await assert.rejects(
    read(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(
                Object.assign(new Error('private-token'), {
                  code: 'CERT_HAS_EXPIRED',
                }),
              )
            },
          }),
        ),
    ),
    { message: 'SKILL_DOWNLOAD_TLS_FAILED' },
  )

  const large = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(12_000_001))
      controller.close()
    },
  })

  await assert.rejects(
    read(async () => new Response(large)),
    { message: 'SKILL_SIZE_LIMIT' },
  )
})
