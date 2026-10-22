import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createKernel, type EmbeddedKernel } from '../../src/kernel/kernel.js'
import { workspaceSnapshotSchema } from '../../src/kernel/workspace-contracts.js'
import type { BusinessCommand } from '../../src/kernel/business-contracts.js'
import type { CliExecutionPort } from '../../src/kernel/run-execution.js'

export const issueCommand = async (
  kernel: EmbeddedKernel,
  command: BusinessCommand,
  key: string = randomUUID(),
) => {
  const response = await kernel.dispatch({
    protocolVersion: 1,
    requestId: randomUUID(),
    method: 'workspace.command',
    key,
    command,
  })

  if (response.status === 'rejected') throw new Error(response.error.code)
  return (response.result as { id: string }).id
}

export const readSnapshot = async (kernel: EmbeddedKernel) => {
  const response = await kernel.dispatch({
    protocolVersion: 1,
    requestId: randomUUID(),
    method: 'workspace.snapshot',
  })

  if (response.status === 'rejected') throw new Error(response.error.code)
  return workspaceSnapshotSchema.parse(response.result)
}

export const waitForRun = async (kernel: EmbeddedKernel, runId: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const run = (await readSnapshot(kernel)).runs.find(
      (item) => item.id === runId,
    )

    if (
      run &&
      (run.processState === 'confirmed_ended' ||
        run.processState === 'uncertain')
    )
      return run
    await delay(20)
  }
  throw new Error('测试执行未结束')
}

export const localKernelFixture = async (execute: CliExecutionPort) => {
  const directory = mkdtempSync(join(tmpdir(), 'weftpilot-role-lifecycle-'))
  const repositoryPath = join(directory, 'repository')
  mkdirSync(repositoryPath)
  execFileSync('git', ['init', '-b', 'main'], {
    cwd: repositoryPath,
    stdio: 'ignore',
  })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=WeftPilot Test',
      '-c',
      'user.email=test@weftpilot.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'baseline',
    ],
    { cwd: repositoryPath, stdio: 'ignore' },
  )

  const kernel = createKernel({
    dataDirectory: join(directory, 'data'),
    sourceCommit: 'a'.repeat(40),
    execute,
  })

  const projectId = await issueCommand(kernel, {
    type: 'project.create',
    name: '生命周期测试',
    repositoryPath,
    defaultBranch: 'main',
  })

  return {
    kernel,
    projectId,
    command: (command: BusinessCommand, key?: string) =>
      issueCommand(kernel, command, key),
    snapshot: () => readSnapshot(kernel),
    cleanup: async () => {
      await kernel.shutdown()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
