import { z } from 'zod'
import { businessCommandSchema } from './business-contracts.js'
import { preflightInputSchema } from './preflight-contracts.js'
import { cliCheckInputSchema } from './cli-check-contracts.js'
import { projectInspectionInputSchema } from './project-inspection-contracts.js'
export * from './project-inspection-contracts.js'
export * from './cli-check-contracts.js'
export * from './preflight-contracts.js'
export * from './business-contracts.js'
export * from './activity-contracts.js'
export * from './product-contracts.js'
export * from './role-contracts.js'
export * from './workspace-contracts.js'
export * from './credential-contracts.js'
export * from './human-contracts.js'
export * from './feishu-contracts.js'
export * from './skill-contracts.js'
export * from './backup-contracts.js'
export * from './diagnostic-contracts.js'

export const PROTOCOL_VERSION = 1 as const
export const KERNEL_VERSION = '0.9.4'
export const DATA_SCHEMA_VERSION = 8

const requestBase = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().uuid(),
}

/** 私有连接也必须校验输入；业务操作使用版本化命令，不接受任意 shell 或文件访问。 */
export const requestSchema = z.discriminatedUnion('method', [
  z.object({ ...requestBase, method: z.literal('kernel.handshake') }).strict(),
  z.object({ ...requestBase, method: z.literal('kernel.health') }).strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.project.inspect'),
      input: projectInspectionInputSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('kernel.cliCheck'),
      input: cliCheckInputSchema,
    })
    .strict(),
  z
    .object({ ...requestBase, method: z.literal('kernel.diagnostics') })
    .strict(),
  z.object({ ...requestBase, method: z.literal('feishu.connect') }).strict(),
  z.object({ ...requestBase, method: z.literal('feishu.disconnect') }).strict(),
  z.object({ ...requestBase, method: z.literal('feishu.status') }).strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.backup'),
      backupId: z.string().uuid(),
      targetDirectory: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.backup.inspect'),
      backupDirectory: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.restore'),
      expectedManifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      backupDirectory: z.string().min(1).max(4096),
      targetDirectory: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({ ...requestBase, method: z.literal('workspace.snapshot') })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.preflight'),
      input: preflightInputSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.command'),
      key: z.string().uuid(),
      command: businessCommandSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.delivery'),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.run'),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('workspace.activity'),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('kernel.events'),
      after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      method: z.literal('kernel.shutdown'),
      acknowledgeExit: z.literal(true).optional(),
    })
    .strict(),
])

/** 仅供嵌入式宿主确认已收到停机结果；不能触发或替代业务停机。 */
export const shutdownAcknowledgementSchema = z
  .object({
    kind: z.literal('shutdown-ack'),
    ...requestBase,
  })
  .strict()

export const eventSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    eventId: z.string().uuid(),
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    type: z.enum(['kernel.started', 'kernel.stopped']),
  })
  .strict()

export const handshakeSchema = z
  .object({
    kernelVersion: z.literal(KERNEL_VERSION),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    dataSchemaVersion: z.literal(DATA_SCHEMA_VERSION),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    capabilities: z.array(
      z.enum([
        'health',
        'persistent-events',
        'graceful-shutdown',
        'local-workflow',
        'product-catalog',
        'role-trials',
        'role-configuration',
        'role-copy',
        'task-preflight',
        'team-workflow',
        'codex-and-claude',
        'human-workflow',
        'feishu-channel',
        'skills',
        'workspace-backup',
        'environment-diagnostics',
        'cli-checks',
        'project-inspection',
      ]),
    ),
    unavailable: z.array(z.string()),
    runtime: z
      .object({ node: z.string(), platform: z.string(), arch: z.string() })
      .strict(),
  })
  .strict()

export const responseSchema = z.discriminatedUnion('status', [
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      requestId: z.string().uuid(),
      status: z.enum(['completed', 'accepted']),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      requestId: z.string().uuid().nullable(),
      status: z.literal('rejected'),
      error: z
        .object({
          code: z.string().regex(/^[A-Z_]+$/),
          message: z.string(),
          retryable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
])

export type KernelRequest = z.infer<typeof requestSchema>
export type KernelResponse = z.infer<typeof responseSchema>
export type KernelEvent = z.infer<typeof eventSchema>
export type KernelHandshake = z.infer<typeof handshakeSchema>
