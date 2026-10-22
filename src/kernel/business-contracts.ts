import { z } from 'zod'

const id = z.string().uuid()
const shortText = z.string().trim().min(1).max(200)
const longText = z.string().trim().min(1).max(20_000)
const version = z.number().int().positive()

export const projectSchema = z
  .object({
    id,
    version,
    name: shortText,
    repositoryPath: z.string().min(1).max(4096),
    gitUrl: z.string().max(4096),
    defaultBranch: shortText,
    createdAt: z.string().datetime(),
  })
  .strict()

export const roleVersionSchema = z
  .object({
    id,
    version,
    name: shortText,
    responsibility: longText,
    cli: z.literal('codex'),
    model: z.string().trim().max(200),
    permission: z.enum(['read-only', 'workspace-write']),
    skills: z.array(z.never()),
    createdAt: z.string().datetime(),
  })
  .strict()

export const taskSchema = z
  .object({
    id,
    version,
    projectId: id,
    roleId: id,
    title: shortText,
    goal: longText,
    acceptanceCriteria: longText,
    status: z.enum(['ready', 'in_progress', 'in_review', 'done']),
    createdAt: z.string().datetime(),
  })
  .strict()

export const runStatusSchema = z.enum([
  'queued',
  'preparing',
  'running',
  'stopping',
  'stopped',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
])

export const runSchema = z
  .object({
    id,
    version,
    taskId: id,
    projectId: id,
    attempt: version,
    retryOfRunId: id.nullable(),
    status: runStatusSchema,
    roleSnapshot: roleVersionSchema,
    baselineCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    acceptanceSnapshot: longText,
    goalSnapshot: longText,
    feedbackSnapshot: z.string().max(20_000).default(''),
    executionBranch: z.string(),
    workDirectory: z.string(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
    failureCode: z.string().nullable(),
    processState: z.enum([
      'not_started',
      'active',
      'confirmed_ended',
      'uncertain',
    ]),
  })
  .strict()

export const deliverySchema = z
  .object({
    id,
    version,
    runId: id,
    taskId: id,
    answer: z.string().max(200_000),
    diff: z.string().max(500_000),
    headCommit: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict()

export const acceptanceSchema = z
  .object({
    id,
    deliveryId: id,
    taskId: id,
    decision: z.enum(['accepted', 'returned']),
    reason: z.string().max(20_000),
    actor: z.literal('local-owner'),
    createdAt: z.string().datetime(),
  })
  .strict()

export const businessCommandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('project.create'),
      name: shortText,
      repositoryPath: z.string().min(1).max(4096),
      defaultBranch: shortText,
    })
    .strict(),
  z
    .object({
      type: z.literal('role.save'),
      id: id.optional(),
      expectedVersion: z.number().int().nonnegative(),
      name: shortText,
      responsibility: longText,
      cli: z.literal('codex'),
      model: z.string().trim().max(200),
      permission: z.enum(['read-only', 'workspace-write']),
    })
    .strict(),
  z
    .object({
      type: z.literal('task.create'),
      projectId: id,
      roleId: id,
      title: shortText,
      goal: longText,
      acceptanceCriteria: longText,
    })
    .strict(),
  z
    .object({
      type: z.literal('run.start'),
      taskId: id,
      expectedVersion: version,
    })
    .strict(),
  z
    .object({
      type: z.literal('run.retry'),
      runId: id,
      expectedVersion: version,
    })
    .strict(),
  z
    .object({
      type: z.literal('run.stop'),
      runId: id,
      expectedVersion: version,
    })
    .strict(),
  z
    .object({
      type: z.literal('delivery.accept'),
      deliveryId: id,
      expectedTaskVersion: version,
      decision: z.enum(['accepted', 'returned']),
      reason: z.string().trim().max(20_000),
    })
    .strict(),
])

export const workspaceSnapshotSchema = z
  .object({
    cursor: z.number().int().nonnegative(),
    projects: z.array(projectSchema),
    roles: z.array(roleVersionSchema),
    tasks: z.array(taskSchema),
    runs: z.array(runSchema),
    deliveries: z.array(deliverySchema),
    acceptances: z.array(acceptanceSchema),
    logs: z.array(
      z
        .object({
          runId: id,
          label: z.string(),
          occurredAt: z.string().datetime(),
          sequence: z.number().int(),
        })
        .strict(),
    ),
  })
  .strict()

export type Project = z.infer<typeof projectSchema>
export type RoleVersion = z.infer<typeof roleVersionSchema>
export type Task = z.infer<typeof taskSchema>
export type Run = z.infer<typeof runSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type Delivery = z.infer<typeof deliverySchema>
export type Acceptance = z.infer<typeof acceptanceSchema>
export type BusinessCommand = z.infer<typeof businessCommandSchema>
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>
