import type { BusinessCommand } from './business-contracts.js'
import { teamVersionSchema } from './product-contracts.js'
import { ProductStore } from './product-store.js'
import type { WorkspaceStore } from './workspace-store.js'

type TeamSave = Extract<BusinessCommand, { type: 'team.save' }>

/** 同一命令事务内校验最新版本与名称；历史重名不迁移，未改名称的旧团队仍可编辑。 */
export const resolveTeamConfiguration = (input: {
  store: WorkspaceStore
  command: TeamSave
  id: string
}) => {
  const { store, command, id } = input

  const latest = new Map(
    new ProductStore(store)
      .list('team_versions', teamVersionSchema)
      .map((team) => [team.id, team]),
  )

  const previous = latest.get(id)
  if ((previous?.version ?? 0) !== command.expectedVersion)
    throw new Error('VERSION_CONFLICT')
  if (
    previous?.name !== command.name &&
    [...latest.values()].some(
      (team) =>
        team.id !== id &&
        canonicalName(team.name) === canonicalName(command.name),
    )
  )
    throw new Error('TEAM_NAME_TAKEN')
  // 缺省保持旧渠道兼容；空字符串是明确清除，不回填或抹除已有说明。
  const description = command.description ?? previous?.description
  return description === undefined ? {} : { description }
}

const canonicalName = (name: string): string =>
  name.trim().normalize('NFKC').toLowerCase()
