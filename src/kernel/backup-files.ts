import { createHash } from 'node:crypto'
import {
  closeSync,
  openSync,
  readSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs'
import { resolve, relative, dirname, sep, isAbsolute } from 'node:path'
import { z } from 'zod'
import { validateSkillPath } from './skill-paths.js'
import {
  backupManifestSchema,
  type BackupManifest,
} from './backup-contracts.js'

export const backupManifestDigest = (manifest: BackupManifest): string =>
  createHash('sha256')
    .update(JSON.stringify(backupManifestSchema.parse(manifest)))
    .digest('hex')

export const backupFilePath = (root: string, path: string): string => {
  if (path === 'kernel.sqlite') return resolve(root, path)
  const [skills, area, id, ...rest] = path.split('/')
  if (
    skills !== 'skills' ||
    !['versions', 'staging'].includes(area ?? '') ||
    !z.string().uuid().safeParse(id).success
  )
    throw new Error('BACKUP_INVALID')
  validateSkillPath(rest.join('/'))
  return resolve(root, ...path.split('/'))
}

/** 不把整文件载入内存；SQLite和技能资源都限制在清单大小上限内。 */
export const backupFileDigest = (path: string): string => {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
    throw new Error('BACKUP_INVALID')
  const descriptor = openSync(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(64 * 1024)
  try {
    let count = readSync(descriptor, buffer)
    while (count > 0) {
      hash.update(buffer.subarray(0, count))
      count = readSync(descriptor, buffer)
    }
    return hash.digest('hex')
  } finally {
    closeSync(descriptor)
  }
}

/** VACUUM INTO产物必须是独立快照；拒绝WAL头，避免只读SQLite预览在原备份旁创建sidecar。 */
export const assertPortableDatabase = (path: string): void => {
  const descriptor = openSync(path, 'r')
  const header = Buffer.alloc(100)
  try {
    const size = readSync(descriptor, header, 0, header.length, 0)
    // SQLite官方格式：18/19字节为读写版本，1表示独立回滚日志格式，2表示WAL。
    // https://www.sqlite.org/fileformat.html#vnums
    if (
      size !== 100 ||
      header.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0' ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw new Error('BACKUP_INVALID')
  } finally {
    closeSync(descriptor)
  }
}

export const enumerateBackupFiles = (root: string): string[] => {
  if (lstatSync(root).isSymbolicLink()) throw new Error('BACKUP_INVALID')
  const canonical = realpathSync(root)
  const result: string[] = []
  const pending = [canonical]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('BACKUP_INVALID')
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile())
        result.push(relative(canonical, path).split(sep).join('/'))
      else throw new Error('BACKUP_INVALID')
      if (result.length + pending.length > 20_001)
        throw new Error('BACKUP_SIZE_LIMIT')
    }
  }
  return result.sort()
}

export const checkBackupFiles = (
  root: string,
  manifest: BackupManifest,
): void => {
  const actual = enumerateBackupFiles(root).filter(
    (path) => path !== 'backup.json',
  )

  const expected = manifest.files.map((file) => file.path).sort()
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    new Set(expected.map((path) => path.toLowerCase())).size !== expected.length
  )
    throw new Error('BACKUP_INVALID')
  if (
    manifest.files.reduce((size, file) => size + file.size, 0) > 2_000_000_000
  )
    throw new Error('BACKUP_SIZE_LIMIT')
  for (const file of manifest.files) {
    const path = backupFilePath(root, file.path)
    if (
      statSync(path).size !== file.size ||
      backupFileDigest(path) !== file.sha256
    )
      throw new Error('BACKUP_DIGEST_MISMATCH')
  }
}

export const copyBackupFiles = (input: {
  source: string
  target: string
  files: BackupManifest['files']
}): void => {
  for (const file of input.files) {
    const path = backupFilePath(input.target, file.path)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    copyFileSync(backupFilePath(input.source, file.path), path)
  }
}

export const isPathInside = (parent: string, child: string): boolean => {
  const local = relative(resolve(parent), resolve(child))
  return !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`)
}
