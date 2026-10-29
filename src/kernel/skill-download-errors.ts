type DownloadCode =
  | 'SKILL_DOWNLOAD_FAILED'
  | 'SKILL_DOWNLOAD_NETWORK_FAILED'
  | 'SKILL_DOWNLOAD_TIMEOUT'
  | 'SKILL_DOWNLOAD_DNS_FAILED'
  | 'SKILL_DOWNLOAD_TLS_FAILED'
  | 'SKILL_DOWNLOAD_RATE_LIMITED'
  | 'SKILL_DOWNLOAD_FORBIDDEN'
  | 'SKILL_DOWNLOAD_NOT_FOUND'
  | 'SKILL_DOWNLOAD_SERVER_UNAVAILABLE'
  | 'SKILL_DOWNLOAD_HTTP_FAILED'
  | 'SKILL_SIZE_LIMIT'

/** 只透传内核自己产生的有限错误码，不把服务器正文、URL或原始cause写入事件。 */
export class SkillDownloadFailure extends Error {
  constructor(code: DownloadCode) {
    super(code)
    this.name = 'SkillDownloadFailure'
  }
}

export const skillHttpFailure = (response: Response): SkillDownloadFailure => {
  if (
    response.status === 429 ||
    (response.status === 403 &&
      response.headers.get('x-ratelimit-remaining') === '0')
  )
    return new SkillDownloadFailure('SKILL_DOWNLOAD_RATE_LIMITED')
  if (response.status === 403)
    return new SkillDownloadFailure('SKILL_DOWNLOAD_FORBIDDEN')
  if (response.status === 404)
    return new SkillDownloadFailure('SKILL_DOWNLOAD_NOT_FOUND')
  if (response.status >= 500)
    return new SkillDownloadFailure('SKILL_DOWNLOAD_SERVER_UNAVAILABLE')
  return new SkillDownloadFailure('SKILL_DOWNLOAD_HTTP_FAILED')
}

const transportCodes = new Map<string, DownloadCode>([
  ['UND_ERR_CONNECT_TIMEOUT', 'SKILL_DOWNLOAD_TIMEOUT'],
  ['ETIMEDOUT', 'SKILL_DOWNLOAD_TIMEOUT'],
  ['ENOTFOUND', 'SKILL_DOWNLOAD_DNS_FAILED'],
  ['EAI_AGAIN', 'SKILL_DOWNLOAD_DNS_FAILED'],
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SKILL_DOWNLOAD_TLS_FAILED'],
  ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SKILL_DOWNLOAD_TLS_FAILED'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'SKILL_DOWNLOAD_TLS_FAILED'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SKILL_DOWNLOAD_TLS_FAILED'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'SKILL_DOWNLOAD_TLS_FAILED'],
  ['CERT_HAS_EXPIRED', 'SKILL_DOWNLOAD_TLS_FAILED'],
])

export const skillTransportFailure = (error: unknown): SkillDownloadFailure => {
  if (error instanceof SkillDownloadFailure) return error
  if (error instanceof Error && error.name === 'TimeoutError')
    return new SkillDownloadFailure('SKILL_DOWNLOAD_TIMEOUT')
  const cause = error instanceof Error ? error.cause : undefined

  const code =
    transportCodes.get(errorCode(error)) ??
    transportCodes.get(errorCode(cause)) ??
    'SKILL_DOWNLOAD_NETWORK_FAILED'

  return new SkillDownloadFailure(code)
}

const errorCode = (error: unknown): string => {
  if (!error || typeof error !== 'object' || !('code' in error)) return ''
  return typeof error.code === 'string' ? error.code : ''
}
