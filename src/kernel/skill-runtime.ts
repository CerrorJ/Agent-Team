import type { WorkspaceStore } from './workspace-store.js'
import { SkillStore } from './skill-store.js'
import { skillImportSchema, type SkillImport } from './skill-contracts.js'
import { stageSkill, activateSkillFiles } from './skill-staging.js'
import type { SkillFetch } from './skill-download.js'

/** 异步副作用由内核持有；退出取消网络并等待收尾，恢复只重做未完成下载或核对安装意图。 */
export class SkillRuntime {
  private readonly skills: SkillStore
  private readonly controller = new AbortController()
  private active: Promise<void> | undefined
  private closing = false

  constructor(
    private readonly options: {
      store: WorkspaceStore
      dataDirectory: string
      fetcher?: SkillFetch
    },
  ) {
    this.skills = new SkillStore(options.store)
    options.store.transaction(() => {
      for (const item of this.skills.list('skill_imports', skillImportSchema)) {
        if (item.state === 'fetching') this.change(item, { state: 'queued' })
      }
    })
    this.kick()
  }

  kick(): void {
    if (this.closing || this.active) return
    // 延后到外部命令事务完成，不把下载/rename包含在命令回执事务内。
    this.active = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.process())
      .finally(() => {
        this.active = undefined
      })
  }

  async shutdown(): Promise<void> {
    this.closing = true
    this.controller.abort()
    await this.active
  }

  private async process(): Promise<void> {
    while (!this.closing) {
      const item = this.skills
        .list('skill_imports', skillImportSchema)
        .find(
          (value) => value.state === 'queued' || value.state === 'activating',
        )

      if (!item) return
      try {
        if (item.state === 'queued') await this.download(item)
        else this.activate(item)
      } catch (error) {
        if (this.closing) return
        const code = error instanceof Error ? error.message.split(':')[0] : ''

        const failureCode = code?.startsWith('SKILL_')
          ? code
          : 'SKILL_DOWNLOAD_FAILED'

        const latest = this.skills.get(
          'skill_imports',
          item.id,
          skillImportSchema,
        )

        this.options.store.transaction(() =>
          this.change(latest, { state: 'failed', failureCode }),
        )
      }
    }
  }

  private async download(item: SkillImport): Promise<void> {
    this.options.store.transaction(() =>
      this.change(item, { state: 'fetching' }),
    )

    const skill = await stageSkill({
      dataDirectory: this.options.dataDirectory,
      item,
      signal: this.controller.signal,
      fetcher: this.options.fetcher ?? fetch,
    })

    this.controller.signal.throwIfAborted()
    const latest = this.skills.get('skill_imports', item.id, skillImportSchema)
    this.options.store.transaction(() =>
      this.change(latest, { state: 'preview_ready', package: skill }),
    )
  }

  private activate(item: SkillImport): void {
    if (!item.package) throw new Error('SKILL_PREVIEW_REQUIRED')
    activateSkillFiles({
      dataDirectory: this.options.dataDirectory,
      skill: item.package,
    })
    this.options.store.transaction(() => {
      this.skills.addPackage(item.package!)
      this.change(item, { state: 'installed' })
    })
  }

  private change(item: SkillImport, update: Partial<SkillImport>): void {
    this.skills.updateImport({
      ...item,
      ...update,
      version: item.version + 1,
      updatedAt: new Date().toISOString(),
    })
  }
}
