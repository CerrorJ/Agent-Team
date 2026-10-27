import { z } from 'zod'
import {
  projectSettingsFields,
  projectConfigureCommandSchema,
  projectContextSnapshotSchema,
} from './project-contracts.js'
import { configurationFingerprintSchema } from './preflight-fingerprint.js'
import { teamCommandSchemas } from './team-contracts.js'
import {
  cliIdSchema,
  modelProfileSchema,
  requirementVersionSchema,
  requirementRefSchema,
  teamVersionSchema,
} from './product-contracts.js'
import { productCommandSchemas } from './product-command-contracts.js'
import {
  roleCommandSchemas,
  roleTrialSchema,
  roleConfigurationFields,
} from './role-contracts.js'
import { humanCommandSchemas } from './human-contracts.js'
import { feishuCommandSchema } from './feishu-contracts.js'
import { skillCommandSchemas, skillReferenceSchema } from './skill-contracts.js'

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
    ...projectSettingsFields,
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
    ...roleConfigurationFields,
    cli: cliIdSchema,
    modelProfileSnapshot: modelProfileSchema.nullable().optional(),
    model: z.string().trim().max(200),
    permission: z.enum(['read-only', 'workspace-write']),
    skills: z.array(skillReferenceSchema).max(12),
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
    requirementRef: requirementRefSchema.nullable().optional(),
    purpose: z.enum(['task', 'role_trial', 'team_parent']).optional(),
    parentTaskId: id.nullable().optional(),
    dependencyTaskIds: z.array(id).max(12).optional(),
    teamSnapshot: teamVersionSchema.nullable().optional(),
    status: z.enum(['ready', 'in_progress', 'in_review', 'done']),
    createdAt: z.string().datetime(),
  })
  .strict()

export const runStatusSchema = z.enum([
  'queued',
  'preparing',
  'running',
  'waiting_input',
  'waiting_approval',
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
    waitingReason: z
      .enum([
        'uncertain_project',
        'dependency_acceptance',
        'project_busy',
        'role_busy',
        'capacity',
      ])
      .optional(),
    inputDeliveryIds: z.array(id).max(144).optional(),
    inputTree: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    requirementSnapshot: requirementVersionSchema.nullable().optional(),
    projectContextSnapshot: projectContextSnapshotSchema.optional(),
    purpose: z.enum(['task', 'role_trial']).optional(),
    trial: roleTrialSchema.nullable().optional(),
    executionBranch: z.string(),
    workDirectory: z.string(),
    createdAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    endedAt: z.string().datetime().nullable(),
    failureCode: z.string().nullable(),
    pendingHumanRequestId: id.nullable().optional(),
    continuation: z
      .object({
        requestId: id,
        sessionId: z.string().min(1).max(200),
        prompt: z.string().min(1).max(40_000),
      })
      .strict()
      .nullable()
      .optional(),
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
    contributionDiff: z.string().max(500_000).optional(),
    inputDeliveryIds: z.array(id).max(144).optional(),
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
  ...humanCommandSchemas,
  ...teamCommandSchemas,
  projectConfigureCommandSchema,
  z
    .object({
      type: z.literal('project.create'),
      name: shortText,
      repositoryPath: z.string().min(1).max(4096),
      defaultBranch: shortText,
      ...projectSettingsFields,
    })
    .strict(),
  z
    .object({
      type: z.literal('role.save'),
      id: id.optional(),
      expectedVersion: z.number().int().nonnegative(),
      name: shortText,
      responsibility: longText,
      ...roleConfigurationFields,
      cli: cliIdSchema,
      modelProfileId: id.nullable().optional(),
      modelProfileRef: requirementRefSchema.nullable().optional(),
      model: z.string().trim().max(200),
      permission: z.enum(['read-only', 'workspace-write']),
      skills: z.array(skillReferenceSchema).max(12).optional(),
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
      requirementRef: requirementRefSchema.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('run.start'),
      taskId: id,
      expectedVersion: version,
      expectedConfigurationFingerprint:
        configurationFingerprintSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('run.retry'),
      runId: id,
      expectedVersion: version,
      expectedConfigurationFingerprint:
        configurationFingerprintSchema.optional(),
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
  ...productCommandSchemas,
  ...roleCommandSchemas,
  feishuCommandSchema,
  ...skillCommandSchemas,
])

export type Project = z.infer<typeof projectSchema>
export type RoleVersion = z.infer<typeof roleVersionSchema>
export type Task = z.infer<typeof taskSchema>
export type Run = z.infer<typeof runSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type Delivery = z.infer<typeof deliverySchema>
export type Acceptance = z.infer<typeof acceptanceSchema>
export type BusinessCommand = z.infer<typeof businessCommandSchema>
