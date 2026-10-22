import * as Lark from '@larksuiteoapi/node-sdk'
import { createFeishuHttp } from './feishu-http.js'
import { z } from 'zod'
import type { FeishuBinding } from './feishu-contracts.js'

export interface FeishuTransport {
  start(): Promise<void>
  close(): void
  state():
    'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
  send(input: {
    chatId: string
    content: string
    uuid: string
  }): Promise<string>
  update(input: { messageId: string; content: string }): Promise<void>
}
export type FeishuTransportFactory = (options: {
  binding: FeishuBinding
  secret: string
  onAction: (raw: unknown) => unknown
}) => FeishuTransport

/** 独立于旧飞书入口的新渠道；使用 SDK 认证长连接，禁止接收公开的未认证回调。 */
export const createFeishuTransport: FeishuTransportFactory = (options) => {
  // SDK 异常可能包含请求头或 secret；不将其日志直接发送到桌面/运行日志。
  const logger = silentLogger

  const parameters = {
    appId: options.binding.appId,
    appSecret: options.secret,
    logger,
    httpInstance: createFeishuHttp(),
  }

  const client = new Lark.Client(parameters)

  const dispatcher = new Lark.EventDispatcher({ logger }).register({
    'card.action.trigger': (raw: unknown) => options.onAction(raw),
  })

  const ws = new Lark.WSClient({
    ...parameters,
    handshakeTimeoutMs: 15_000,
    wsConfig: { pingTimeout: 15 },
  })

  return {
    start: () => ws.start({ eventDispatcher: dispatcher }),
    close: () => ws.close({ force: true }),
    state: () => {
      const state = ws.getConnectionStatus().state
      return state === 'idle' ? 'disconnected' : state
    },
    send: async (input) => {
      const result = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: input.chatId,
          content: input.content,
          msg_type: 'interactive',
          uuid: input.uuid,
        },
      })

      return messageId(result)
    },
    update: async (input) => {
      const result = await client.im.v1.message.patch({
        path: { message_id: input.messageId },
        data: { content: input.content },
      })

      if (result.code !== 0) throw new Error('FEISHU_NETWORK_FAILED')
    },
  }
}

const messageId = (response: unknown): string => {
  const parsed = z
    .object({
      code: z.literal(0),
      data: z.object({ message_id: z.string().min(1).max(200) }),
    })
    .safeParse(response)

  if (!parsed.success) throw new Error('FEISHU_NETWORK_FAILED')
  return parsed.data.data.message_id
}

const silentLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
}
