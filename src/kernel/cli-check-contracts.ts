import { z } from 'zod'

/** 仅允许内置的只读命令；渠道不能提交命令参数、环境变量、路径或登录凭据。 */
export const cliCheckInputSchema = z
  .object({
    cli: z.enum(['codex', 'claude']),
    check: z.enum(['version', 'sign-in']),
  })
  .strict()

export const cliCheckResultSchema = z
  .object({
    ...cliCheckInputSchema.shape,
    checkedAt: z.string().datetime(),
    state: z.enum([
      'passed',
      'attention',
      'failed',
      'unavailable',
      'uncertain',
    ]),
    code: z.enum([
      'CLI_VERSION_READ',
      'CLI_SIGNED_IN',
      'CLI_SIGNED_OUT',
      'CLI_UNAVAILABLE',
      'CLI_CHECK_FAILED',
      'CLI_CHECK_OUTPUT_INVALID',
      'CLI_CHECK_OUTPUT_LIMIT',
      'CLI_CHECK_TIMEOUT',
      'CLI_CHECK_STOP_UNCERTAIN',
    ]),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/)
      .max(64)
      .optional(),
    processState: z.enum(['confirmed_ended', 'uncertain']),
    accountScope: z.literal('cli-default-account'),
    modelConnection: z.literal('unverified'),
  })
  .strict()

export type CliCheckInput = z.infer<typeof cliCheckInputSchema>
export type CliCheckResult = z.infer<typeof cliCheckResultSchema>
