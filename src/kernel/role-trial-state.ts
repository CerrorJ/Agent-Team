import { roleVersionSchema, type Run } from './business-contracts.js'
import { RoleReadinessStore } from './role-readiness-store.js'
import type { WorkspaceStore } from './workspace-store.js'

/** 过期配置或被手动停用的试运行结果不能启用新版本；健康结果与用户启用决定分开。 */
export const finishRoleTrial = (
  store: WorkspaceStore,
  run: Run,
  succeeded: boolean,
  failureCode?: string,
): void => {
  if (run.purpose !== 'role_trial') return

  const role = store.get(
    'role_versions',
    run.roleSnapshot.id,
    roleVersionSchema,
  )

  if (role.version !== run.roleSnapshot.version) return
  const readiness = new RoleReadinessStore(store)
  const state = readiness.read(role)
  if (state.latestTrialRunId !== run.id || state.state !== 'trial_running')
    return
  readiness.save({
    ...state,
    version: state.version + 1,
    state: succeeded ? 'ready' : 'draft',
    enabled: false,
    failureCode: succeeded ? null : (failureCode ?? 'ROLE_TRIAL_INCOMPLETE'),
    updatedAt: new Date().toISOString(),
  })
}
