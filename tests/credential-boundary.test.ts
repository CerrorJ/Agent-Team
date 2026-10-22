import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import {
  credentialBindingSchema,
  normalizeProviderUrl,
  type CredentialBinding,
} from '../src/kernel/credential-contracts.js'
import { CredentialChannel } from '../src/kernel/credential-channel.js'
import { executionModel } from '../src/kernel/model-runtime.js'
import { cliEnvironment } from '../src/cli/execution-environment.js'
import { workspaceFixture } from './helpers/run-fixture.js'

const binding: CredentialBinding = {
  reference: `model-${randomUUID()}`,
  provider: 'openai-compatible',
  baseUrl: 'https://provider.invalid/v1',
}

test('凭据绑定拒绝带认证/查询的地址、远端明文和非法引用，允许明确的本机接口', () => {
  assert.equal(
    normalizeProviderUrl('http://127.0.0.1:1234/v1'),
    'http://127.0.0.1:1234/v1',
  )
  for (const baseUrl of [
    'https://user:pass@provider.invalid/v1',
    'https://provider.invalid?token=x',
    'http://provider.invalid/v1',
    'invalid',
  ])
    assert.equal(
      credentialBindingSchema.safeParse({ ...binding, baseUrl }).success,
      false,
    )
  assert.equal(
    credentialBindingSchema.safeParse({
      ...binding,
      reference: '../../credentials',
    }).success,
    false,
  )
})

test('可信宿主凭据通道按请求关联，空回复失败，旧回复不能污染后续请求', async () => {
  const requests: unknown[] = []
  const channel = new CredentialChannel((message) => requests.push(message))
  const first = channel.resolve(binding)
  const request = requests[0] as { id: string }
  assert.equal(
    channel.receive({
      protocolVersion: 1,
      kind: 'host.credential.result',
      id: randomUUID(),
      value: 'wrong',
    }),
    true,
  )
  channel.receive({
    protocolVersion: 1,
    kind: 'host.credential.result',
    id: request.id,
    value: 'synthetic-secret',
  })
  assert.equal(await first, 'synthetic-secret')
  const second = channel.resolve(binding)
  channel.receive({
    protocolVersion: 1,
    kind: 'host.credential.result',
    id: request.id,
    value: 'stale',
  })
  channel.receive({
    protocolVersion: 1,
    kind: 'host.credential.result',
    id: (requests[1] as { id: string }).id,
    value: null,
  })
  await assert.rejects(second, /MODEL_CREDENTIAL_REQUIRED/)
})

test('自定义模型仅运行时取得绑定密钥，参数中无密钥，CLI工具环境排除提供方密钥', async () => {
  const { database, run } = workspaceFixture()

  const profile = {
    id: randomUUID(),
    version: 1,
    name: '合成提供方',
    cli: 'codex' as const,
    provider: 'openai-compatible' as const,
    model: 'synthetic-model',
    baseUrl: binding.baseUrl,
    credentialRef: binding.reference,
    reasoningEffort: '' as const,
    createdAt: new Date().toISOString(),
  }

  const configured = {
    ...run,
    roleSnapshot: {
      ...run.roleSnapshot,
      model: 'synthetic-model',
      modelProfileSnapshot: profile,
    },
  }

  try {
    await assert.rejects(
      executionModel(configured),
      /MODEL_CREDENTIAL_REQUIRED/,
    )

    const runtime = await executionModel(configured, async (value) => {
      assert.deepEqual(value, binding)
      return 'synthetic-model-secret'
    })

    assert.equal(runtime.environment, 'isolated')
    assert.equal(runtime.env.WEFTPILOT_MODEL_SECRET, 'synthetic-model-secret')
    const args = runtime.adapter.buildArgs('synthetic prompt', 'stdin')
    assert.equal(
      args.some((arg) => arg.includes('synthetic-model-secret')),
      false,
    )
    assert.ok(
      args.some(
        (arg) =>
          arg.includes('WEFTPILOT_MODEL_SECRET') && arg.includes('exclude'),
      ),
    )

    const claude = await executionModel(
      {
        ...configured,
        roleSnapshot: {
          ...configured.roleSnapshot,
          cli: 'claude',
          modelProfileSnapshot: {
            ...profile,
            cli: 'claude',
            provider: 'anthropic-compatible',
          },
        },
      },
      async () => 'synthetic-claude-key',
    )

    assert.equal(claude.env.ANTHROPIC_API_KEY, 'synthetic-claude-key')
    assert.equal(claude.env.ANTHROPIC_BASE_URL, binding.baseUrl)
    process.env.WEFTPILOT_TEST_UNRELATED_SECRET = 'synthetic-unrelated'
    assert.equal(
      cliEnvironment('isolated').WEFTPILOT_TEST_UNRELATED_SECRET,
      undefined,
    )
  } finally {
    delete process.env.WEFTPILOT_TEST_UNRELATED_SECRET
    database.close()
  }
})
