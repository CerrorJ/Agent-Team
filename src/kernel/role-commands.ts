import { randomUUID } from 'node:crypto'
import {
  projectSchema,
  roleVersionSchema,
  runSchema,
  type BusinessCommand,
  type Task,
} from './business-contracts.js'
import { projectBaseline } from './git-workspace.js'
import { createTaskRun } from './run-commands.js'
import { RoleReadinessStore } from './role-readiness-store.js'
import type { WorkspaceStore } from './workspace-store.js'
import { SkillStore } from './skill-store.js'

type RoleCommand = Extract<
  BusinessCommand,
  { type: 'role.trial' | 'role.setEnabled' }
>
export const isRoleLifecycleCommand = (
  command: BusinessCommand,
): command is RoleCommand =>
  command.type === 'role.trial' || command.type === 'role.setEnabled'

export const prepareRoleCommand = (input: {
  store: WorkspaceStore
  command: RoleCommand
  dataDirectory: string
}): (() => { id: string }) => {
  const { command, store } = input
  const role = store.get('role_versions', command.roleId, roleVersionSchema)
  if (role.version !== command.expectedRoleVersion)
    throw new Error('VERSION_CONFLICT')
  if (command.type === 'role.setEnabled')
    return () => setEnabled(store, command)
  new SkillStore(store).resolve(role.skills)

  const active = store
    .list('runs', runSchema)
    .some(
      (run) =>
        run.purpose === 'role_trial' &&
        run.roleSnapshot.id === role.id &&
        run.processState !== 'confirmed_ended',
    )

  if (active) throw new Error('ROLE_TRIAL_ACTIVE')
  const project = store.get('projects', command.projectId, projectSchema)
  const baselineCommit = projectBaseline(project)
  return () => createTrial({ ...input, command, baselineCommit })
}

const createTrial = (input: {
  store: WorkspaceStore
  command: Extract<RoleCommand, { type: 'role.trial' }>
  dataDirectory: string
  baselineCommit: string
}) => {
  const { store, command } = input
  const role = store.get('role_versions', command.roleId, roleVersionSchema)
  if (role.version !== command.expectedRoleVersion)
    throw new Error('VERSION_CONFLICT')

  const task: Task = {
    id: randomUUID(),
    version: 1,
    projectId: command.projectId,
    roleId: role.id,
    purpose: 'role_trial',
    title: `${role.name} · 配置试运行 v${role.version}`,
    goal: '受控读取或写入随机挑战文件',
    acceptanceCriteria: '验证实际文件结果，不以模型声称完成为准',
    status: 'ready',
    createdAt: new Date().toISOString(),
  }

  store.addTask(task)

  const result = createTaskRun({
    store,
    task,
    baselineCommit: input.baselineCommit,
    dataDirectory: input.dataDirectory,
  })

  const readiness = new RoleReadinessStore(store)
  const state = readiness.read(role)
  readiness.save({
    ...state,
    version: state.version + 1,
    state: 'trial_running',
    enabled: false,
    latestTrialRunId: result.id,
    failureCode: null,
    updatedAt: new Date().toISOString(),
  })
  return result
}

const setEnabled = (
  store: WorkspaceStore,
  command: Extract<RoleCommand, { type: 'role.setEnabled' }>,
) => {
  const role = store.get('role_versions', command.roleId, roleVersionSchema)
  if (role.version !== command.expectedRoleVersion)
    throw new Error('VERSION_CONFLICT')
  const readiness = new RoleReadinessStore(store)
  const state = readiness.read(role)
  if (state.version !== command.expectedReadinessVersion)
    throw new Error('VERSION_CONFLICT')
  if (command.enabled) {
    new SkillStore(store).resolve(role.skills)
    assertTrialPassed(store, state.latestTrialRunId, role)
  }
  readiness.save({
    ...state,
    version: state.version + 1,
    state: command.enabled ? 'ready' : 'disabled',
    enabled: command.enabled,
    updatedAt: new Date().toISOString(),
  })
  return { id: role.id }
}

const assertTrialPassed = (
  store: WorkspaceStore,
  runId: string | null,
  role: { id: string; version: number },
) => {
  if (!runId) throw new Error('ROLE_NOT_READY')
  const run = store.get('runs', runId, runSchema)
  if (
    run.purpose !== 'role_trial' ||
    run.roleSnapshot.id !== role.id ||
    run.roleSnapshot.version !== role.version ||
    run.status !== 'succeeded' ||
    run.processState !== 'confirmed_ended'
  )
    throw new Error('ROLE_NOT_READY')
}
