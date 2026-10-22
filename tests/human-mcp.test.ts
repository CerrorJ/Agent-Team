import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { humanMcpRuntime } from '../src/kernel/human-mcp-runtime.js'
import { workspaceFixture } from './helpers/run-fixture.js'

test('受信MCP真实子进程只注册三个人工请求，回执不冒充批准', async () => {
  const client = new Client({ name: 'weftpilot-test', version: '1' })

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url),
      ),
      fileURLToPath(
        new URL('../src/kernel/human-mcp-entry.ts', import.meta.url),
      ),
    ],
    stderr: 'pipe',
    env: { NODE_OPTIONS: '' },
  })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'request_approval',
      'request_clarification',
      'request_plan_review',
    ])

    const result = await client.callTool({
      name: 'request_approval',
      arguments: {
        operation: '不执行此字符串',
        detail: '仅请求所有者决定',
        impact: '无实际副作用',
        rollback: '无',
      },
    })

    assert.notEqual(result.isError, true)
    assert.match(JSON.stringify(result.content), /立即结束本轮/)
    assert.equal(JSON.stringify(result.content).includes('审批已通过'), false)
  } finally {
    await client.close()
  }
})

test('MCP运行时由内核生成，试运行不加载扩展，显式清空提供方密钥和Node注入选项', () => {
  const { database, run } = workspaceFixture()
  try {
    assert.equal(humanMcpRuntime({ ...run, purpose: 'role_trial' }), undefined)
    assert.equal(
      humanMcpRuntime({
        ...run,
        roleSnapshot: { ...run.roleSnapshot, cli: 'claude' },
      }),
      undefined,
    )
    const runtime = humanMcpRuntime(run)!
    assert.equal(runtime.command, process.execPath)
    assert.ok(runtime.args.at(-1)?.endsWith('human-mcp-entry.ts'))
    assert.equal(runtime.env.WEFTPILOT_MODEL_SECRET, '')
    assert.equal(runtime.env.ANTHROPIC_API_KEY, '')
    assert.equal(runtime.env.NODE_OPTIONS, '')
    assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, '1')
  } finally {
    database.close()
  }
})
