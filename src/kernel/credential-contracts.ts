import { z } from 'zod'

/** 凭据必须绑定提供方和规范化地址，不能凭一个旧引用将密钥发送给新地址。 */
export const normalizeProviderUrl = (input: string): string => {
  const url = new URL(input)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('MODEL_CONFIG_INVALID')
  return url.href
}

export const credentialBindingSchema = z
  .object({
    reference: z.string().regex(/^model-[a-f0-9-]{36}$/),
    provider: z.enum(['openai-compatible', 'anthropic-compatible']),
    baseUrl: z
      .string()
      .max(2048)
      .transform((value, context) => {
        try {
          return normalizeProviderUrl(value)
        } catch {
          context.addIssue({ code: 'custom', message: 'MODEL_CONFIG_INVALID' })
          return z.NEVER
        }
      }),
  })
  .strict()
export const credentialRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    kind: z.literal('host.credential.request'),
    id: z.string().uuid(),
    binding: credentialBindingSchema,
  })
  .strict()
export const credentialResponseSchema = z
  .object({
    protocolVersion: z.literal(1),
    kind: z.literal('host.credential.result'),
    id: z.string().uuid(),
    value: z.string().min(1).max(16384).nullable(),
  })
  .strict()
export type CredentialBinding = z.infer<typeof credentialBindingSchema>
export type CredentialResolver = (binding: CredentialBinding) => Promise<string>
