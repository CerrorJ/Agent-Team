import type { CliCheckInput, CliCheckResult } from './cli-check-contracts.js'
import { cliCheckResultSchema } from './cli-check-contracts.js'

export interface CliProbeOutcome {
  exitCode: number | null
  output: string
  failure?: 'unavailable' | 'failed' | 'timeout' | 'output-limit'
  confirmedEnded: boolean
}

/** 原始CLI输出可能含邮箱、账户和路径，只返回严格提取的版本或默认账户状态。 */
export const cliCheckResult = (
  input: CliCheckInput,
  outcome: CliProbeOutcome,
): CliCheckResult =>
  cliCheckResultSchema.parse({
    ...input,
    checkedAt: new Date().toISOString(),
    processState: outcome.confirmedEnded ? 'confirmed_ended' : 'uncertain',
    accountScope: 'cli-default-account',
    modelConnection: 'unverified',
    ...classify(input, outcome),
  })

const classify = (input: CliCheckInput, outcome: CliProbeOutcome) => {
  if (!outcome.confirmedEnded)
    return { state: 'uncertain', code: 'CLI_CHECK_STOP_UNCERTAIN' }
  if (outcome.failure) return failureResult(outcome.failure)
  if (input.check === 'version') return readVersion(input.cli, outcome)
  else {
    const signedIn = readSignIn(input.cli, outcome)
    if (signedIn !== undefined)
      return signedIn
        ? { state: 'passed', code: 'CLI_SIGNED_IN' }
        : { state: 'attention', code: 'CLI_SIGNED_OUT' }
  }
  return { state: 'failed', code: 'CLI_CHECK_OUTPUT_INVALID' }
}

const readSignIn = (cli: CliCheckInput['cli'], outcome: CliProbeOutcome) => {
  if (cli === 'codex') return readCodexSignIn(outcome)
  return readClaudeSignIn(outcome)
}

const readVersion = (cli: CliCheckInput['cli'], outcome: CliProbeOutcome) => {
  const expression =
    cli === 'codex'
      ? /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/
      : /^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?) \(Claude Code\)\s*$/

  const version = outcome.output.trim().match(expression)?.[1]
  if (outcome.exitCode === 0 && version && version.length <= 64)
    return { state: 'passed', code: 'CLI_VERSION_READ', version }
  return { state: 'failed', code: 'CLI_CHECK_OUTPUT_INVALID' }
}

const readCodexSignIn = (outcome: CliProbeOutcome) => {
  if (
    outcome.exitCode === 0 &&
    /^Logged in using [^\r\n]+\s*$/i.test(outcome.output.trim())
  )
    return true
  if (
    outcome.exitCode === 1 &&
    /^Not logged in\s*$/i.test(outcome.output.trim())
  )
    return false
  return undefined
}

const readClaudeSignIn = (outcome: CliProbeOutcome) => {
  try {
    const value: unknown = JSON.parse(outcome.output)
    if (!value || typeof value !== 'object' || !('loggedIn' in value))
      return undefined
    if (value.loggedIn === true && outcome.exitCode === 0) return true
    if (value.loggedIn === false && outcome.exitCode === 1) return false
  } catch {
    /* 未知格式和旧CLI不能被退出码冒充为认证成功。 */
  }
  return undefined
}

const failureResult = (failure: NonNullable<CliProbeOutcome['failure']>) => {
  const codes = {
    unavailable: 'CLI_UNAVAILABLE',
    failed: 'CLI_CHECK_FAILED',
    timeout: 'CLI_CHECK_TIMEOUT',
    'output-limit': 'CLI_CHECK_OUTPUT_LIMIT',
  }

  return {
    state: failure === 'unavailable' ? 'unavailable' : 'failed',
    code: codes[failure],
  }
}
