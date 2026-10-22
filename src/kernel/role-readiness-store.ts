import type { RoleVersion } from './business-contracts.js'
import { roleReadinessSchema, type RoleReadiness } from './role-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'

const draftState = (role: RoleVersion, version: number): RoleReadiness => ({
  roleId: role.id,
  roleVersion: role.version,
  version,
  state: 'draft',
  enabled: false,
  latestTrialRunId: null,
  failureCode: null,
  updatedAt: role.createdAt,
})

/** 配置版本与启用状态分开；修改配置不修改旧 Run，也不能沿用旧版本的试运行证明。 */
export class RoleReadinessStore {
  constructor(private readonly store: WorkspaceStore) {}

  read(role: RoleVersion): RoleReadiness {
    const row = this.store.database
      .prepare('SELECT data FROM role_readiness WHERE role_id=?')
      .get(role.id)

    if (!row) return draftState(role, 0)
    const value = roleReadinessSchema.parse(JSON.parse(String(row.data)))
    return value.roleVersion === role.version
      ? value
      : draftState(role, value.version)
  }

  reset(role: RoleVersion): void {
    const current = this.read(role)
    this.save({
      ...draftState(role, current.version + 1),
      updatedAt: new Date().toISOString(),
    })
  }

  save(value: RoleReadiness): void {
    const data = JSON.stringify(roleReadinessSchema.parse(value))
    if (value.version === 1)
      this.store.database
        .prepare(
          'INSERT INTO role_readiness(role_id,version,data) VALUES(?,?,?)',
        )
        .run(value.roleId, value.version, data)
    else {
      const result = this.store.database
        .prepare(
          'UPDATE role_readiness SET version=?,data=? WHERE role_id=? AND version=?',
        )
        .run(value.version, data, value.roleId, value.version - 1)

      if (result.changes !== 1) throw new Error('VERSION_CONFLICT')
    }
    this.store.event('role.readinessChanged', { ...value, id: value.roleId })
  }

  snapshot(roles: RoleVersion[]): RoleReadiness[] {
    const latest = new Map<string, RoleVersion>()
    for (const role of roles)
      if ((latest.get(role.id)?.version ?? 0) < role.version)
        latest.set(role.id, role)
    return [...latest.values()].map((role) => this.read(role))
  }
}
