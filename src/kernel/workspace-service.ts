import { CommandLedger } from './command-ledger.js'
import {
  prepareCatalogCommand,
  type CatalogCommand,
} from './catalog-commands.js'
import { prepareRunCommand, type RunCommand } from './run-commands.js'
import { acceptDelivery } from './acceptance-command.js'
import { LocalScheduler } from './local-scheduler.js'
import { saveProductObject, isProductCommand } from './product-commands.js'
import { prepareRoleCommand, isRoleLifecycleCommand } from './role-commands.js'
import { prepareTeamCommand, isTeamCommand } from './team-commands.js'
import type { CliExecutionPort } from './run-execution.js'
import type { CredentialResolver } from './credential-contracts.js'
import type { WorkspaceStore } from './workspace-store.js'
import type { BusinessCommand } from './business-contracts.js'
import { resolveHumanRequest } from './human-commands.js'
import type { HumanActor } from './human-contracts.js'
import { expireHumanRequests } from './human-expiration.js'
import { FeishuStore } from './feishu-store.js'
import { SkillStore, type SkillCommand } from './skill-store.js'
import { SkillRuntime } from './skill-runtime.js'
import type { SkillFetch } from './skill-download.js'

export interface CommandOutcome {
  id: string
  status: 'accepted' | 'completed'
}

/** 桌面与其他渠道共用的应用入口；操作者身份由宿主绑定，不接收页面自报身份。 */
export class WorkspaceService {
  private readonly ledger: CommandLedger
  private readonly scheduler: LocalScheduler
  private readonly skills: SkillRuntime
  private closing = false

  constructor(
    private readonly options: {
      store: WorkspaceStore
      dataDirectory: string
      execute?: CliExecutionPort
      credentials?: CredentialResolver
      skillFetch?: SkillFetch
    },
  ) {
    this.ledger = new CommandLedger(options.store)
    this.scheduler = new LocalScheduler(options)
    this.scheduler.recover()
    this.skills = new SkillRuntime({
      ...options,
      ...(options.skillFetch ? { fetcher: options.skillFetch } : {}),
    })
  }

  command(
    input: { key: string; command: BusinessCommand },
    actor: HumanActor = { channel: 'desktop', identity: 'local-owner' },
  ): CommandOutcome {
    if (this.closing) throw new Error('KERNEL_STOPPED: 内核正在退出')
    const previous = this.ledger.find<CommandOutcome>(input)
    if (previous) return previous
    expireHumanRequests(this.options.store)

    const operation =
      input.command.type === 'human.resolve'
        ? () =>
            resolveHumanRequest({
              store: this.options.store,
              command: input.command as Extract<
                BusinessCommand,
                { type: 'human.resolve' }
              >,
              actor,
            })
        : this.prepare(input.command)

    const result = this.ledger.execute(input, () => ({
      ...operation(),
      status:
        input.command.type.startsWith('run.') ||
        input.command.type === 'team.start' ||
        input.command.type === 'role.trial'
          ? ('accepted' as const)
          : ('completed' as const),
    }))

    this.scheduler.kick()
    this.skills.kick()
    return result
  }

  async shutdown(): Promise<void> {
    this.closing = true
    await this.skills.shutdown()
    await this.scheduler.shutdown()
  }

  private prepare(
    command: Exclude<BusinessCommand, { type: 'human.resolve' }>,
  ): () => { id: string } {
    const { store, dataDirectory } = this.options
    if (command.type.startsWith('skill.'))
      return () => new SkillStore(store).command(command as SkillCommand)
    if (command.type === 'feishu.save')
      return () => new FeishuStore(store).save(command)
    if (isProductCommand(command))
      return () => saveProductObject({ store, command })
    if (isRoleLifecycleCommand(command))
      return prepareRoleCommand({ store, command, dataDirectory })
    if (isTeamCommand(command))
      return prepareTeamCommand({ store, command, dataDirectory })
    return this.prepareTaskCommand(
      command as Exclude<typeof command, SkillCommand>,
    )
  }

  private prepareTaskCommand(
    command:
      | CatalogCommand
      | RunCommand
      | Extract<BusinessCommand, { type: 'delivery.accept' }>,
  ): () => { id: string } {
    const { store, dataDirectory } = this.options
    switch (command.type) {
      case 'project.create':
      case 'role.save':
      case 'task.create':
        return prepareCatalogCommand({ store, command })
      case 'run.start':
      case 'run.retry':
      case 'run.stop':
        return prepareRunCommand({ store, command, dataDirectory })
      case 'delivery.accept':
        return () => acceptDelivery({ store, command })
    }
  }
}
