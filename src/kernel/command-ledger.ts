import { createHash } from 'node:crypto'
import type { WorkspaceStore } from './workspace-store.js'
import type { BusinessCommand } from './business-contracts.js'

/** 在同一事务内校验幂等键；键相同但正文不同必须拒绝，不能静默复用。 */
export class CommandLedger {
  constructor(private readonly store: WorkspaceStore) {}

  execute<T>(
    input: { key: string; command: BusinessCommand },
    operation: () => T,
  ): T {
    const digest = createHash('sha256')
      .update(JSON.stringify(input.command))
      .digest('hex')

    return this.store.transaction(() => {
      const receipt = this.store.database
        .prepare(
          'SELECT request_digest,response FROM command_receipts WHERE idempotency_key=?',
        )
        .get(input.key)

      if (receipt) {
        if (receipt.request_digest !== digest)
          throw new Error('IDEMPOTENCY_CONFLICT: 同一命令键的内容不同')
        return JSON.parse(String(receipt.response)) as T
      }
      const response = operation()
      this.store.database
        .prepare(
          'INSERT INTO command_receipts(idempotency_key,request_digest,response) VALUES(?,?,?)',
        )
        .run(input.key, digest, JSON.stringify(response))
      return response
    })
  }
}
