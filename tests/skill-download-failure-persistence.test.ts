import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createKernel, type EmbeddedKernel } from '../src/kernel/kernel.js'
import {
  localKernelFixture,
  issueCommand,
  readSnapshot,
} from './helpers/local-kernel-fixture.js'
import { skillFixtureFetch } from './helpers/skill-fixture.js'
import type { SkillFetch } from '../src/kernel/skill-download.js'
import type { SkillImport } from '../src/kernel/skill-contracts.js'

const waitImport = async (
  kernel: EmbeddedKernel,
  id: string,
  state: SkillImport['state'],
) => {
  for (let count = 0; count < 100; count++) {
    const item = (await readSnapshot(kernel)).skillImports.find(
      (value) => value.id === id,
    )

    if (item?.state === state) return item
    await delay(20)
  }
  throw new Error('IMPORT_STATE_TIMEOUT')
}

test('真实文件SQLite保留限流/TLS错误，重启不盲重试，原可用版本和资源不受失败影响', async () => {
  let mode: 'success' | 'rate' | 'tls' = 'success'
  let requests = 0
  const successful = skillFixtureFetch()

  // 合成网络端口只覆盖失败/持久化边界，不代替真实公共来源或模型验收。
  const fetcher: SkillFetch = async (url, init) => {
    requests++
    if (mode === 'rate')
      return new Response('private-token-server-body', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      })
    if (mode === 'tls')
      throw new Error('private-token-local-path', {
        cause: { code: 'CERT_HAS_EXPIRED' },
      })
    return successful(url, init)
  }

  const fixture = await localKernelFixture(
    async () => {
      throw new Error('CLI_MUST_NOT_RUN')
    },
    { skillFetch: fetcher },
  )

  let restarted: EmbeddedKernel | undefined
  try {
    const sourceId = await fixture.command({
      type: 'skill.source.save',
      expectedVersion: 0,
      name: '受控来源',
      repository: 'https://github.com/example/skills',
      commit: 'a'.repeat(40),
    })

    const input = {
      type: 'skill.import' as const,
      sourceId,
      sourceVersion: 1,
      directory: 'skills/test-skill',
      licensePath: 'LICENSE',
    }

    const firstId = await fixture.command(input)
    const preview = await waitImport(fixture.kernel, firstId, 'preview_ready')
    await fixture.command({
      type: 'skill.activate',
      id: firstId,
      expectedVersion: preview.version,
      digest: preview.package!.digest,
    })
    await waitImport(fixture.kernel, firstId, 'installed')
    const original = (await fixture.snapshot()).skills
    mode = 'rate'
    await fixture.command({
      type: 'skill.source.save',
      id: sourceId,
      expectedVersion: 1,
      name: '受控来源',
      repository: 'https://github.com/example/skills',
      commit: 'b'.repeat(40),
    })
    const rateId = await fixture.command({ ...input, sourceVersion: 2 })
    const rate = await waitImport(fixture.kernel, rateId, 'failed')
    assert.equal(rate.failureCode, 'SKILL_DOWNLOAD_RATE_LIMITED')
    assert.equal(rate.package, null)
    assert.deepEqual((await fixture.snapshot()).skills, original)
    await fixture.kernel.shutdown()
    const beforeRestart = requests
    restarted = createKernel({
      dataDirectory: fixture.dataDirectory,
      sourceCommit: 'a'.repeat(40),
      skillFetch: fetcher,
    })
    assert.deepEqual(
      (await readSnapshot(restarted)).skillImports.find(
        (item) => item.id === rateId,
      ),
      rate,
    )
    await delay(40)
    assert.equal(requests, beforeRestart)
    mode = 'tls'
    await issueCommand(restarted, {
      type: 'skill.source.save',
      id: sourceId,
      expectedVersion: 2,
      name: '受控来源',
      repository: 'https://github.com/example/skills',
      commit: 'c'.repeat(40),
    })
    const tlsId = await issueCommand(restarted, { ...input, sourceVersion: 3 })
    assert.equal(
      (await waitImport(restarted, tlsId, 'failed')).failureCode,
      'SKILL_DOWNLOAD_TLS_FAILED',
    )
    const final = await readSnapshot(restarted)
    assert.deepEqual(final.skills, original)
    assert.equal(final.runs.length, 0)
    assert.equal(JSON.stringify(final).includes('private-token'), false)
  } finally {
    await restarted?.shutdown()
    await fixture.cleanup()
  }
})
