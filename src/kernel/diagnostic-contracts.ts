import { z } from 'zod'

export const diagnosticCheckSchema = z
  .object({
    id: z.string().min(1).max(100),
    state: z.enum(['passed', 'attention', 'failed', 'unchecked']),
    code: z.string().regex(/^[A-Z_]+$/),
    count: z.number().int().nonnegative().optional(),
    objectId: z.string().uuid().optional(),
  })
  .strict()

/** 可导出的最小诊断投影，不包含路径、业务正文、环境变量或凭据。 */
export const environmentDiagnosticsSchema = z
  .object({
    formatVersion: z.literal(1),
    checkedAt: z.string().datetime(),
    checks: z.array(diagnosticCheckSchema).max(150),
    authentication: z.literal('unchecked'),
    tools: z
      .array(
        z
          .object({
            id: z.enum(['git', 'codex', 'claude']),
            found: z.boolean(),
            version: z.literal('unchecked'),
          })
          .strict(),
      )
      .length(3),
  })
  .strict()

export type DiagnosticCheck = z.infer<typeof diagnosticCheckSchema>
export type EnvironmentDiagnostics = z.infer<
  typeof environmentDiagnosticsSchema
>
