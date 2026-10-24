import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { localKernelFixture } from './helpers/local-kernel-fixture.js'
import { cliCheckResultSchema } from '../src/kernel/cli-check-contracts.js'

test('真实内核检查缺失CLI明确不可用，严格拒绝额外字段，业务和幂等账本全部不写', async () => {
  const fixture = await localKernelFixture(async () => {
    throw new Error('MODEL_MUST_NOT_RUN')
  })

  const beforeEnvironment = { ...process.env }

  const database = new DatabaseSync(
    join(fixture.directory, 'data/kernel.sqlite'),
  )

  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[]

  const rows = () =>
    tables.map(({ name }) =>
      database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    )

  try {
    const before = rows()
    for (const key of Object.keys(process.env))
      if (key.toUpperCase() === 'PATH') delete process.env[key]
    process.env.PATH = join(fixture.directory, 'missing-tools')

    const request = {
      protocolVersion: 1,
      requestId: randomUUID(),
      method: 'kernel.cliCheck',
      input: { cli: 'codex', check: 'version' },
    }

    const response = await fixture.kernel.dispatch(request)
    assert.equal(response.status, 'completed')
    const report = cliCheckResultSchema.parse(response.result)
    assert.equal(report.state, 'unavailable')
    assert.equal(report.processState, 'confirmed_ended')
    assert.equal(report.modelConnection, 'unverified')
    assert.deepEqual(rows(), before)
    assert.equal(
      (
        await fixture.kernel.dispatch({
          ...request,
          input: { ...request.input, command: 'whoami' },
        })
      ).status,
      'rejected',
    )
    assert.equal(
      (await fixture.kernel.dispatch({ ...request, env: {} })).status,
      'rejected',
    )
    assert.deepEqual(rows(), before)
    assert.ok(fixture.kernel.handshake.capabilities.includes('cli-checks'))
  } finally {
    process.env = beforeEnvironment
    database.close()
    await fixture.cleanup()
  }
})
