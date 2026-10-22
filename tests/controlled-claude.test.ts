import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClaudeAdapter } from '../src/cli/claude-adapter.js'
import { executionModel } from '../src/kernel/model-runtime.js'
import { workspaceFixture } from './helpers/run-fixture.js'

test('受控 Claude 仅提供工作目录文件工具，不加载自定义工具、不绕过权限', () => {
  const adapter = new ClaudeAdapter({ permission: 'workspace-write' })

  const args = adapter.buildArgs('测试', 'stdin', {
    model: 'test-model',
    reasoningEffort: 'low',
  })

  assert.ok(args.includes('--restricted'))
  assert.ok(args.includes('--safe-mode'))
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk')
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write')
  assert.equal(args.includes('--dangerously-skip-permissions'), false)

  const read = new ClaudeAdapter({ permission: 'read-only' }).buildArgs(
    '测试',
    'stdin',
  )

  assert.equal(read[read.indexOf('--tools') + 1], 'Read,Glob,Grep')
  assert.ok(
    new ClaudeAdapter()
      .buildArgs('旧入口', 'stdin')
      .includes('--dangerously-skip-permissions'),
  )
})

test('CLI 来自角色快照，Claude 角色不会交给 Codex，也不注入空模型环境', () => {
  const { database, run } = workspaceFixture()
  try {
    const runtime = executionModel({
      ...run,
      roleSnapshot: { ...run.roleSnapshot, cli: 'claude' },
    })

    assert.equal(runtime.adapter.id, 'claude')
    assert.deepEqual(runtime.env, {})
  } finally {
    database.close()
  }
})
