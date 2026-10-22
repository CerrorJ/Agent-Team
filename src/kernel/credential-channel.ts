import { randomUUID } from 'node:crypto'
import {
  credentialBindingSchema,
  credentialResponseSchema,
  type CredentialResolver,
} from './credential-contracts.js'

/** 仅供内核和可信宿主使用的短期通道；没有读取凭据的渲染进程接口。 */
export class CredentialChannel {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: string) => void
      reject: () => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(private readonly send: (value: unknown) => void) {}

  readonly resolve: CredentialResolver = async (binding) => {
    const validated = credentialBindingSchema.parse(binding)
    if (this.pending.size >= 8) throw new Error('MODEL_CREDENTIAL_REQUIRED')
    const id = randomUUID()
    return new Promise<string>((resolve, reject) => {
      const fail = () => reject(new Error('MODEL_CREDENTIAL_REQUIRED'))

      const timer = setTimeout(() => {
        this.pending.delete(id)
        fail()
      }, 10_000)

      this.pending.set(id, { resolve, reject: fail, timer })
      try {
        this.send({
          protocolVersion: 1,
          kind: 'host.credential.request',
          id,
          binding: validated,
        })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        fail()
      }
    })
  }

  receive(input: unknown): boolean {
    const parsed = credentialResponseSchema.safeParse(input)
    if (!parsed.success)
      return (
        typeof input === 'object' &&
        input !== null &&
        'kind' in input &&
        input.kind === 'host.credential.result'
      )
    const pending = this.pending.get(parsed.data.id)
    if (!pending) return true
    this.pending.delete(parsed.data.id)
    clearTimeout(pending.timer)
    if (parsed.data.value) pending.resolve(parsed.data.value)
    else pending.reject()
    return true
  }
}
