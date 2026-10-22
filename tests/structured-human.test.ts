import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ClaudeAdapter } from '../src/cli/claude-adapter.js'
import { claudeJsonSchema } from '../src/cli/claude-json-schema.js'
import {
  humanOutputJsonSchema,
  parseStructuredHumanOutput,
} from '../src/cli/structured-human-output.js'

test('Claude人工请求保留安全模式，以实际结构化结果产生请求，不伪造MCP工具调用', () => {
  const adapter = new ClaudeAdapter({
    permission: 'workspace-write',
    humanRequests: true,
  })

  const args = adapter.buildArgs('测试', 'stdin')
  assert.ok(args.includes('--safe-mode'))
  assert.ok(args.includes('--restricted'))
  assert.equal(args[args.indexOf('--json-schema') + 1], humanOutputJsonSchema())
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')
  const payload = { kind: 'plan', title: '受控方案', summary: '仅本次计划' }

  const events = adapter.parseEvents(
    JSON.stringify({
      type: 'result',
      session_id: 'session-test',
      result: '',
      structured_output: { outcome: payload },
    }),
  )

  assert.equal(events.length, 1)
  const event = events[0]!
  assert.equal(event.type, 'result')
  if (event.type !== 'result') throw new Error('MISSING_RESULT')
  assert.deepEqual(event.humanRequest, payload)
  assert.equal(event.sessionId, 'session-test')
  assert.equal('toolCalls' in event, false)
})

test('结构化请求无效时不能当执行成功；正常完成仍保留实际回答，旧独立入口行为不变', () => {
  assert.equal(
    parseStructuredHumanOutput({ kind: 'plan', title: '缺少摘要' }).type,
    'error',
  )

  const completed = parseStructuredHumanOutput({
    outcome: { kind: 'result', answer: '实际完成内容' },
  })

  assert.deepEqual(completed, { type: 'result', answer: '实际完成内容' })

  const legacy = new ClaudeAdapter().parseEvents(
    JSON.stringify({
      type: 'result',
      result: '旧入口回答',
      structured_output: { kind: 'plan' },
    }),
  )

  assert.ok(
    legacy.some(
      (event) => event.type === 'result' && event.answer === '旧入口回答',
    ),
  )
  assert.equal(
    legacy.some((event) => event.type === 'result' && !!event.humanRequest),
    false,
  )
})

test('Claude传输schema使用根对象、兼容子集；完整长度限制仍在返回边界，字段名不会被当关键字删除', () => {
  const schema = JSON.parse(humanOutputJsonSchema())
  assert.equal(schema.type, 'object')
  assert.equal(schema.$schema, undefined)
  assert.ok(schema.properties.outcome.anyOf)
  assert.equal(JSON.stringify(schema).includes('"maxLength":'), false)
  assert.equal(
    parseStructuredHumanOutput({
      outcome: { kind: 'result', answer: 'x'.repeat(200001) },
    }).type,
    'error',
  )
  assert.deepEqual(
    claudeJsonSchema({
      type: 'object',
      properties: { maximum: { type: 'string', maxLength: 10 } },
    }),
    {
      type: 'object',
      properties: {
        maximum: { type: 'string', description: '(maxLength=10)' },
      },
    },
  )
})
