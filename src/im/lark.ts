/**
 * 飞书接入：WS 长连接收消息 + REST 回消息。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { parseMentions, type Mention } from "./message-parser.js";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: string; // 'p2p' 单聊 | 'group' 群聊
  messageType: string; // 'text' | 'image' | 'post' | ...
  text: string; // text 消息的正文（其他类型为空串）
  rootId: string;
  threadId: string;
  senderOpenId: string;
  mentions: Mention[];
  rawContent: string;
}

export interface BotOptions {
  appId: string;
  appSecret: string;
  onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>;
}

export interface Bot {
  client: Lark.Client;
  reply: (
    messageId: string,
    text: string,
    replyInThread?: boolean,
  ) => Promise<string | undefined>;
  downloadResource: (
    messageId: string,
    fileKey: string,
    type: "image" | "file",
    saveDir: string,
    fileName?: string,
  ) => Promise<string>;
}
// extractText 把飞书的富文本（post）或纯文本（text）消息正文剥成纯文本。
const extractText = (messageType: string, content: string): string => {
  const parsed = JSON.parse(content);
  if (messageType === "text") {
    return parsed.text ?? "";
  }
  if (messageType === "post") {
    const paragraphs: any[][] = parsed.content ?? [];
    return paragraphs
      .flat()
      .filter((el) => el.tag === "text")
      .map((el) => el.text)
      .join("")
      .trim();
  }
  return "";
};
// content_type 与扩展名映射
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/x-icon": "ico",
};
// 获取响应头
function getHeader(headers: any, name: string): string {
  const value =
    typeof headers?.get === "function"
      ? headers.get(name)
      : (headers?.[name] ?? headers?.[name.toLowerCase()]);
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
// 根据飞书消息类型和下载 res 获取扩展名
function resourceExtension(
  type: "image" | "file",
  fileName: string | undefined,
  contentType: string,
): string {
  const original = fileName ? extname(fileName).slice(1).toLowerCase() : "";
  if (/^[a-z0-9]{1,10}$/.test(original)) return original;

  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === "image" ? "img" : "bin");
}

export const startBot = (opts: BotOptions): Bot => {
  const { appId, appSecret, onMessage } = opts;
  // Lark.Client 管出。所有主动调 API 的动作——发消息、回消息、以后的传图片、改卡片都走它。
  const client = new Lark.Client({ appId, appSecret });

  const bot: Bot = {
    client,
    async reply(messageId, text, replyInThread = false) {
      const res = await client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text }),
          ...(replyInThread ? { reply_in_thread: true } : {}),
        },
      });
      return res.data?.message_id;
    },
    async downloadResource(messageId, fileKey, type, saveDir, fileName) {
      const res = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      const contentType = getHeader(res.headers, "content-type");
      const extension = resourceExtension(type, fileName, contentType);
      const savePath = join(saveDir, `${fileKey}.${extension}`);
      await mkdir(saveDir, { recursive: true });
      await res.writeFile(savePath);
      return savePath;
    },
  };

  // EventDispatcher 管分发。长连接上下来的事件五花八门，dispatcher 按事件名路由到对应的处理函数。
  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const m = data.message;
      // content 字段是「JSON 字符串」，套在事件 JSON 里面
      const msg: IncomingMessage = {
        messageId: m.message_id,
        chatId: m.chat_id,
        chatType: m.chat_type,
        messageType: m.message_type,
        text: extractText(m.message_type, m.content),
        rootId: m.root_id ?? "",
        threadId: m.thread_id ?? "",
        senderOpenId: data.sender.sender_id?.open_id ?? "",
        mentions: parseMentions(m.mentions),
        rawContent: m.content,
      };
      await onMessage(msg, bot);
    },
  });
  // Lark.WSClient 管进。它负责建立并维持那条 WebSocket 长连接，断了自动重连。
  const wsClient = new Lark.WSClient({ appId, appSecret });
  wsClient.start({ eventDispatcher: dispatcher });

  return bot;
};
