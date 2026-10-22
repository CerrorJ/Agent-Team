import { z } from 'zod'

export const backupFileSchema = z
  .object({
    path: z.string().min(1).max(1024),
    size: z.number().int().nonnegative().max(1_000_000_000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

/** 数据备份不携带系统密钥、CLI登录、项目仓库或执行目录；恢复不会重放历史执行。 */
export const backupManifestSchema = z
  .object({
    format: z.literal('weftpilot-workspace-backup'),
    formatVersion: z.literal(1),
    id: z.string().uuid(),
    kernelVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    protocolVersion: z.literal(1),
    dataSchemaVersion: z.number().int().positive(),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    createdAt: z.string().datetime(),
    scope: z.literal('business-data-and-skills'),
    files: z.array(backupFileSchema).min(1).max(20_000),
  })
  .strict()
export type BackupManifest = z.infer<typeof backupManifestSchema>
