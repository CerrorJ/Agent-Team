import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { assertProductSpecDocuments } from '../src/app/product-spec-documents.js'
import { ensureProductSpecSubmission } from '../src/app/product-spec-submission.js'
import {
  parseProductSpecInput,
  type ProductSpecRequest,
} from '../src/core/product-spec.js'
import { runCli } from '../src/cli/runner.js'
import type { CliAdapter, CliEvent, CliRunResult } from '../src/cli/types.js'

const localRequest = {
  deliveryMode: 'local' as const,
  title: '澄清卡片',
  summary: '支持逐题作答',
  specPath: 'spec.md',
  ticketsPath: 'tickets',
}

const resultFor = (request: ProductSpecRequest): CliRunResult => ({
  answer: '方案已提交',
  sessionId: 'original-session',
  toolCalls: [
    {
      toolUseId: 'submission',
      toolName: 'request_spec_approval',
      input: request,
    },
  ],
})

const rejectedResultFor = (input: unknown): CliRunResult => ({
  answer: '方案已完成',
  sessionId: 'original-session',
  rejectedToolCalls: [
    {
      toolUseId: 'rejected-submission',
      toolName: 'request_spec_approval',
      input,
    },
  ],
})

const workspaceFor = async (t: TestContext) => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'agent-team-product-spec-'))

  t.after(() => rm(workspaceDir, { recursive: true, force: true }))
  await writeFile(join(workspaceDir, 'spec.md'), '# Product specification\n')
  await mkdir(join(workspaceDir, 'tickets'))
  return workspaceDir
}

test('rejects a summary file submitted as ticketsPath with an actionable reason', async (t) => {
  const workspaceDir = await workspaceFor(t)
  const ticketsPath = 'clarify-card-2026-10-09-answer.md'

  await writeFile(join(workspaceDir, ticketsPath), '# Answers\n')
  await assert.rejects(
    assertProductSpecDocuments(workspaceDir, { ...localRequest, ticketsPath }),
    /Tickets: clarify-card-2026-10-09-answer\.md（必须提交目录路径/,
  )
})

test('rejects missing spec, missing tickets, and empty tickets directory', async (t) => {
  const workspaceDir = await workspaceFor(t)

  await assert.rejects(
    assertProductSpecDocuments(workspaceDir, localRequest),
    /目录内至少需要一个独立 ticket/,
  )
  await assert.rejects(
    assertProductSpecDocuments(workspaceDir, {
      ...localRequest,
      specPath: 'missing-spec.md',
      ticketsPath: 'missing-tickets',
    }),
    (error: Error) => {
      assert.match(error.message, /Spec: missing-spec\.md/)
      assert.match(error.message, /Tickets: missing-tickets（目录不存在/)
      return true
    },
  )
})

test('valid local submission does not retry', async (t) => {
  const workspaceDir = await workspaceFor(t)

  await writeFile(join(workspaceDir, 'tickets/01-card.md'), '# Card\n')

  const result = resultFor(localRequest)

  const submission = await ensureProductSpecSubmission({
    result,
    workspaceDir,
    defaultDeliveryMode: 'local',
    retry: async () => assert.fail('Valid submission must not retry'),
  })

  assert.equal(submission.result, result)
  assert.deepEqual(submission.request, localRequest)
})

test('invalid local submission resumes once with the failing path and accepts repaired artifacts', async (t) => {
  const workspaceDir = await workspaceFor(t)
  const ticketsPath = 'clarify-card-2026-10-09-answer.md'

  await writeFile(join(workspaceDir, ticketsPath), '# Implementation tasks\n')
  let retries = 0

  const repairedResult = {
    ...resultFor(localRequest),
    sessionId: 'repaired-session',
  }

  const submission = await ensureProductSpecSubmission({
    result: resultFor({ ...localRequest, ticketsPath }),
    workspaceDir,
    defaultDeliveryMode: 'lark-doc',
    retry: async (prompt, sessionId) => {
      retries += 1
      assert.equal(sessionId, 'original-session')
      assert.match(prompt, /clarify-card-2026-10-09-answer\.md/)
      assert.match(prompt, /不能提交单个文件/)
      assert.match(prompt, /不要改为飞书云文档来绕过校验/)
      await writeFile(join(workspaceDir, 'tickets/01-card.md'), '# Card\n')
      return repairedResult
    },
  })

  assert.equal(retries, 1)
  assert.equal(submission.result, repairedResult)
  assert.deepEqual(submission.request, localRequest)
})

test('still-invalid retry fails after one attempt', async (t) => {
  const workspaceDir = await workspaceFor(t)
  let retries = 0

  await assert.rejects(
    ensureProductSpecSubmission({
      result: resultFor(localRequest),
      workspaceDir,
      defaultDeliveryMode: 'local',
      retry: async () => {
        retries += 1
        return resultFor(localRequest)
      },
    }),
    /目录内至少需要一个独立 ticket/,
  )
  assert.equal(retries, 1)
})

test('missing submission retries and validates recovered local artifacts', async (t) => {
  const workspaceDir = await workspaceFor(t)

  await assert.rejects(
    ensureProductSpecSubmission({
      result: { answer: '方案已完成', sessionId: 'original-session' },
      workspaceDir,
      defaultDeliveryMode: 'local',
      retry: async (prompt, sessionId) => {
        assert.equal(sessionId, 'original-session')
        assert.match(prompt, /实际调用工具/)
        return resultFor(localRequest)
      },
    }),
    /目录内至少需要一个独立 ticket/,
  )
})

test('missing submission still fails when the retry does not call the tool', async () => {
  await assert.rejects(
    ensureProductSpecSubmission({
      result: { answer: '方案已完成' },
      workspaceDir: '.',
      defaultDeliveryMode: 'local',
      retry: async () => ({ answer: '方案已完成' }),
    }),
    /没有调用 request_spec_approval/,
  )
})

test('lark-doc submission does not require local artifacts or retry', async () => {
  const request: ProductSpecRequest = {
    deliveryMode: 'lark-doc',
    title: '澄清卡片',
    summary: '支持逐题作答',
    documentUrl: 'https://example.feishu.cn/docx/test-document',
  }

  const submission = await ensureProductSpecSubmission({
    result: resultFor(request),
    workspaceDir: 'nonexistent-workspace',
    defaultDeliveryMode: 'local',
    retry: async () => assert.fail('Cloud document must not retry'),
  })

  assert.deepEqual(submission.request, request)
})

test('MCP validates the CLI workspace and lets the agent correct a rejected submission', async (t) => {
  const client = new Client({
    name: 'product-spec-regression',
    version: '1.0.0',
  })

  t.after(() => client.close())

  const workspaceDir = await workspaceFor(t)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href,
      fileURLToPath(new URL('../src/mcp/app-tools-server.ts', import.meta.url)),
    ],
    cwd: workspaceDir,
    stderr: 'pipe',
  })

  await client.connect(transport)

  const tools = await client.listTools()

  const tool = tools.tools.find(
    (entry) => entry.name === 'request_spec_approval',
  )

  assert.match(
    JSON.stringify(tool?.inputSchema.properties?.ticketsPath),
    /目录/,
  )
  await writeFile(join(workspaceDir, 'answer.md'), '# Answers\n')

  const rejected = await client.callTool({
    name: 'request_spec_approval',
    arguments: { ...localRequest, ticketsPath: 'answer.md' },
  })

  assert.equal(rejected.isError, true)
  assert.match(JSON.stringify(rejected.content), /必须提交目录路径/)
  await writeFile(join(workspaceDir, 'tickets/01-card.md'), '# Card\n')

  const accepted = await client.callTool({
    name: 'request_spec_approval',
    arguments: localRequest,
  })

  assert.ok(!accepted.isError)
  assert.match(JSON.stringify(accepted.content), /等待用户查看/)
})

test('MCP-rejected submission retries with the real reason instead of a missing-call prompt', async (t) => {
  const workspaceDir = await workspaceFor(t)
  const ticketsPath = '.claude/team/clarify-card-2026-10-09-answer.md'

  await mkdir(join(workspaceDir, '.claude/team'), { recursive: true })
  await writeFile(join(workspaceDir, ticketsPath), '# Answers\n')

  const submission = await ensureProductSpecSubmission({
    result: rejectedResultFor({ ...localRequest, ticketsPath }),
    workspaceDir,
    defaultDeliveryMode: 'local',
    retry: async (prompt, sessionId) => {
      assert.equal(sessionId, 'original-session')
      assert.match(prompt, /未通过校验/)
      assert.match(
        prompt,
        /clarify-card-2026-10-09-answer\.md（必须提交目录路径/,
      )
      assert.doesNotMatch(prompt, /没有完成 Agent Team 的结构化提交/)
      await writeFile(join(workspaceDir, 'tickets/01-card.md'), '# Card\n')
      return resultFor(localRequest)
    },
  })

  assert.deepEqual(submission.request, localRequest)
})

test('still-rejected retry reports the validation failure, not a missing call', async (t) => {
  const workspaceDir = await workspaceFor(t)
  const rejectedInput = { ...localRequest, ticketsPath: 'answer.md' }

  await writeFile(join(workspaceDir, 'answer.md'), '# Answers\n')
  await assert.rejects(
    ensureProductSpecSubmission({
      result: rejectedResultFor(rejectedInput),
      workspaceDir,
      defaultDeliveryMode: 'local',
      retry: async () => rejectedResultFor(rejectedInput),
    }),
    (error: Error) => {
      assert.match(error.message, /产品方案尚未完整写入工作区/)
      assert.match(error.message, /answer\.md（必须提交目录路径/)
      assert.doesNotMatch(error.message, /没有调用/)
      return true
    },
  )
})

test('schema-invalid rejected submission surfaces the parameter issue', async () => {
  await assert.rejects(
    ensureProductSpecSubmission({
      result: rejectedResultFor({ ...localRequest, specPath: undefined }),
      workspaceDir: '.',
      defaultDeliveryMode: 'local',
      retry: async (prompt) => {
        assert.match(prompt, /参数未通过校验：specPath/)
        return { answer: '方案已完成' }
      },
    }),
    /没有调用 request_spec_approval/,
  )
})

test('retry may not switch a local submission to lark-doc', async (t) => {
  const workspaceDir = await workspaceFor(t)

  await assert.rejects(
    ensureProductSpecSubmission({
      result: resultFor(localRequest),
      workspaceDir,
      defaultDeliveryMode: 'local',
      retry: async () =>
        resultFor({
          deliveryMode: 'lark-doc',
          title: '澄清卡片',
          summary: '支持逐题作答',
          documentUrl: 'https://example.feishu.cn/docx/test-document',
        }),
    }),
    /交付方式从 local 改成了 lark-doc/,
  )
})

test('workspace paths reject Windows drive, UNC and traversal forms', () => {
  for (const specPath of [
    'C:\\Windows\\spec.md',
    'D:spec.md',
    '\\\\host\\share\\spec.md',
    '/etc/spec.md',
    'docs/../../spec.md',
  ]) {
    const parsed = parseProductSpecInput({ ...localRequest, specPath })

    assert.equal(parsed.success, false, specPath)
  }
  assert.equal(parseProductSpecInput(localRequest).success, true)
  assert.equal(
    parseProductSpecInput({ ...localRequest, documentUrl: '' }).success,
    true,
  )
})

test('runner returns rejected app-tool calls separately from accepted ones', async (t) => {
  const scriptDir = await mkdtemp(join(tmpdir(), 'agent-team-fake-cli-'))

  t.after(() => rm(scriptDir, { recursive: true, force: true }))

  const events: CliEvent[] = [
    {
      type: 'tool_call',
      toolUseId: 'first',
      toolName: 'request_spec_approval',
      input: { ...localRequest, ticketsPath: 'answer.md' },
    },
    { type: 'tool_end', toolUseId: 'first', failed: true },
    {
      type: 'tool_call',
      toolUseId: 'second',
      toolName: 'request_spec_approval',
      input: localRequest,
    },
    { type: 'tool_end', toolUseId: 'second', failed: false },
    { type: 'result', answer: 'done', sessionId: 'fake-session' },
  ]

  const script = join(scriptDir, 'fake-cli.mjs')

  await writeFile(
    script,
    [
      'process.stdin.resume()',
      `process.stdin.on('end', () => {`,
      `  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event))`,
      '})',
    ].join('\n'),
  )

  const adapter = {
    id: 'claude',
    command: 'node',
    displayName: 'Fake CLI',
    buildArgs: () => [script],
    buildResumeArgs: () => [script],
    buildCompactPlan: () => assert.fail('not used'),
    parseEvents: (line: string) => [JSON.parse(line) as CliEvent],
  } as unknown as CliAdapter

  const result = await runCli({ adapter, prompt: 'go', cwd: scriptDir })

  assert.deepEqual(
    result.toolCalls?.map((call) => call.toolUseId),
    ['second'],
  )
  assert.deepEqual(
    result.rejectedToolCalls?.map((call) => call.toolUseId),
    ['first'],
  )
})
