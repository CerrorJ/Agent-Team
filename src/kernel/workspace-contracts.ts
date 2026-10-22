import { z } from 'zod'
import {
  acceptanceSchema,
  deliverySchema,
  projectSchema,
  roleVersionSchema,
  runSchema,
  taskSchema,
} from './business-contracts.js'
import {
  modelProfileSchema,
  requirementVersionSchema,
  teamVersionSchema,
} from './product-contracts.js'
import { roleReadinessSchema } from './role-contracts.js'
import { activitySchema } from './activity-contracts.js'
import { humanRequestSchema } from './human-contracts.js'
import { feishuBindingSchema } from './feishu-contracts.js'

export const workspaceSnapshotSchema = z
  .object({
    cursor: z.number().int().nonnegative(),
    projects: z.array(projectSchema),
    roles: z.array(roleVersionSchema),
    tasks: z.array(taskSchema),
    runs: z.array(runSchema),
    deliveries: z.array(deliverySchema),
    acceptances: z.array(acceptanceSchema),
    models: z.array(modelProfileSchema).default([]),
    requirements: z.array(requirementVersionSchema).default([]),
    teams: z.array(teamVersionSchema).default([]),
    roleReadiness: z.array(roleReadinessSchema).default([]),
    humanRequests: z.array(humanRequestSchema).default([]),
    feishuBinding: feishuBindingSchema.nullable().default(null),
    logs: z.array(activitySchema),
  })
  .strict()

export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>
