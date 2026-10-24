import {
  cliCheckInputSchema,
  type CliCheckInput,
  type CliCheckResult,
} from './cli-check-contracts.js'
import { cliCheckResult } from './cli-check-result.js'
import { startCliProbe, type CliProbeSession } from './cli-check-process.js'

type ProbeStart = (
  input: CliCheckInput,
  options: { cwd: string; onEnded: () => void },
) => CliProbeSession
interface Entry {
  session?: CliProbeSession
  result?: Promise<CliCheckResult>
}

/** 检查不写业务对象或就绪证明；同CLI只持有一个探针，未知进程阻止重复启动。 */
export class CliInspection {
  private readonly entries = new Map<CliCheckInput['cli'], Entry>()
  private closing = false

  constructor(private readonly options: { cwd: string; start?: ProbeStart }) {}

  inspect(raw: CliCheckInput): Promise<CliCheckResult> {
    const input = cliCheckInputSchema.parse(raw)
    if (this.closing) throw new Error('KERNEL_STOPPED')
    if (this.entries.has(input.cli)) throw new Error('CLI_CHECK_BUSY')
    const entry: Entry = {}
    this.entries.set(input.cli, entry)

    const session = (this.options.start ?? startCliProbe)(input, {
      cwd: this.options.cwd,
      onEnded: () => {
        if (this.entries.get(input.cli) === entry)
          this.entries.delete(input.cli)
      },
    })

    entry.session = session
    entry.result = session.result.then((outcome) =>
      cliCheckResult(input, outcome),
    )
    return entry.result
  }

  /** 探针也必须确认退出后才允许kernel.stopped；停止不确定不发成功ACK。 */
  async shutdown(): Promise<void> {
    this.closing = true

    const sessions = [...this.entries.values()].flatMap((entry) =>
      entry.session ? [entry.session] : [],
    )

    const confirmed = await Promise.all(
      sessions.map((session) => session.stop()),
    )

    if (confirmed.some((value) => !value)) throw new Error('STATE_UNCERTAIN')
  }
}
