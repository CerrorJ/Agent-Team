import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { teamFixture } from './helpers/team-fixture.js'
import {
  waitForRun,
  readSnapshot,
  issueCommand,
} from './helpers/local-kernel-fixture.js'
import { createKernel } from '../src/kernel/kernel.js'
import type { CliRunResult } from '../src/cli/types.js'
import { workspaceFixture } from './helpers/run-fixture.js'
import { pauseForHuman } from '../src/kernel/human-pause.js'
import { HumanStore } from '../src/kernel/human-store.js'
import { runSchema, taskSchema } from '../src/kernel/business-contracts.js'
import { expireHumanRequests } from '../src/kernel/human-expiration.js'
import { resolveHumanRequest } from '../src/kernel/human-commands.js'

const approval = (): CliRunResult => ({
  answer: '',
  sessionId: randomUUID(),
  toolCalls: [
    {
      toolUseId: randomUUID(),
      toolName: 'request_approval',
      input: {
        operation: '单次测试操作',
        detail: '仅验证续接编排',
        impact: '合成工作目录',
        rollback: '保留旧文件',
        timeoutSeconds: 60,
      },
    },
  ],
})

test('真实 Git + 执行端口：审批续接同 Run 新段，旧段/配置/文件保留，幂等决定不重复执行', async () => {
  let calls = 0
  let sessionId = ''
  let firstCwd = ''

  const fixture = await teamFixture(async (options) => {
    calls++
    if (calls === 1) {
      firstCwd = options.cwd
      writeFileSync(join(options.cwd, 'before.txt'), 'before')
      const result = approval()
      sessionId = result.sessionId!
      return result
    }
    assert.equal(options.cwd, firstCwd)
    assert.equal(options.sessionId, sessionId)
    assert.equal(
      readFileSync(join(options.cwd, 'before.txt'), 'utf8'),
      'before',
    )
    assert.match(options.prompt, /单次操作请求/)
    return { answer: '仅端口编排结果', sessionId }
  })

  try {
    const taskId = await fixture.command({
      type: 'task.create',
      projectId: fixture.projectId,
      roleId: fixture.roleId,
      title: '等待审批',
      goal: '测试',
      acceptanceCriteria: '端口恢复',
    })

    const runId = await fixture.command({
      type: 'run.start',
      taskId,
      expectedVersion: 1,
    })

    const waiting = await waitForRun(fixture.kernel, runId)
    assert.equal(waiting.status, 'waiting_approval')
    assert.equal(waiting.processState, 'confirmed_ended')
    const request = (await fixture.snapshot()).humanRequests[0]!

    const database = new DatabaseSync(
      join(firstCwd, '../..', 'kernel.sqlite'),
      { readOnly: true },
    )

    const firstSegment = database
      .prepare(
        'SELECT id,ended_at,session_id FROM execution_segments WHERE run_id=? ORDER BY rowid',
      )
      .all(runId)[0]!

    database.close()
    assert.equal(
      (await fixture.snapshot()).deliveries.filter(
        (item) => item.runId === runId,
      ).length,
      0,
    )
    await assert.rejects(
      fixture.command({
        type: 'human.resolve',
        requestId: request.id,
        expectedVersion: 1,
        expectedDigest: '0'.repeat(64),
        response: { decision: 'approved' },
      }),
      /VERSION_CONFLICT/,
    )
    await assert.rejects(
      fixture.command({
        type: 'human.resolve',
        requestId: request.id,
        expectedVersion: 1,
        expectedDigest: request.digest,
        response: {
          decision: 'answered',
          answers: [{ questionId: 'q', answer: '无效类型' }],
        },
      }),
      /HUMAN_DECISION_INVALID/,
    )

    const command = {
      type: 'human.resolve' as const,
      requestId: request.id,
      expectedVersion: 1,
      expectedDigest: request.digest,
      response: { decision: 'approved' as const },
    }

    const key = randomUUID()
    assert.equal(await fixture.command(command, key), request.id)
    assert.equal(await fixture.command(command, key), request.id)
    const completed = await waitForRun(fixture.kernel, runId)
    assert.equal(completed.status, 'succeeded')
    assert.equal(completed.attempt, 1)
    assert.deepEqual(completed.roleSnapshot, waiting.roleSnapshot)
    assert.equal(calls, 2)

    const evidence = new DatabaseSync(
      join(firstCwd, '../..', 'kernel.sqlite'),
      { readOnly: true },
    )

    const segments = evidence
      .prepare(
        'SELECT id,ended_at,session_id FROM execution_segments WHERE run_id=? ORDER BY rowid',
      )
      .all(runId)

    evidence.close()
    assert.equal(segments.length, 2)
    assert.deepEqual(segments[0], firstSegment)
    assert.notEqual(segments[1]?.id, segments[0]?.id)
    assert.ok(
      segments.every(
        (segment) => segment.ended_at && segment.session_id === sessionId,
      ),
    )
    assert.equal(
      (await fixture.snapshot()).runs.filter((item) => item.taskId === taskId)
        .length,
      1,
    )
    await assert.rejects(fixture.command(command), /HUMAN_REQUEST_NOT_PENDING/)
  } finally {
    await fixture.cleanup()
  }
})

const pausedStore = (kind: 'operation' | 'clarification' = 'operation') => {
  const fixture = workspaceFixture()
  const { store, run } = fixture
  store.transaction(() => {
    store.updateRun({
      ...run,
      version: 2,
      status: 'running',
      processState: 'active',
    })
    store.database
      .prepare('INSERT INTO execution_segments(id,run_id) VALUES(?,?)')
      .run(run.id, run.id)
  })
  const result = approval()
  if (kind === 'clarification')
    result.toolCalls = [
      {
        toolUseId: randomUUID(),
        toolName: 'request_clarification',
        input: {
          questions: [
            {
              id: 'format',
              prompt: '格式？',
              options: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
              ],
            },
          ],
        },
      },
    ]
  pauseForHuman({ store, runId: run.id, result })
  return { ...fixture, request: new HumanStore(store).list()[0]! }
}

test('过期作为独立持久决定，旧请求不能影响重试或新执行，拒绝保留原因且不续接', () => {
  const fixture = pausedStore()
  const { store, request, run, database } = fixture
  try {
    expireHumanRequests(store, Date.parse(request.expiresAt) + 1)
    assert.equal(new HumanStore(store).get(request.id).status, 'expired')
    assert.equal(
      store.get('runs', run.id, runSchema).failureCode,
      'HUMAN_REQUEST_EXPIRED',
    )
    assert.equal(store.get('tasks', run.taskId, taskSchema).status, 'ready')
    assert.throws(
      () =>
        store.transaction(() =>
          resolveHumanRequest({
            store,
            command: {
              type: 'human.resolve',
              requestId: request.id,
              expectedVersion: 1,
              expectedDigest: request.digest,
              response: { decision: 'approved' },
            },
            actor: { channel: 'feishu', identity: 'local-owner' },
          }),
        ),
      /HUMAN_REQUEST_EXPIRED/,
    )
    assert.equal(store.get('runs', run.id, runSchema).status, 'failed')
  } finally {
    database.close()
  }
  const second = pausedStore()
  try {
    second.store.transaction(() =>
      resolveHumanRequest({
        store: second.store,
        command: {
          type: 'human.resolve',
          requestId: second.request.id,
          expectedVersion: 1,
          expectedDigest: second.request.digest,
          response: { decision: 'rejected', reason: '风险不可接受' },
        },
        actor: { channel: 'desktop', identity: 'local-owner' },
      }),
    )
    assert.equal(
      new HumanStore(second.store).get(second.request.id).decision?.decision,
      'rejected',
    )
    assert.equal(
      second.store.get('runs', second.run.id, runSchema).continuation,
      null,
    )
  } finally {
    second.database.close()
  }
})

test('澄清拒绝缺题/重复题，不自动选推荐项，所有者自由文本进入本次续接', () => {
  const { store, request, database, run } = pausedStore('clarification')

  const respond = (questionId: string, answer: string) =>
    store.transaction(() =>
      resolveHumanRequest({
        store,
        command: {
          type: 'human.resolve',
          requestId: request.id,
          expectedVersion: 1,
          expectedDigest: request.digest,
          response: { decision: 'answered', answers: [{ questionId, answer }] },
        },
        actor: { channel: 'desktop', identity: 'local-owner' },
      }),
    )

  try {
    assert.throws(() => respond('other', '错误题'), /HUMAN_DECISION_INVALID/)
    assert.equal(new HumanStore(store).get(request.id).status, 'pending')
    respond('format', '自定义格式')
    const resumed = store.get('runs', run.id, runSchema)
    assert.equal(resumed.status, 'queued')
    assert.match(resumed.continuation!.prompt, /自定义格式/)
    assert.equal(
      new HumanStore(store).get(request.id).actor?.channel,
      'desktop',
    )
  } finally {
    database.close()
  }
})

test('等待态重启不重放CLI；停止撤销请求，重试另建Run，旧决定不能污染新Run', async () => {
  let calls = 0

  const fixture = await teamFixture(async (options) => {
    calls++
    assert.equal(options.sessionId, undefined)
    return approval()
  })

  let restored: ReturnType<typeof createKernel> | undefined
  try {
    const taskId = await fixture.command({
      type: 'task.create',
      projectId: fixture.projectId,
      roleId: fixture.roleId,
      title: '跨重启等待',
      goal: '测试',
      acceptanceCriteria: '不自动重放',
    })

    const runId = await fixture.command({
      type: 'run.start',
      taskId,
      expectedVersion: 1,
    })

    const waiting = await waitForRun(fixture.kernel, runId)
    const request = (await fixture.snapshot()).humanRequests[0]!
    await fixture.kernel.shutdown()
    restored = createKernel({
      dataDirectory: join(waiting.workDirectory, '../..'),
      sourceCommit: 'a'.repeat(40),
      execute: async (options) => {
        calls++
        assert.equal(options.sessionId, undefined)
        return { answer: '新Run端口结果' }
      },
    })
    const state = await readSnapshot(restored)
    assert.deepEqual(state.humanRequests[0], request)
    assert.equal(
      state.runs.find((run) => run.id === runId)?.status,
      'waiting_approval',
    )
    assert.equal(calls, 1)
    await issueCommand(restored, {
      type: 'run.stop',
      runId,
      expectedVersion: waiting.version,
    })

    const stopped = (await readSnapshot(restored)).runs.find(
      (run) => run.id === runId,
    )!

    assert.equal(stopped.status, 'stopped')
    assert.equal(
      (await readSnapshot(restored)).humanRequests[0]?.status,
      'cancelled',
    )

    const newId = await issueCommand(restored, {
      type: 'run.retry',
      runId,
      expectedVersion: stopped.version,
    })

    const next = await waitForRun(restored, newId)
    assert.notEqual(newId, runId)
    assert.equal(next.retryOfRunId, runId)
    assert.equal(next.attempt, 2)
    assert.equal(next.status, 'succeeded')
    await assert.rejects(
      issueCommand(restored, {
        type: 'human.resolve',
        requestId: request.id,
        expectedVersion: 1,
        expectedDigest: request.digest,
        response: { decision: 'approved' },
      }),
      /HUMAN_REQUEST_NOT_PENDING/,
    )
    assert.equal(
      (await readSnapshot(restored)).runs.find((run) => run.id === newId)
        ?.status,
      'succeeded',
    )
    assert.equal(calls, 2)
  } finally {
    await restored?.shutdown()
    await fixture.cleanup()
  }
})
