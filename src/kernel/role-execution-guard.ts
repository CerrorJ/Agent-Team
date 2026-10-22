import { roleVersionSchema } from './business-contracts.js'
import { RoleReadinessStore } from './role-readiness-store.js'
import type { WorkspaceStore } from './workspace-store.js'

export const assertRoleCanExecute = (
  store: WorkspaceStore,
  roleId: string,
): void => {
  const role = store.get('role_versions', roleId, roleVersionSchema)
  const state = new RoleReadinessStore(store).read(role)
  if (state.state !== 'ready' || !state.enabled)
    throw new Error('ROLE_NOT_READY')
}
