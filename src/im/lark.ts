/**
 * 飞书接入：WS 长连接收消息 + REST 回消息。
 */
import * as Lark from '@larksuiteoapi/node-sdk'
import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { parseMentions, type Mention } from './message-parser.js'
import type { CardJson } from './card.js'

export interface IncomingMessage {
  messageId: string
  chatId: string
  chatType: string // 'p2p' 单聊 | 'group' 群聊
  messageType: string // 'text' | 'image' | 'post' | ...
  text: string // text 消息的正文（其他类型为空串）
  rootId: string
  threadId: string
  senderType: string
  senderOpenId: string
  senderUnionId: string
  mentions: Mention[]
  rawContent: string
}

export interface BotIdentity {
  openId: string
  name: string
}

export interface BotOptions {
  appId: string
  appSecret: string
  onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>
  onCardAction?: (action: CardAction) => Promise<CardActionResponse | undefined>
}

export interface CardAction {
  operatorOpenId: string
  operatorUnionId: string
  messageId: string
  value: Record<string, unknown>
  formValue: Record<string, unknown>
}

export interface CardActionResponse {
  toast?: { type: 'success' | 'info' | 'warning' | 'error'; content: string }
  card?: { type: 'raw'; data: CardJson }
}
// 从卡片回调数据里取出操作者、消息 id 和按钮携带的 value
export const parseCardAction = (data: any): CardAction => {
  const value = data?.action?.value
  const formValue = data?.action?.form_value
  return {
    operatorOpenId: data?.operator?.open_id ?? data?.operator_id?.open_id ?? '',
    operatorUnionId:
      data?.operator?.union_id ?? data?.operator_id?.union_id ?? '',
    messageId: data?.context?.open_message_id ?? data?.open_message_id ?? '',
    value: isRecord(value) ? value : {},
    formValue: isRecord(formValue) ? formValue : {},
  }
}

export interface Bot {
  client: Lark.Client
  getIdentity: () => Promise<BotIdentity>
  reply: (
    messageId: string,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>
  replyCard: (
    messageId: string,
    card: CardJson,
    replyInThread?: boolean,
  ) => Promise<string | undefined>
  replyMention: (
    messageId: string,
    target: BotIdentity,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>
  updateCard: (messageId: string, card: CardJson) => Promise<void>
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    saveDir: string,
    fileName?: string,
  ) => Promise<string>
}
// 富文本构造和
export const buildMentionPostContent = (
  target: BotIdentity,
  text: string,
): Record<string, unknown> => {
  return {
    zh_cn: {
      title: '',
      content: [
        [
          {
            tag: 'at',
            user_id: target.openId,
            ...(target.name ? { user_name: target.name } : {}),
          },
          { tag: 'text', text: ` ${text}` },
        ],
      ],
    },
  }
}

// 身份查询
const fetchBotIdentity = async (client: Lark.Client): Promise<BotIdentity> => {
  const response = await client.request({
    url: '/open-apis/bot/v3/info',
    method: 'GET',
  })

  const bot = (response as { bot?: { open_id?: string; app_name?: string } })
    .bot

  if (!bot?.open_id) throw new Error('飞书没有返回 bot open_id')
  return { openId: bot.open_id, name: bot.app_name?.trim() || 'Bot' }
}

// content_type 与扩展名映射
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
}

// 获取响应头
const getHeader = (headers: any, name: string): string => {
  const value =
    typeof headers?.get === 'function'
      ? headers.get(name)
      : (headers?.[name] ?? headers?.[name.toLowerCase()])

  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

// 根据飞书消息类型和下载 res 获取扩展名
const resourceExtension = (
  type: 'image' | 'file',
  fileName: string | undefined,
  contentType: string,
): string => {
  const original = fileName ? extname(fileName).slice(1).toLowerCase() : ''
  if (/^[a-z0-9]{1,10}$/.test(original)) return original

  const mime = contentType.split(';', 1)[0].trim().toLowerCase()
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === 'image' ? 'img' : 'bin')
}

interface PostElement {
  tag?: string
  text?: string
  user_id?: string
}

//日志或代码粘成飞书代码块,在 post 富文本中，标签是 code_block
const renderPostElement = (element: PostElement): string => {
  if (element.tag === 'at') return element.user_id ?? ''
  if (element.tag === 'br') return '\n'
  if (['text', 'a', 'code', 'code_block', 'md'].includes(element.tag ?? '')) {
    return element.text ?? ''
  }
  return ''
}

// extractText 把飞书的富文本（post）或纯文本（text）消息正文剥成纯文本。
export const extractMessageText = (
  messageType: string,
  content: string,
): string => {
  const parsed = JSON.parse(content)
  if (messageType === 'text') {
    return parsed.text ?? ''
  }
  if (messageType === 'post') {
    const paragraphs: PostElement[][] = parsed.content ?? []
    return paragraphs
      .map((paragraph) => paragraph.map(renderPostElement).join(''))
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

// Lark.Client 管出。所有主动调 API 的动作——发消息、回消息、以后的传图片、改卡片都走它。
export const startBot = (opts: BotOptions): Bot => {
  const { appId, appSecret, onMessage, onCardAction } = opts

  const client = new Lark.Client({ appId, appSecret })

  const bot: Bot = {
    client,
    getIdentity() {
      return fetchBotIdentity(client)
    },
    async reply(messageId, text, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      })

      return res.data?.message_id
    },

    async replyCard(messageId, card, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      })

      return res.data?.message_id
    },
    // 继续回复在原话题里。目标 bot 会收到真实通知，用户也能看见任务从谁交给了谁。
    async replyMention(messageId, target, text, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'post',
          content: JSON.stringify(buildMentionPostContent(target, text)),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      })

      return res.data?.message_id
    },
    async updateCard(messageId, card) {
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
    },

    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      })

      const contentType = getHeader(res.headers, 'content-type')
      const extension = resourceExtension(type, fileName, contentType)
      const savePath = join(saveDir, `${fileKey}.${extension}`)
      await mkdir(saveDir, { recursive: true })
      await res.writeFile(savePath)
      return savePath
    },
  }

  // Lark.EventDispatcher 管分发。长连接上下来的事件五花八门，dispatcher 按事件名路由到对应的处理函数。
  const dispatcher = new Lark.EventDispatcher({}).register({
    'card.action.trigger': async (data: any) => {
      if (!onCardAction) return undefined
      return onCardAction(parseCardAction(data))
    },
    'im.message.receive_v1': async (data) => {
      const m = data.message

      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractMessageText(m.message_type, m.content),
        rootId: m.root_id ?? '',
        threadId: m.thread_id ?? '',
        senderType: data.sender.sender_type ?? '',
        senderOpenId: data.sender.sender_id?.open_id ?? '',
        senderUnionId: data.sender.sender_id?.union_id ?? '',
        mentions: parseMentions(m.mentions),
        rawContent: m.content,
      }

      await onMessage(msg, bot)
    },
  })

  // Lark.WSClient 管进。它负责建立并维持那条 WebSocket 长连接，断了自动重连。
  const wsClient = new Lark.WSClient({ appId, appSecret })
  wsClient.start({ eventDispatcher: dispatcher })

  return bot
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
