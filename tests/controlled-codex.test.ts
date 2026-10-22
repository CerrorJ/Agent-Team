import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexAdapter } from '../src/cli/codex-adapter.js'

test('桌面 Codex 明确权限，不绕过沙箱，也不生成旧服务 MCP 配置', () => {
  const adapter = new CodexAdapter({ permission: 'workspace-write' })

  const args = adapter.buildArgs('测试 & 不解释', 'stdin', {
    model: 'model-id',
  })

  assert.equal(args.at(-1), '-')
  assert.deepEqual(args.slice(0, 2), ['--sandbox', 'workspace-write'])
  assert.ok(args.includes('--ignore-user-config'))
  assert.ok(args.includes('--ignore-rules'))
  assert.ok(!args.some((arg) => /bypass|yolo|profile/.test(arg)))
  const resumed = adapter.buildResumeArgs('继续', 'abc-session', 'stdin')
  assert.ok(resumed.includes('resume'))
  assert.ok(resumed.includes('abc-session'))
})
