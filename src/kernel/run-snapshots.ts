import type { WorkspaceStore } from './workspace-store.js'
import { ProductStore } from './product-store.js'
import {
  projectSchema,
  roleVersionSchema,
  type Task,
} from './business-contracts.js'
import { requirementVersionSchema } from './product-contracts.js'
import { randomUUID } from 'node:crypto'

/** 同一命令事务内捕获确切需求和角色版本；之后编辑只追加新版本。 */
export const captureBusinessConfiguration = (
  store: WorkspaceStore,
  task: Task,
) => ({
  roleSnapshot: store.get('role_versions', task.roleId, roleVersionSchema),
  goalSnapshot: task.goal,
  acceptanceSnapshot: task.acceptanceCriteria,
  projectContextSnapshot: captureProjectContext(store, task.projectId),
  requirementSnapshot: task.requirementRef
    ? new ProductStore(store).get(
        'requirement_versions',
        task.requirementRef,
        requirementVersionSchema,
      )
    : null,
})

const captureProjectContext = (store: WorkspaceStore, projectId: string) => {
  const { version, name, goal, description, defaultTeamId } = store.get(
    'projects',
    projectId,
    projectSchema,
  )

  return {
    projectId,
    projectVersion: version,
    name,
    goal,
    description,
    defaultTeamId,
  }
}

export const captureTaskConfiguration = (
  store: WorkspaceStore,
  task: Task,
  runId: string,
) => ({
  ...captureBusinessConfiguration(store, task),
  purpose:
    task.purpose === 'role_trial' ? ('role_trial' as const) : ('task' as const),
  trial:
    task.purpose === 'role_trial'
      ? {
          challenge: randomUUID(),
          inputFile: `weftpilot-trial-${runId}.input.txt`,
          outputFile:
            store.get('role_versions', task.roleId, roleVersionSchema)
              .permission === 'workspace-write'
              ? `weftpilot-trial-${runId}.output.txt`
              : null,
        }
      : null,
})
