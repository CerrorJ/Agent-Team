import { z } from 'zod'

/** 乐观配置校验值，不是审批凭证、身份凭证或执行槽位预留。 */
export const configurationFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/)
