import { randomUUID } from 'node:crypto'
import type { CliId } from '../cli/types.js'
import type { SessionStore } from './session-store.js'

export interface Session {
  // Agent Team 自己的会话 ID，通过 Node.js 的 randomUUID() 生成
  id: string
  // 负责找到飞书话题
  threadId: string
  // 划定群聊范围
  chatId: string
  // 记录以后交给哪个执行引擎，比如 Claude Code 或者 Codex
  cliId: CliId
  // 执行引擎自己的会话 ID，首轮执行后补录
  cliSessionId?: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
}

export interface SessionManagerOptions {
  now?: () => Date
  createId?: () => string
  store?: SessionStore
}

// 创建，运行时，上一轮结束，会话结束
export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed'

export interface MessageAddress {
  messageId: string
  chatId: string
  threadId: string
  rootId: string
}

export interface ResolvedSession {
  session: Session
  isNew: boolean
}

// 状态流转约束
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  creating: ['active', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: [],
}

const topicIdOf = (message: MessageAddress): string => {
  return message.threadId || message.rootId || message.messageId
}

const sessionKey = (chatId: string, threadId: string): string => {
  return `${chatId}:${threadId}`
}

export class SessionManager {
  // Map 的键是飞书话题地址，值是完整 Session
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly store?: SessionStore

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    this.store = options.store
  }

  get size(): number {
    return this.sessions.size
  }

  get(sessionId: string): Session | undefined {
    return [...this.sessions.values()].find(
      (session) => session.id === sessionId,
    )
  }

  // 静态方法：从持久化存储恢复 SessionManager
  // 只加载非 closed 状态的会话，没有在进程重启时被杀掉
  static async open(
    options: SessionManagerOptions = {},
  ): Promise<SessionManager> {
    const manager = new SessionManager(options)
    const restored = (await options.store?.load()) ?? []
    for (const session of restored) {
      manager.sessions.set(
        sessionKey(session.chatId, session.threadId),
        session,
      )
    }
    return manager
  }

  // 每次收到消息都会先查一次：查到就返回原会话，查不到才创建。
  async resolve(message: MessageAddress): Promise<ResolvedSession> {
    const threadId = topicIdOf(message)
    const key = sessionKey(message.chatId, threadId)
    const existing = this.sessions.get(key)
    if (existing) return { session: existing, isNew: false }

    const now = this.now().toISOString()
    const session: Session = {
      id: this.createId(),
      threadId,
      chatId: message.chatId,
      cliId: 'claude',
      status: 'creating',
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(key, session)
    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      throw error
    }
    return { session, isNew: true }
  }

  // 不原地修改旧对象,生成一份带新状态和新时间的记录，再放回 Map
  async transition(
    sessionId: string,
    nextStatus: SessionStatus,
  ): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
      throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`)
    }

    const updated: Session = {
      ...current,
      status: nextStatus,
      updatedAt: this.now().toISOString(),
    }
    const key = sessionKey(updated.chatId, updated.threadId)
    this.sessions.set(key, updated)
    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw error
    }
    return updated
  }

  // 将 Claude CLI 创建出的会话 ID 补录到 Session 记录里,
  // 保存失败时回滚内存状态，避免磁盘没有 cliSessionId、内存却以为已经保存
  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空')

    const updated: Session = {
      ...current,
      cliSessionId,
      updatedAt: this.now().toISOString(),
    }
    const key = sessionKey(updated.chatId, updated.threadId)
    this.sessions.set(key, updated)
    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw error
    }
    return updated
  }

  // 先写磁盘临时文件，再重命名(原子性)，避免写一半数据导致重复启动时报错
  private async persist(): Promise<void> {
    await this.store?.save([...this.sessions.values()])
  }
}
