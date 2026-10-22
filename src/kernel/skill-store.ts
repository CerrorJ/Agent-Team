import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { WorkspaceStore } from './workspace-store.js'
import type { BusinessCommand } from './business-contracts.js'
import {
  skillSourceSchema,
  skillImportSchema,
  skillPackageSchema,
  type SkillSource,
  type SkillImport,
  type SkillPackage,
  type SkillReference,
} from './skill-contracts.js'
import { validateSkillPath } from './skill-paths.js'

type Table = 'skill_sources' | 'skill_imports' | 'skill_packages'
export type SkillCommand = Extract<
  BusinessCommand,
  {
    type:
      | 'skill.source.save'
      | 'skill.import'
      | 'skill.activate'
      | 'skill.uninstall'
  }
>

/** 网络与文件操作不在此事务内；只保存可重放意图、不可变来源和安装核对结果。 */
export class SkillStore {
  constructor(readonly store: WorkspaceStore) {}

  list<T>(table: Table, schema: z.ZodType<T>): T[] {
    return this.store.database
      .prepare(`SELECT data FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => schema.parse(JSON.parse(String(row.data))))
  }

  get<T>(table: Table, id: string, schema: z.ZodType<T>, version?: number): T {
    const row = this.store.database
      .prepare(
        `SELECT data FROM ${table} WHERE id=? ${version ? 'AND version=?' : ''} ORDER BY version DESC LIMIT 1`,
      )
      .get(...(version ? [id, version] : [id]))

    if (!row) throw new Error('NOT_FOUND')
    return schema.parse(JSON.parse(String(row.data)))
  }

  snapshot() {
    return {
      skillSources: this.list('skill_sources', skillSourceSchema),
      skillImports: this.list('skill_imports', skillImportSchema),
      skills: this.list('skill_packages', skillPackageSchema),
    }
  }

  command(command: SkillCommand): { id: string } {
    switch (command.type) {
      case 'skill.source.save':
        return this.saveSource(command)
      case 'skill.import':
        return this.queue(command)
      case 'skill.activate':
        return this.activate(command)
      case 'skill.uninstall': {
        const skill = this.get('skill_packages', command.id, skillPackageSchema)
        if (skill.version !== command.expectedVersion)
          throw new Error('VERSION_CONFLICT')
        this.updatePackage({
          ...skill,
          version: skill.version + 1,
          available: false,
        })
        return { id: skill.id }
      }
    }
  }

  resolve(
    references: SkillReference[],
    requireAvailable = true,
  ): SkillPackage[] {
    if (new Set(references.map((ref) => ref.id)).size !== references.length)
      throw new Error('SKILL_REFERENCE_INVALID')
    return references.map((ref) => {
      const skill = this.get('skill_packages', ref.id, skillPackageSchema)
      if (skill.digest !== ref.digest || (requireAvailable && !skill.available))
        throw new Error('SKILL_NOT_AVAILABLE')
      return skill
    })
  }

  updateImport(item: SkillImport): void {
    skillImportSchema.parse(item)
    this.update('skill_imports', item)
    this.store.event('skill.import_changed', item)
  }

  addPackage(skill: SkillPackage): void {
    skillPackageSchema.parse(skill)
    this.insert('skill_packages', skill)
    this.store.event('skill.installed', skill)
  }

  private updatePackage(skill: SkillPackage): void {
    this.update('skill_packages', skillPackageSchema.parse(skill))
    this.store.event('skill.availability_changed', skill)
  }

  private saveSource(
    command: Extract<SkillCommand, { type: 'skill.source.save' }>,
  ) {
    const id = command.id ?? randomUUID()

    const previous = this.store.database
      .prepare('SELECT MAX(version) AS version FROM skill_sources WHERE id=?')
      .get(id)

    if (Number(previous?.version ?? 0) !== command.expectedVersion)
      throw new Error('VERSION_CONFLICT')

    const source: SkillSource = skillSourceSchema.parse({
      id,
      version: command.expectedVersion + 1,
      name: command.name,
      repository: command.repository,
      commit: command.commit,
      createdAt: new Date().toISOString(),
    })

    this.insert('skill_sources', source)
    this.store.event('skill.source_version_created', source)
    return { id }
  }

  private queue(command: Extract<SkillCommand, { type: 'skill.import' }>) {
    validateSkillPath(command.directory)
    validateSkillPath(command.licensePath)

    const source = this.get(
      'skill_sources',
      command.sourceId,
      skillSourceSchema,
      command.sourceVersion,
    )

    const now = new Date().toISOString()

    const item: SkillImport = {
      id: randomUUID(),
      version: 1,
      source,
      directory: command.directory,
      licensePath: command.licensePath,
      state: 'queued',
      package: null,
      failureCode: null,
      createdAt: now,
      updatedAt: now,
    }

    this.insert('skill_imports', item)
    this.store.event('skill.import_created', item)
    return { id: item.id }
  }

  private activate(command: Extract<SkillCommand, { type: 'skill.activate' }>) {
    const item = this.get('skill_imports', command.id, skillImportSchema)
    if (item.version !== command.expectedVersion)
      throw new Error('VERSION_CONFLICT')
    if (
      item.state !== 'preview_ready' ||
      !item.package ||
      item.package.digest !== command.digest
    )
      throw new Error('SKILL_PREVIEW_REQUIRED')
    this.updateImport({
      ...item,
      version: item.version + 1,
      state: 'activating',
      updatedAt: new Date().toISOString(),
    })
    return { id: item.id }
  }

  private insert(table: Table, value: { id: string; version: number }) {
    this.store.database
      .prepare(`INSERT INTO ${table}(id,version,data) VALUES(?,?,?)`)
      .run(value.id, value.version, JSON.stringify(value))
  }

  private update(table: Table, value: { id: string; version: number }) {
    const result = this.store.database
      .prepare(`UPDATE ${table} SET version=?,data=? WHERE id=? AND version=?`)
      .run(value.version, JSON.stringify(value), value.id, value.version - 1)

    if (result.changes !== 1) throw new Error('VERSION_CONFLICT')
  }
}
