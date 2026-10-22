import { CommandLedger } from './command-ledger.js'
import { prepareCatalogCommand } from './catalog-commands.js'
import { prepareRunCommand } from './run-commands.js'
import { acceptDelivery } from './acceptance-command.js'
import { LocalScheduler } from './local-scheduler.js'
import type { CliExecutionPort } from './run-execution.js'
import type { WorkspaceStore } from './workspace-store.js'
import type { BusinessCommand } from './business-contracts.js'

export interface CommandOutcome {
  id: string
  status: 'accepted' | 'completed'
}

/** 桌面与其他渠道共用的应用入口；操作者身份由宿主绑定，不接收页面自报身份。 */
export class WorkspaceService {
  private readonly ledger: CommandLedger
  private readonly scheduler: LocalScheduler
  private closing = false

  constructor(
    private readonly options: {
      store: WorkspaceStore
      dataDirectory: string
      execute?: CliExecutionPort
    },
  ) {
    this.ledger = new CommandLedger(options.store)
    this.scheduler = new LocalScheduler(options)
    this.scheduler.recover()
  }

  command(input: { key: string; command: BusinessCommand }): CommandOutcome {
    if (this.closing) throw new Error('KERNEL_STOPPED: 内核正在退出')
    const previous = this.ledger.find<CommandOutcome>(input)
    if (previous) return previous
    const operation = this.prepare(input.command)

    const result = this.ledger.execute(input, () => ({
      ...operation(),
      status: input.command.type.startsWith('run.')
        ? ('accepted' as const)
        : ('completed' as const),
    }))

    this.scheduler.kick()
    return result
  }

  async shutdown(): Promise<void> {
    this.closing = true
    await this.scheduler.shutdown()
  }

  private prepare(command: BusinessCommand): () => { id: string } {
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
