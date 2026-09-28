import { randomUUID } from 'node:crypto'
import type { CliId } from '../cli/types.js'
import type { SessionStore } from './session-store.js'
import { formatLocalDateTime } from './local-time.js'

export interface Session {
  // Agent Team 自己的会话 ID，通过 Node.js 的 randomUUID() 生成
  id: string
  botId: string
  // 负责找到飞书话题
  threadId: string
  // 划定群聊范围
  chatId: string
  // 记录以后交给哪个执行引擎，比如 Claude Code 或者 Codex
  cliId: CliId
  // 执行引擎自己的会话 ID，首轮执行后补录
  cliSessionId?: string
  workspaceDir: string
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
  creating: ['active', 'idle', 'closed'],
  active: ['idle', 'closed'],
  idle: ['active', 'closed'],
  closed: [],
}

const topicIdOf = (message: MessageAddress): string => {
  return message.threadId || message.rootId || message.messageId
}

const sessionKey = (
  botId: string,
  chatId: string,
  threadId: string,
): string => {
  return `${botId}:${chatId}:${threadId}`
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

  list(): Session[] {
    return [...this.sessions.values()]
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
        sessionKey(session.botId, session.chatId, session.threadId),
        session,
      )
    }
    return manager
  }

  // 每次收到消息都会先查一次：查到就返回原会话，查不到才创建。
  // cliId 只影响新会话；已有会话沿用创建时选定的执行引擎。
  async resolve(
    message: MessageAddress,
    cliId: CliId = 'claude',
    botId = 'default',
    workspaceDir = process.cwd(),
  ): Promise<ResolvedSession> {
    const threadId = topicIdOf(message)
    const key = sessionKey(botId, message.chatId, threadId)
    const existing = this.sessions.get(key)
    if (existing) return { session: existing, isNew: false }

    const now = formatLocalDateTime(this.now())

    const session: Session = {
      id: this.createId(),
      botId,
      threadId,
      chatId: message.chatId,
      cliId,
      workspaceDir,
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
      updatedAt: formatLocalDateTime(this.now()),
    }

    const key = sessionKey(updated.botId, updated.chatId, updated.threadId)
    this.sessions.set(key, updated)
    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) this.sessions.set(key, current)
      throw error
    }
    return updated
  }

  //负责切换当前话题，并在目录变化时清除旧的 cliSessionId
  async setWorkspaceDir(
    sessionId: string,
    workspaceDir: string,
  ): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (current.status === 'active') {
      throw new Error('当前任务仍在执行，结束后再切换工作目录')
    }
    if (!workspaceDir) throw new Error('工作目录不能为空')
    if (current.workspaceDir === workspaceDir) return current

    const { cliSessionId: _previousCliSessionId, ...rest } = current

    const updated: Session = {
      ...rest,
      workspaceDir,
      updatedAt: formatLocalDateTime(this.now()),
    }

    const key = sessionKey(updated.botId, updated.chatId, updated.threadId)
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
  // 用于任务完成和恢复按钮，
  async setCliSessionId(
    sessionId: string,
    cliSessionId: string,
  ): Promise<Session> {
    if (!cliSessionId) throw new Error('CLI 会话 ID 不能为空')
    return this.updateCliSelection(sessionId, cliSessionId)
  }
  //clearCliSessionId() 用于 /new
  async clearCliSessionId(sessionId: string): Promise<Session> {
    return this.updateCliSelection(sessionId, undefined)
  }

  // 校验并原子占用会话（转为 active），用于 /compact 校验通过后立即锁定会话，避免与 /newall 并发时被重置
  async occupyForCompact(sessionId: string): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)
    if (current.status === 'active') {
      throw new Error('当前任务结束后才能整理上下文。')
    }
    if (current.status === 'closed') {
      throw new Error('当前话题的会话已经关闭。')
    }
    if (!current.cliSessionId) {
      throw new Error(
        '当前还没有可整理的 CLI 会话。先完成一次任务，再使用 /compact。',
      )
    }
    return this.transition(sessionId, 'active')
  }

  // clearTopicIdleCliSessions() 用于 /newall，清空指定话题中所有处于空闲状态会话的 cliSessionId
  async clearTopicIdleCliSessions(options: {
    chatId: string
    threadId: string
  }): Promise<Session[]> {
    const { chatId, threadId } = options

    const targetSessions = [...this.sessions.values()].filter(
      (s) =>
        s.chatId === chatId && s.threadId === threadId && s.status === 'idle',
    )

    if (targetSessions.length === 0) return []

    const now = formatLocalDateTime(this.now())

    const updates = new Map<
      string,
      {
        previous: Session
        previousCliSessionId: string | undefined
        updated: Session
      }
    >()

    const updatedSessions: Session[] = []

    for (const current of targetSessions) {
      const key = sessionKey(current.botId, current.chatId, current.threadId)
      const previousCliSessionId = current.cliSessionId

      // 同时就地清空旧对象引用上的 cliSessionId，防止并发任务持有旧引用时继续使用旧 CLI 会话
      current.cliSessionId = undefined

      const updated: Session = {
        ...current,
        cliSessionId: undefined,
        updatedAt: now,
      }

      updates.set(key, { previous: current, previousCliSessionId, updated })
      this.sessions.set(key, updated)
      updatedSessions.push(updated)
    }

    try {
      await this.persist()
    } catch (error) {
      for (const [
        key,
        { previous, previousCliSessionId, updated },
      ] of updates.entries()) {
        if (this.sessions.get(key) === updated) {
          previous.cliSessionId = previousCliSessionId
          this.sessions.set(key, previous)
        }
      }
      throw error
    }

    return updatedSessions
  }

  private async updateCliSelection(
    sessionId: string,
    cliSessionId: string | undefined,
  ): Promise<Session> {
    const current = this.get(sessionId)
    if (!current) throw new Error(`会话不存在: ${sessionId}`)

    const previousCliSessionId = current.cliSessionId

    const updated: Session = {
      ...current,
      cliSessionId,
      updatedAt: formatLocalDateTime(this.now()),
    }

    const key = sessionKey(updated.botId, updated.chatId, updated.threadId)
    this.sessions.set(key, updated)
    current.cliSessionId = cliSessionId

    try {
      await this.persist()
    } catch (error) {
      if (this.sessions.get(key) === updated) {
        current.cliSessionId = previousCliSessionId
        this.sessions.set(key, current)
      }
      throw error
    }
    return updated
  }

  // 先写磁盘临时文件，再重命名(原子性)，避免写一半数据导致重复启动时报错
  private async persist(): Promise<void> {
    await this.store?.save([...this.sessions.values()])
  }
}
