import type { WorkspaceStore } from './workspace-store.js'
import { publicError } from './public-errors.js'
import { executionPlan, preflightCommand } from './execution-plan.js'
import { executionQueueBlocker } from './queue-rules.js'
import { discoverTool } from './tool-discovery.js'
import {
  taskPreflightSchema,
  type PreflightInput,
  type PreflightCheck,
} from './preflight-contracts.js'

const queueCodes = {
  uncertain_project: 'STATE_UNCERTAIN',
  dependency_acceptance: 'DEPENDENCY_NOT_ACCEPTED',
  project_busy: 'PROJECT_BUSY',
  role_busy: 'ROLE_BUSY',
  capacity: 'MACHINE_CAPACITY',
} as const

/** 只读预检不试跑、不修复、不预留槽位；认证及实际模型调用必须保留“未验证”。 */
export const inspectTaskPreflight = (
  store: WorkspaceStore,
  intent: PreflightInput,
) => {
  const base = {
    formatVersion: 1 as const,
    checkedAt: new Date().toISOString(),
    intent,
  }

  try {
    const plan = executionPlan(store, preflightCommand(intent))

    const checks = plan.configurations.flatMap((config) =>
      configurationChecks(store, config),
    )

    checks.unshift({
      id: 'configuration',
      state: 'passed',
      code: 'CONFIGURATION_READY',
    })
    checks.push({ id: 'git', state: 'passed', code: 'GIT_BASELINE_READY' })
    const canStart = !checks.some((check) => check.state === 'blocked')
    return taskPreflightSchema.parse({
      ...base,
      canStart,
      configurationFingerprint: canStart ? plan.configurationFingerprint : null,
      project: { ...plan.project, ...plan.repository },
      tasks: plan.configurations.map(configurationSummary),
      checks,
    })
  } catch (error) {
    return taskPreflightSchema.parse({
      ...base,
      canStart: false,
      configurationFingerprint: null,
      project: null,
      tasks: [],
      checks: [
        {
          id: 'configuration',
          state: 'blocked',
          code: publicError(error).code,
        },
      ],
    })
  }
}

type Configuration = ReturnType<typeof executionPlan>['configurations'][number]

const configurationSummary = ({
  task,
  roleSnapshot,
  feedbackSnapshot,
}: Configuration) => ({
  id: task.id,
  version: task.version,
  title: task.title,
  goal: task.goal,
  acceptanceCriteria: task.acceptanceCriteria,
  parentTaskId: task.parentTaskId ?? null,
  dependencyTaskIds: task.dependencyTaskIds ?? [],
  role: roleSummary(roleSnapshot),
  requirementRef: task.requirementRef ?? null,
  feedback: feedbackSnapshot,
})

const configurationChecks = (
  store: WorkspaceStore,
  config: Configuration,
): PreflightCheck[] => {
  const { task, roleSnapshot } = config

  const blocker = executionQueueBlocker({
    store,
    run: { projectId: task.projectId, roleSnapshot },
    dependencyTaskIds: task.dependencyTaskIds ?? [],
  })

  return [
    {
      id: `cli-${task.id}`,
      taskId: task.id,
      state: discoverTool(roleSnapshot.cli) ? 'passed' : 'blocked',
      code: 'CLI_DISCOVERY',
    },
    {
      id: `queue-${task.id}`,
      taskId: task.id,
      state: blocker ? 'waiting' : 'passed',
      code: blocker ? queueCodes[blocker] : 'QUEUE_AVAILABLE',
    },
    {
      id: `authentication-${task.id}`,
      taskId: task.id,
      state: 'unverified',
      code: 'LIVE_AUTHENTICATION_UNVERIFIED',
    },
    {
      id: `version-${task.id}`,
      taskId: task.id,
      state: 'unverified',
      code: 'CLI_VERSION_UNVERIFIED',
    },
    {
      id: `model-${task.id}`,
      taskId: task.id,
      state: 'unverified',
      code: 'LIVE_MODEL_UNVERIFIED',
    },
  ]
}

const roleSummary = (role: Configuration['roleSnapshot']) => {
  const {
    id,
    version,
    name,
    cli,
    model,
    modelProfileSnapshot,
    permission,
    skills,
    maxConcurrency,
    responsibility,
    inputRequirements,
    deliveryRequirements,
  } = role

  return {
    id,
    version,
    name,
    cli,
    model,
    modelProfileSnapshot,
    permission,
    skills,
    maxConcurrency,
    responsibility,
    inputRequirements,
    deliveryRequirements,
  }
}
