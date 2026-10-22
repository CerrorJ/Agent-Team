import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertExecutionTransition,
  assertRetryableExecution,
} from '../src/domain/run-state.js'

test('停止请求不等于停止确认，终态不可回到运行', () => {
  assertExecutionTransition('running', 'stopping')
  assertExecutionTransition('stopping', 'stopped')
  assert.throws(
    () => assertExecutionTransition('running', 'stopped'),
    /INVALID_STATE/,
  )
  assert.throws(
    () => assertExecutionTransition('succeeded', 'running'),
    /INVALID_STATE/,
  )
})

test('重试必须是已结束执行，未知进程状态不能自动重放', () => {
  assertRetryableExecution({ state: 'failed', processState: 'confirmed_ended' })
  assert.throws(
    () =>
      assertRetryableExecution({ state: 'running', processState: 'active' }),
    /RUN_ACTIVE/,
  )
  assert.throws(
    () =>
      assertRetryableExecution({
        state: 'interrupted',
        processState: 'uncertain',
      }),
    /STATE_UNCERTAIN/,
  )
})
