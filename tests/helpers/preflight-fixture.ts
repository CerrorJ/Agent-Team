import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { workspaceFixture } from './run-fixture.js'
import { RoleReadinessStore } from '../../src/kernel/role-readiness-store.js'
import { taskSchema } from '../../src/kernel/business-contracts.js'
import { CommandLedger } from '../../src/kernel/command-ledger.js'
import {
  prepareRunCommand,
  type RunCommand,
} from '../../src/kernel/run-commands.js'

// 受控就绪证明只用于状态/事务测试，不作为真实 CLI 认证或角色试运行证据。
export const preflightFixture = () => {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'weftpilot-preflight-')),
  )

  const { git, commit } = initializeRepository(directory)

  const f = workspaceFixture({
    persistRun: false,
    repositoryPath: directory,
    baselineCommit: git(['rev-parse', 'HEAD']),
  })

  const task = {
    ...f.store.get('tasks', f.run.taskId, taskSchema),
    status: 'ready' as const,
    version: 2,
  }

  f.store.transaction(() => {
    f.store.updateTask(task)
    new RoleReadinessStore(f.store).save({
      roleId: f.run.roleSnapshot.id,
      roleVersion: 1,
      version: 1,
      state: 'ready',
      enabled: true,
      latestTrialRunId: null,
      failureCode: null,
      updatedAt: new Date().toISOString(),
    })
  })

  const counts = () =>
    [
      'runs',
      'tasks',
      'workspace_events',
      'notification_outbox',
      'command_receipts',
    ].map(
      (table) =>
        f.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n,
    )

  const command = (command: RunCommand, key = randomUUID()) =>
    new CommandLedger(f.store).execute(
      { key, command },
      prepareRunCommand({ store: f.store, command, dataDirectory: directory }),
    )

  const cleanup = fixtureCleanup(f, directory)

  return { ...f, task, directory, git, commit, counts, command, cleanup }
}

const initializeRepository = (directory: string) => {
  const git = (args: string[]) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()

  const commit = () =>
    git([
      '-c',
      'user.name=WeftPilot Test',
      '-c',
      'user.email=test@weftpilot.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'baseline',
    ])

  git(['init', '-b', 'main'])
  commit()
  return { git, commit }
}

const fixtureCleanup = (
  f: ReturnType<typeof workspaceFixture>,
  directory: string,
) => {
  const parent = dirname(directory)
  return () => {
    f.database.close()
    if (
      realpathSync.native(directory) !== directory ||
      dirname(directory) !== parent ||
      !basename(directory).startsWith('weftpilot-preflight-')
    )
      throw new Error('FIXTURE_SCOPE_CHANGED')
    rmSync(directory, { recursive: true, force: true })
  }
}
