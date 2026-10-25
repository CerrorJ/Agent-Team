import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { ownedTempDirectory } from './owned-temp-directory.js'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createKernel,
  type EmbeddedKernel,
  type KernelOptions,
} from '../../src/kernel/kernel.js'
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

type TestKernelOptions = Omit<
  KernelOptions,
  'dataDirectory' | 'sourceCommit' | 'execute'
>

export const localKernelFixture = async (
  execute: CliExecutionPort,
  options: TestKernelOptions = {},
) => {
  const temporary = ownedTempDirectory('weftpilot-role-lifecycle-')
  const directory = temporary.directory
  const repositoryPath = join(directory, 'repository')
  initializeRepository(repositoryPath)

  const kernel = createKernel({
    ...options,
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
    directory,
    dataDirectory: join(directory, 'data'),
    kernel,
    projectId,
    command: (command: BusinessCommand, key?: string) =>
      issueCommand(kernel, command, key),
    snapshot: () => readSnapshot(kernel),
    cleanup: async () => {
      await kernel.shutdown()
      temporary.remove()
    },
  }
}

const initializeRepository = (repositoryPath: string): void => {
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
}
