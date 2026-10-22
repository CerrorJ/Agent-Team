import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import type { AxiosAdapter, AxiosRequestConfig } from 'axios'
import * as Lark from '@larksuiteoapi/node-sdk'
import { createFeishuHttp } from '../src/kernel/feishu-http.js'

const logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
}

test('实际SDK HTTP契约：token与消息正文解包、保留headers特例，隔离超时/重定向设置', async () => {
  const calls: string[] = []

  const adapter: AxiosAdapter = async (config) => {
    calls.push(config.url!)
    assert.equal(config.maxRedirects, 0)
    const tokenRequest = config.url!.includes('tenant_access_token')
    if (!tokenRequest && !config.url!.includes('headers-probe'))
      assert.equal(config.headers.Authorization, 'Bearer synthetic-token')

    const data = tokenRequest
      ? { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 }
      : { code: 0, data: { message_id: 'om_synthetic' } }

    return {
      data,
      config,
      status: 200,
      statusText: 'OK',
      headers: { 'x-test-header': 'preserved' },
    }
  }

  const httpInstance = createFeishuHttp({ adapter })
  assert.equal(httpInstance.defaults.timeout, 15000)

  const client = new Lark.Client({
    appId: 'cli_sdk_contract',
    appSecret: 'synthetic-secret',
    httpInstance,
    logger,
  })

  const message = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: 'oc_synthetic',
      msg_type: 'interactive',
      content: '{}',
    },
  })

  assert.equal(message.code, 0)
  assert.equal(message.data?.message_id, 'om_synthetic')
  assert.equal(
    (
      await client.im.v1.message.patch({
        path: { message_id: 'om_synthetic' },
        data: { content: '{}' },
      })
    ).code,
    0,
  )

  const headers: unknown = await httpInstance.request({
    url: 'https://contract.invalid/headers-probe',
    $return_headers: true,
  } as AxiosRequestConfig & { $return_headers: true })

  assert.equal(
    (headers as { headers: Record<string, string> }).headers['x-test-header'],
    'preserved',
  )
  assert.equal((headers as { data: { code: number } }).data.code, 0)
  assert.equal(
    calls.filter((url) => url.includes('tenant_access_token')).length,
    1,
  )
})

test(
  '实际SDK长连接配置契约：端点正文解包后尝试本地TCP，无真实租户或外部网络',
  { timeout: 8000 },
  async () => {
    let accepted = false

    const server = createServer((socket) => {
      accepted = true
      socket.destroy()
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    let endpointRequests = 0

    const adapter: AxiosAdapter = async (config) => {
      endpointRequests++
      return {
        config,
        status: 200,
        statusText: 'OK',
        headers: {},
        data: {
          code: 0,
          data: {
            URL: `ws://127.0.0.1:${address.port}/?device_id=synthetic&service_id=1`,
            ClientConfig: {
              ReconnectCount: 0,
              ReconnectInterval: 1,
              ReconnectNonce: 0,
              PingInterval: 30,
            },
          },
        },
      }
    }

    let failed!: () => void

    const failure = new Promise<void>((resolve) => {
      failed = resolve
    })

    const ws = new Lark.WSClient({
      appId: 'cli_0123456789abcdef',
      appSecret: 'synthetic-secret',
      httpInstance: createFeishuHttp({ adapter }),
      logger,
      autoReconnect: false,
      handshakeTimeoutMs: 2000,
      onError: () => failed(),
    })

    try {
      await ws.start({ eventDispatcher: new Lark.EventDispatcher({ logger }) })
      // SDK start只安排后台连接；必须等真实本地套接字失败回调，不能把start返回当作建立连接。
      await Promise.race([
        failure,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error('本地SDK连接探针未完成')),
            4000,
          ).unref()
        }),
      ])
      assert.equal(endpointRequests, 1)
      assert.equal(accepted, true)
      assert.equal(ws.getConnectionStatus().state, 'failed')
    } finally {
      ws.close({ force: true })
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  },
)
