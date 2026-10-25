import {
  mkdirSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  statSync,
  existsSync,
  realpathSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { WorkspaceStore } from './workspace-store.js'
import type { WorkspaceSnapshot } from './workspace-contracts.js'
import { KERNEL_VERSION, DATA_SCHEMA_VERSION } from './protocol.js'
import {
  backupManifestSchema,
  type BackupManifest,
} from './backup-contracts.js'
import {
  backupFileDigest,
  enumerateBackupFiles,
  backupFilePath,
  checkBackupFiles,
  copyBackupFiles,
  isPathInside,
  backupManifestDigest,
} from './backup-files.js'
import {
  assertBackupQuiescent,
  validateBackupTarget,
  inspectBackup,
  verifyBackupSkills,
} from './backup-validation.js'
import { skillStoragePath } from './skill-staging.js'

/** 本函数同步执行，无await；单内核事件循环在一致快照和文件复制期间不能启动新命令/调度。 */
export const createWorkspaceBackup = (input: {
  store: WorkspaceStore
  dataDirectory: string
  targetDirectory: string
  sourceCommit: string
  backupId: string
}): BackupManifest => {
  const id = z.string().uuid().parse(input.backupId)
  if (existsSync(input.targetDirectory)) {
    const completed = inspectBackup(input.targetDirectory).manifest
    if (completed.id !== id) throw new Error('BACKUP_TARGET_INVALID')
    return completed
  }
  const snapshot = input.store.snapshot()
  assertBackupQuiescent(snapshot)

  const target = validateBackupTarget({
    target: input.targetDirectory,
    dataDirectory: input.dataDirectory,
    snapshot,
  })

  const staged = join(dirname(target), `.${basename(target)}.pending-${id}`)
  mkdirSync(staged, { mode: 0o700 })
  input.store.database
    .prepare('VACUUM INTO ?')
    .run(join(staged, 'kernel.sqlite'))

  copyWorkspaceSkills({
    snapshot,
    dataDirectory: input.dataDirectory,
    targetDirectory: staged,
  })
  verifyBackupSkills(staged, snapshot)

  const manifest = buildBackupManifest({
    staged,
    id,
    sourceCommit: input.sourceCommit,
  })

  writeFileSync(
    join(staged, 'backup.json'),
    JSON.stringify(manifest, null, 2),
    { flag: 'wx', mode: 0o600, flush: true },
  )
  checkBackupFiles(staged, manifest)
  renameSync(staged, target)
  return manifest
}

const copyResource = (input: {
  source: string
  target: string
  prefix: string
}): void => {
  for (const local of enumerateBackupFiles(input.source)) {
    const target = backupFilePath(input.target, `${input.prefix}/${local}`)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    copyFileSync(join(input.source, ...local.split('/')), target)
  }
}

interface RestoreBackupInput {
  store: WorkspaceStore
  dataDirectory: string
  backupDirectory: string
  targetDirectory: string
  expectedManifestDigest?: string
}

/** 恢复只写新目录，旧目录和项目不动；宿主确认旧内核退出后再原子切换位置指针。 */
export const restoreWorkspaceBackup = (
  input: RestoreBackupInput,
): {
  id: string
  projects: number
  tasks: number
  credentialsIncluded: false
} => {
  const current = input.store.snapshot()
  assertBackupQuiescent(current)
  const { manifest, snapshot } = inspectBackup(input.backupDirectory)
  if (
    input.expectedManifestDigest &&
    backupManifestDigest(manifest) !== input.expectedManifestDigest
  )
    throw new Error('BACKUP_PREVIEW_STALE')

  const target = validateBackupTarget({
    target: input.targetDirectory,
    dataDirectory: input.dataDirectory,
    snapshot: current,
  })

  // 清单/链接检查先完成，再冻结物理源根；短名或父目录别名不能绕过源备份保护。
  const sourceRoot = realpathSync.native(input.backupDirectory)
  if (isPathInside(sourceRoot, target)) throw new Error('BACKUP_TARGET_INVALID')

  const staged = join(
    dirname(target),
    `.${basename(target)}.restore-${randomUUID()}`,
  )

  mkdirSync(staged, { mode: 0o700 })
  copyBackupFiles({
    source: sourceRoot,
    target: staged,
    files: manifest.files,
  })
  // 复制后再次核对，避免校验与复制之间源文件变化被当作可靠恢复。
  writeFileSync(join(staged, 'backup.json'), JSON.stringify(manifest), {
    flag: 'wx',
    mode: 0o600,
    flush: true,
  })
  inspectBackup(staged)
  renameSync(staged, target)
  return {
    id: manifest.id,
    projects: snapshot.projects.length,
    tasks: snapshot.tasks.length,
    credentialsIncluded: false,
  }
}

const copyWorkspaceSkills = (input: {
  snapshot: WorkspaceSnapshot
  dataDirectory: string
  targetDirectory: string
}): void => {
  const { snapshot } = input

  const resources = [
    ...snapshot.skills.map((skill) => ({
      id: skill.id,
      area: 'versions' as const,
    })),
    ...snapshot.skillImports
      .filter((item) => item.state === 'preview_ready')
      .map((item) => ({ id: item.id, area: 'staging' as const })),
  ]

  for (const resource of resources) {
    const root = skillStoragePath(
      input.dataDirectory,
      resource.id,
      resource.area,
    )

    copyResource({
      source: root,
      target: input.targetDirectory,
      prefix: `skills/${resource.area}/${resource.id}`,
    })
  }
}

const buildBackupManifest = ({
  staged,
  id,
  sourceCommit,
}: {
  staged: string
  id: string
  sourceCommit: string
}): BackupManifest => {
  return backupManifestSchema.parse({
    format: 'weftpilot-workspace-backup',
    formatVersion: 1,
    id,
    kernelVersion: KERNEL_VERSION,
    protocolVersion: 1,
    dataSchemaVersion: DATA_SCHEMA_VERSION,
    sourceCommit: sourceCommit,
    scope: 'business-data-and-skills',
    createdAt: new Date().toISOString(),
    files: enumerateBackupFiles(staged).map((path) => ({
      path,
      size: statSync(backupFilePath(staged, path)).size,
      sha256: backupFileDigest(backupFilePath(staged, path)),
    })),
  })
}
