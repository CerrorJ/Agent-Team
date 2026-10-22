import { DatabaseSync } from 'node:sqlite'
import { readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs'
import { basename, dirname, resolve, join } from 'node:path'
import {
  backupManifestSchema,
  type BackupManifest,
} from './backup-contracts.js'
import { DATA_SCHEMA_VERSION } from './protocol.js'
import { WorkspaceStore } from './workspace-store.js'
import type { WorkspaceSnapshot } from './workspace-contracts.js'
import { isPathInside, checkBackupFiles } from './backup-files.js'
import { verifySkillDirectory } from './skill-files.js'
import { verifyBackupSchema } from './backup-schema.js'

export const assertBackupQuiescent = (snapshot: WorkspaceSnapshot): void => {
  const terminal = new Set([
    'succeeded',
    'failed',
    'stopped',
    'cancelled',
    'interrupted',
  ])

  if (
    snapshot.runs.some(
      (run) =>
        !terminal.has(run.status) || run.processState !== 'confirmed_ended',
    ) ||
    snapshot.humanRequests.some((request) => request.status === 'pending') ||
    snapshot.skillImports.some((item) =>
      ['queued', 'fetching', 'activating'].includes(item.state),
    )
  )
    throw new Error('BACKUP_WORKSPACE_BUSY')
}

/** 备份目标不在数据目录或项目仓库内；检查实际父目录，不能靠字符串前缀判断归属。 */
export const validateBackupTarget = (input: {
  target: string
  dataDirectory: string
  snapshot: WorkspaceSnapshot
}): string => {
  const target = resolve(input.target)
  const parent = realpathSync(dirname(target))
  if (existsSync(target) || resolve(parent, basename(target)) !== target)
    throw new Error('BACKUP_TARGET_INVALID')

  const protectedPaths = [
    input.dataDirectory,
    ...input.snapshot.projects.map((project) => project.repositoryPath),
  ]

  if (
    protectedPaths.some((path) =>
      isPathInside(
        existsSync(path) ? realpathSync(path) : resolve(path),
        target,
      ),
    )
  )
    throw new Error('BACKUP_TARGET_INVALID')
  return target
}

export const readBackupManifest = (directory: string): BackupManifest => {
  const path = join(directory, 'backup.json')
  if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 8_000_000)
    throw new Error('BACKUP_INVALID')

  const parsed = backupManifestSchema.safeParse(
    JSON.parse(readFileSync(path, 'utf8')),
  )

  if (!parsed.success || parsed.data.dataSchemaVersion !== DATA_SCHEMA_VERSION)
    throw new Error('BACKUP_VERSION_INCOMPATIBLE')
  return parsed.data
}

export const inspectBackup = (
  directory: string,
): {
  manifest: BackupManifest
  snapshot: WorkspaceSnapshot
} => {
  const manifest = readBackupManifest(directory)
  checkBackupFiles(directory, manifest)
  if (!manifest.files.some((file) => file.path === 'kernel.sqlite'))
    throw new Error('BACKUP_INVALID')

  const database = new DatabaseSync(join(directory, 'kernel.sqlite'), {
    readOnly: true,
    allowExtension: false,
  })

  try {
    database.exec('PRAGMA trusted_schema=OFF')
    verifyBackupSchema(database)
    if (
      database.prepare('PRAGMA user_version').get()?.user_version !==
        DATA_SCHEMA_VERSION ||
      database.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok' ||
      database.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('BACKUP_INVALID')
    const snapshot = new WorkspaceStore(database).snapshot()
    assertBackupQuiescent(snapshot)
    verifyBackupSkills(directory, snapshot)
    return { manifest, snapshot }
  } finally {
    database.close()
  }
}

export const verifyBackupSkills = (
  directory: string,
  snapshot: WorkspaceSnapshot,
): void => {
  for (const skill of snapshot.skills)
    verifySkillDirectory(join(directory, 'skills/versions', skill.id), skill)
  for (const item of snapshot.skillImports) {
    if (item.state === 'preview_ready' && item.package)
      verifySkillDirectory(
        join(directory, 'skills/staging', item.id),
        item.package,
      )
  }
}
