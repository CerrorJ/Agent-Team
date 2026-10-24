import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executionPrompt } from '../src/kernel/role-trial-files.js'
import { workspaceFixture } from './helpers/run-fixture.js'

test('旧Run和空要求保持原提示；新要求只读取执行快照，角色试运行仍为受控挑战', () => {
  const { database, run } = workspaceFixture()
  try {
    const original = `职责：${run.roleSnapshot.responsibility}\n任务：${run.goalSnapshot}\n验收条件：${run.acceptanceSnapshot}\n此前退回意见：无`
    assert.equal(executionPrompt(run), original)

    const empty = {
      ...run,
      roleSnapshot: {
        ...run.roleSnapshot,
        inputRequirements: '',
        deliveryRequirements: '',
      },
    }

    assert.equal(executionPrompt(empty), original)

    const configured = {
      ...run,
      roleSnapshot: {
        ...run.roleSnapshot,
        inputRequirements: '已确认的接口',
        deliveryRequirements: '版本化文档',
      },
    }

    const prompt = executionPrompt(configured)
    assert.match(prompt, /输入要求：已确认的接口/)
    assert.match(prompt, /交付要求：版本化文档/)
    assert.equal(executionPrompt(run), original)

    const trial = {
      inputFile: 'challenge.txt',
      outputFile: 'answer.txt',
      challenge: 'secret-challenge',
    }

    const trialPrompt = executionPrompt({ ...configured, trial })
    assert.equal(trialPrompt, executionPrompt({ ...run, trial }))
    assert.doesNotMatch(trialPrompt, /secret-challenge|已确认的接口|版本化文档/)
  } finally {
    database.close()
  }
})
