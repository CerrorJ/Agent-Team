/**
 * 飞书任务卡片：把 CLI 事件整理成稳定、低噪音的任务进度。
 */
import type { CliRunStats, CliSessionSummary } from '../cli/types.js'
import type { ClarificationFlow } from '../core/clarification.js'
import type { ProductSpecFlow } from '../core/product-spec.js'
import type {
  TaskActivity,
  TaskProgressSnapshot,
} from '../core/task-progress.js'
export interface ClarificationCardOptions {
  flow: ClarificationFlow
}
export interface TeamCardMember {
  id: string
  displayName: string
  role: string
  cliName: string
  skills: string[]
  isLeader: boolean
  ready: boolean
}

export interface TeamCardOptions {
  members: TeamCardMember[]
}

export interface ResumeCardOptions {
  agentSessionId: string
  cliName: string
  currentCliSessionId?: string
  sessions: CliSessionSummary[]
}

export interface SessionNoticeCardOptions {
  title: string
  detail: string
  template?: 'blue' | 'green' | 'grey'
}
export interface CollaborationCardOptions {
  senderName: string
  targetName: string
  workspaceName: string
  prompt: string
  round: number
  maxRounds: number
}
export type CardJson = Record<string, unknown>
export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled'

export interface TaskCardOptions {
  title: string
  status: TaskStatus
  detail: string
  progress?: TaskProgressSnapshot
  answer?: string
  stats?: CliRunStats
  technicalDetail?: string

  abortSessionId?: string
}

const STATUS_STYLE = {
  running: { template: 'blue', label: '执行中' },
  success: { template: 'green', label: '已完成' },
  failed: { template: 'red', label: '执行失败' },
  cancelled: { template: 'grey', label: '已取消' },
} as const

const COMPACT_ANSWER_LENGTH = 900
const MAX_CARD_ANSWER_LENGTH = 6_000
const RUNNING_ACTIVITY_LIMIT = 3
const FINISHED_ACTIVITY_LIMIT = 8

// 工具名 → 图标；未收录的工具回退 ⚙️
const TOOL_ICONS: Record<string, string> = {
  Agent: '🧩',
  Bash: '⌘',
  Edit: '✏️',
  Glob: '📁',
  Grep: '🔎',
  Read: '📄',
  Task: '🧩',
  TaskOutput: '⏳',
  WebFetch: '🌐',
  WebSearch: '🔍',
  Write: '📝',
}

const productDocumentList = (flow: ProductSpecFlow): string => {
  if (flow.request.deliveryMode === 'lark-doc') {
    return `☁️ **飞书云文档** · [打开文档](${flow.request.documentUrl})`
  }
  return [
    `📘 **Spec** · \`${escapeFeishuMarkdown(flow.request.specPath)}\``,
    `🎫 **Tickets** · \`${escapeFeishuMarkdown(flow.request.ticketsPath)}\``,
  ].join('\n')
}

export const buildProductSpecApprovalCard = (
  flow: ProductSpecFlow,
): CardJson => {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: [
        `**${escapeFeishuMarkdown(flow.request.title)}**`,
        escapeFeishuMarkdown(flow.request.summary),
      ].join('\n\n'),
    },
    { tag: 'hr' },
    {
      tag: 'markdown',
      content: `**共享产物**\n${productDocumentList(flow)}`,
    },
  ]

  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '确认产品方案' },
    type: 'primary_filled',
    width: 'fill',
    size: 'medium',
    behaviors: [
      {
        type: 'callback',
        value: {
          action: 'approve_product_spec',
          flowToken: flow.token,
        },
      },
    ],
  })

  elements.push({
    tag: 'markdown',
    content: '_确认后只记录“产品方案已就绪”，本节不会自动交给开发。_',
  })

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：待确认` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '产品文档已生成' },
      subtitle: {
        tag: 'plain_text',
        content:
          flow.request.deliveryMode === 'lark-doc'
            ? '飞书云文档待确认'
            : '本地 Spec · Tickets 待确认',
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements,
    },
  }
}

export const buildProductSpecApprovedCard = (
  flow: ProductSpecFlow,
): CardJson => {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已确认` },
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '产品方案已确认' },
      subtitle: { tag: 'plain_text', content: '产品阶段已就绪' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${escapeFeishuMarkdown(flow.request.title)}**`,
            escapeFeishuMarkdown(flow.request.summary),
            `**已确认文档**\n${productDocumentList(flow)}`,
            flow.approvedAt
              ? `确认时间：${escapeFeishuMarkdown(flow.approvedAt)}`
              : '',
            '_本节到这里结束，不会自动派发开发任务。_',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  }
}

export const buildProductSpecExpiredCard = (
  flow: ProductSpecFlow,
): CardJson => {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已失效` },
    },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: '产品方案确认已失效' },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            `**${escapeFeishuMarkdown(flow.request.title)}**`,
            '同一任务已经提交了更新的产品方案，请查看话题中最新的确认卡。',
          ].join('\n\n'),
        },
      ],
    },
  }
}

const formatDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1_000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (seconds === 0) return `${minutes} 分钟`
  return `${minutes} 分 ${seconds} 秒`
}

const formatCount = (value: number): string =>
  value >= 1_000 ? `${Math.round(value / 100) / 10}k` : String(value)

const escapeInlineCode = (value: string): string => value.replaceAll('`', 'ˋ')

const escapeFeishuMarkdown = (value: string): string =>
  value.replace(/<(?=\/?[A-Za-z][^>]*>)/g, '<&zwj;')

const activityLine = (activity: TaskActivity): string => {
  const icon = activity.failed ? '⚠️' : (TOOL_ICONS[activity.toolName] ?? '⚙️')

  const detail = activity.detail
    ? ` · \`${escapeInlineCode(activity.detail)}\``
    : ''

  const duration =
    activity.durationMs >= 1_000
      ? ` · ${formatDuration(activity.durationMs)}`
      : ''

  return `${icon} ${activity.label}${detail}${duration}`
}

// 截断点优先落在段落/换行边界，且不早于 55% 处，避免把内容切得太碎
const markdownSplitIndex = (text: string, maxLength: number): number => {
  if (text.length <= maxLength) return text.length
  const paragraph = text.lastIndexOf('\n\n', maxLength)
  if (paragraph >= maxLength * 0.55) return paragraph
  const line = text.lastIndexOf('\n', maxLength)
  return line >= maxLength * 0.55 ? line : maxLength
}

// 被截断的代码块补一个 ``` 收尾，防止后续内容被吞进代码块
const closeOpenFence = (markdown: string): string => {
  const fences = markdown.match(/^```/gm)?.length ?? 0
  return fences % 2 === 1 ? `${markdown}\n\n\`\`\`` : markdown
}

const markdownPreview = (text: string, maxLength: number): string =>
  closeOpenFence(text.slice(0, markdownSplitIndex(text, maxLength)).trim())

// 收起态预览：优先取第一个代码块之前的正文；太短就提示展开看全文
const compactAnswerPreview = (answer: string): string => {
  const fenceIndex = answer.search(/\n```/)
  const prose = fenceIndex > 0 ? answer.slice(0, fenceIndex) : answer

  const preview = markdownPreview(prose, COMPACT_ANSWER_LENGTH)
    .replace(/\n(?:---|#{1,6}\s+[^\n]+)\s*$/, '')
    .trim()

  return preview.length >= 40
    ? preview
    : '回答包含较多代码与细节，展开后可以查看完整内容。'
}

// 优先取 CLI 汇总的 totalTokens，缺失时把各项 token 相加
const usageTotal = (stats: CliRunStats | undefined): number | undefined => {
  if (!stats) return undefined
  if (stats.totalTokens !== undefined) return stats.totalTokens

  const values = [
    stats.inputTokens,
    stats.outputTokens,
    stats.cacheReadTokens,
    stats.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined)

  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined
}

// 上下文用量一行；用量超过窗口说明统计异常，宁可不展示
const formatContextUsage = (
  usedTokens: number | undefined,
  windowTokens: number | undefined,
): string | undefined => {
  if (usedTokens === undefined) return undefined
  if (windowTokens === undefined || windowTokens <= 0) {
    return `当前上下文约 ${formatCount(usedTokens)} tokens`
  }
  if (usedTokens > windowTokens) return undefined
  const percentage = Math.round((usedTokens / windowTokens) * 100)
  return `当前上下文 ${formatCount(usedTokens)} / ${formatCount(windowTokens)}（${percentage}%）`
}

// 本轮 token 增减；起点措辞区分「新会话基础」和「本轮开始」
const formatContextGrowth = (
  usedTokens: number | undefined,
  startTokens: number | undefined,
  startedNewSession = false,
): string | undefined => {
  if (usedTokens === undefined || startTokens === undefined) return undefined
  const delta = usedTokens - startTokens

  const change =
    delta >= 0
      ? `新增 ${formatCount(delta)}`
      : `减少 ${formatCount(Math.abs(delta))}`

  const startLabel = startedNewSession ? '新会话基础' : '本轮开始'
  return `${startLabel} ${formatCount(startTokens)} · ${change}`
}

// 执行中卡片：当前步骤 + 最近完成轨迹 + 停止任务按钮
const buildRunningElements = (
  options: TaskCardOptions,
): Record<string, unknown>[] => {
  const progress = options.progress

  const currentIcon = progress?.currentToolName
    ? `${TOOL_ICONS[progress.currentToolName] ?? '⚙️'} `
    : ''

  const currentDetail = progress?.currentDetail
    ? `\n\`${escapeInlineCode(progress.currentDetail)}\``
    : ''

  const meta = progress
    ? `${formatDuration(progress.elapsedMs)} · ${progress.toolCount} 次工具调用`
    : '刚刚开始'

  const context = formatContextUsage(
    progress?.contextUsedTokens,
    progress?.contextWindowTokens,
  )

  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  )

  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: `**${currentIcon}${progress?.current ?? options.detail}**${currentDetail}\n\n${meta}${context ? `\n_${context}_` : ''}${contextGrowth ? `\n_${contextGrowth}_` : ''}`,
    },
  ]

  if (progress?.activities.length) {
    const visible = progress.activities.slice(0, RUNNING_ACTIVITY_LIMIT)
    elements.push({
      tag: 'markdown',
      content: `**最近完成（${visible.length} / ${progress.completedCount}）**\n${visible.map(activityLine).join('\n')}`,
    })
  }
  if (options.abortSessionId) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '停止任务' },
      type: 'danger',
      width: 'default',
      size: 'medium',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'abort_task',
            sessionId: options.abortSessionId,
          },
        },
      ],
    })
  }
  return elements
}

// 收尾卡片：成功展示回答（超长则折叠预览并续发剩余），失败展示原因与错误详情
const buildFinishedElements = (
  options: TaskCardOptions,
): Record<string, unknown>[] => {
  const progress = options.progress
  const durationMs = options.stats?.durationMs ?? progress?.elapsedMs
  const totalTokens = usageTotal(options.stats)

  const context = formatContextUsage(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    options.stats?.contextWindowTokens ?? progress?.contextWindowTokens,
  )

  const contextGrowth = formatContextGrowth(
    progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
    progress?.contextStartTokens,
    progress?.startedNewSession,
  )

  const executionMeta = [
    durationMs !== undefined
      ? `**耗时** ${formatDuration(durationMs)}`
      : undefined,
    progress ? `**工具调用** ${progress.toolCount} 次` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  const usageMeta = [
    totalTokens !== undefined
      ? `**累计消耗** ${formatCount(totalTokens)} tokens`
      : undefined,
    context
      ? `**当前上下文** ${context.replace(/^当前上下文(?:约)?\s+/, '')}`
      : undefined,
    contextGrowth ? `**本轮变化** ${contextGrowth}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')

  const meta = [executionMeta, usageMeta].filter(Boolean).join('\n\n')
  const elements: Record<string, unknown>[] = []

  if (options.status === 'success') {
    const answer = options.answer || options.detail
    if (answer.length <= COMPACT_ANSWER_LENGTH) {
      elements.push({ tag: 'markdown', content: escapeFeishuMarkdown(answer) })
    } else {
      elements.push({
        tag: 'markdown',
        content: `${escapeFeishuMarkdown(compactAnswerPreview(answer))}\n\n_完整回答已收起_`,
      })
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: collapsibleHeader('查看完整回答'),
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [
          {
            tag: 'markdown',
            content: escapeFeishuMarkdown(
              markdownPreview(answer, MAX_CARD_ANSWER_LENGTH),
            ),
          },
        ],
      })
    }
    if (answerNeedsContinuation(answer)) {
      elements.push({
        tag: 'markdown',
        content: '_回答较长，剩余内容已继续发送。_',
      })
    }
  } else {
    elements.push({ tag: 'markdown', content: `**${options.detail}**` })
    if (options.technicalDetail) {
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: collapsibleHeader('查看错误详情'),
        vertical_spacing: '8px',
        padding: '8px 8px 8px 8px',
        elements: [
          {
            tag: 'markdown',
            content: `\`${escapeInlineCode(options.technicalDetail)}\``,
          },
        ],
      })
    }
  }

  if (meta || progress?.activities.length) {
    const visible = progress?.activities.slice(0, FINISHED_ACTIVITY_LIMIT) ?? []

    const activityText = visible.length
      ? `\n\n**最近执行轨迹**\n${visible.map(activityLine).join('\n')}`
      : ''

    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: collapsibleHeader('执行详情'),
      vertical_spacing: '8px',
      padding: '8px 8px 8px 8px',
      elements: [
        {
          tag: 'markdown',
          content: `${meta || options.detail}${activityText}`,
        },
      ],
    })
  }
  return elements
}

const collapsibleHeader = (content: string): Record<string, unknown> => {
  return {
    title: { tag: 'plain_text', content },
    vertical_align: 'center',
    icon: {
      tag: 'standard_icon',
      token: 'down-small-ccm_outlined',
      size: '16px 16px',
    },
    icon_position: 'right',
    icon_expanded_angle: -180,
  }
}

export const buildTaskCard = (options: TaskCardOptions): CardJson => {
  const style = STATUS_STYLE[options.status]
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${options.title}：${style.label}` },
    },
    header: {
      template: style.template,
      title: {
        tag: 'plain_text',
        content: `${options.title} · ${style.label}`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements:
        options.status === 'running'
          ? buildRunningElements(options)
          : buildFinishedElements(options),
    },
  }
}

// 澄清选项按钮：推荐项在文案后追加「（推荐）」，已含该词的不重复标
const clarificationButton = (
  flow: ClarificationFlow,
  option: { id: string; label: string },
): Record<string, unknown> => {
  const question = flow.request.questions[flow.currentIndex]

  const recommendedOptionId =
    question.recommendedOptionId ?? question.options[0]?.id

  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content:
        option.id === recommendedOptionId
          ? option.label.includes('推荐')
            ? option.label
            : `${option.label}（推荐）`
          : option.label,
    },
    type: 'default',
    width: 'fill',
    size: 'medium',
    behaviors: [
      {
        type: 'callback',
        value: {
          action: 'answer_clarification',
          flowToken: flow.token,
          questionId: question.id,
          optionId: option.id,
        },
      },
    ],
  }
}

// 已确认答案的摘要：区分「Agent 推荐」和「你的选择」两种来源
const clarificationAnswerSummary = (flow: ClarificationFlow): string => {
  return flow.answers
    .map((answer, index) =>
      [
        `${index + 1}. **${escapeFeishuMarkdown(answer.prompt)}**`,
        `${answer.source === 'agent' ? 'Agent 推荐' : '你的选择'}：${escapeFeishuMarkdown(answer.answer)}`,
      ].join('\n'),
    )
    .join('\n\n')
}

// 交给 Agent 决定的按钮：current 只作答本题，remaining 一键采纳剩余全部推荐
const clarificationDecisionButton = (
  flow: ClarificationFlow,
  decisionMode: 'current' | 'remaining',
): Record<string, unknown> => {
  const question = flow.request.questions[flow.currentIndex]
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content:
        decisionMode === 'current' ? '这一题交给 Agent 决定' : '按推荐方案继续',
    },
    type: decisionMode === 'remaining' ? 'primary' : 'default',
    width: 'fill',
    size: 'medium',
    behaviors: [
      {
        type: 'callback',
        value: {
          action: 'answer_clarification',
          flowToken: flow.token,
          questionId: question.id,
          decisionMode,
        },
      },
    ],
  }
}

// 澄清问答卡片：当前问题 + 选项按钮 + 自定义答案表单，答题进度收进卡片摘要
export const buildClarificationCard = (
  options: ClarificationCardOptions,
): CardJson => {
  const { flow } = options
  const question = flow.request.questions[flow.currentIndex]
  const current = flow.currentIndex + 1
  const total = flow.request.questions.length

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}（${current}/${total}）` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: flow.request.title },
      subtitle: { tag: 'plain_text', content: `${current} / ${total}` },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        ...(flow.request.intro && flow.currentIndex === 0
          ? [
              {
                tag: 'markdown',
                content: escapeFeishuMarkdown(flow.request.intro),
              },
            ]
          : []),
        ...(flow.answers.length
          ? [
              {
                tag: 'markdown',
                content: `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
              },
              { tag: 'hr' },
            ]
          : []),
        {
          tag: 'markdown',
          content: `**${escapeFeishuMarkdown(question.prompt)}**\n\n选择最符合预期的一项：`,
        },
        ...question.options.map((option) => clarificationButton(flow, option)),
        clarificationDecisionButton(flow, 'current'),
        { tag: 'hr' },
        {
          tag: 'form',
          name: `clarify_${flow.token.slice(0, 8)}`,
          vertical_spacing: '8px',
          elements: [
            {
              tag: 'input',
              name: 'custom_answer',
              placeholder: {
                tag: 'plain_text',
                content: '都不合适？在这里写下你的答案',
              },
              max_length: 500,
            },
            {
              tag: 'button',
              name: 'submit_custom',
              action_type: 'form_submit',
              text: { tag: 'plain_text', content: '提交自定义答案' },
              type: 'primary',
              width: 'default',
              size: 'medium',
              value: {
                action: 'answer_clarification',
                flowToken: flow.token,
                questionId: question.id,
                custom: true,
              },
            },
          ],
        },
        { tag: 'hr' },
        {
          tag: 'markdown',
          content:
            '不想逐项选择？Agent 会保留你已经确认的答案，并为剩余问题采用推荐方案。',
        },
        clarificationDecisionButton(flow, 'remaining'),
      ],
    },
  }
}

// 答案收齐后的过渡卡片：告知整理进行中，阻止用户在旧卡片上重复作答
export const buildClarificationContinuingCard = (
  flow: ClarificationFlow,
): CardJson => {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：正在整理` },
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: `${flow.request.title} · 正在整理`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            '**答案已收到**',
            '正在基于这些选择整理产品说明，无需重复点击。',
            `**已确认 ${flow.answers.length} 项**\n\n${clarificationAnswerSummary(flow)}`,
          ].join('\n\n'),
        },
      ],
    },
  }
}

// 用户在话题里发了新消息、旧澄清卡片作废时的提示卡片
export const buildClarificationSupersededCard = (
  flow: ClarificationFlow,
): CardJson => {
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${flow.request.title}：已收到新的补充` },
    },
    header: {
      template: 'grey',
      title: {
        tag: 'plain_text',
        content: `${flow.request.title} · 已更新`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: [
            '**已收到你在话题里的新消息**',
            '这张卡片已经失效，Agent Team 正在沿用同一个任务上下文处理新的补充。',
            flow.answers.length
              ? `此前已确认 ${flow.answers.length} 项，相关答案会一并带入。`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    },
  }
}

const formatSessionTime = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

// /resume 的会话选择卡片：每行一个会话（标题 + 时间 + ID 前 8 位），
// 当前绑定的会话只展示「当前会话」，其余提供「恢复」按钮（回调由 index.ts 的 resume_cli_session 处理）
export const buildResumeCard = (options: ResumeCardOptions): CardJson => {
  const elements: Record<string, unknown>[] = options.sessions.length
    ? options.sessions.flatMap((session, index) => {
        const current = session.id === options.currentCliSessionId

        const row: Record<string, unknown> = {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '12px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 4,
              elements: [
                {
                  tag: 'markdown',
                  content: `**${escapeFeishuMarkdown(session.title)}**\n_${formatSessionTime(session.updatedAt)} · ${session.id.slice(0, 8)}_`,
                },
              ],
            },
            {
              tag: 'column',
              width: 'auto',
              vertical_align: 'center',
              elements: current
                ? [{ tag: 'markdown', content: '**当前会话**' }]
                : [
                    {
                      tag: 'button',
                      text: { tag: 'plain_text', content: '恢复' },
                      type: 'primary_filled',
                      size: 'medium',
                      behaviors: [
                        {
                          type: 'callback',
                          value: {
                            action: 'resume_cli_session',
                            agentSessionId: options.agentSessionId,
                            cliSessionId: session.id,
                          },
                        },
                      ],
                    },
                  ],
            },
          ],
        }

        return index === options.sessions.length - 1
          ? [row]
          : [row, { tag: 'hr' }]
      })
    : [
        {
          tag: 'markdown',
          content:
            '当前工作目录里还没有可以恢复的 CLI 会话。先完成一次任务，再用 `/new` 开启新会话。',
        },
      ]

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: { content: `${options.cliName}：选择历史会话` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '恢复历史会话' },
      subtitle: { tag: 'plain_text', content: options.cliName },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: '选择后，当前话题会继续使用对应的 CLI 上下文。',
        },
        ...elements,
      ],
    },
  }
}

// 轻量通知卡片：/new 与 /compact 的结果反馈，不需要任务进度与工具列表
export const buildSessionNoticeCard = (
  options: SessionNoticeCardOptions,
): CardJson => {
  return {
    schema: '2.0',
    config: { summary: { content: options.title } },
    header: {
      template: options.template ?? 'blue',
      title: { tag: 'plain_text', content: options.title },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [{ tag: 'markdown', content: options.detail }],
    },
  }
}
// 协作卡片
export const buildCollaborationCard = (
  options: CollaborationCardOptions,
): CardJson => {
  // round=1 是首轮审查请求，之后每轮都是审查反馈回传；
  // 到达 maxRounds 提示这是最后一轮，处理完流程即结束
  const isReviewRequest = options.round === 1
  const isLastRound = options.round >= options.maxRounds
  const title = isReviewRequest ? '代码审查已发起' : '审查意见已返回'
  const action = isReviewRequest ? '请接手检查' : '请确认并处理反馈'

  const description = isReviewRequest
    ? '开发任务已经完成，现在进入独立审查。'
    : '审查已经完成，反馈已交回开发侧。'

  const footer = isLastRound
    ? '这是本次协作的最后一轮，处理完成后流程结束。'
    : `完成后，结果会自动交回 ${options.senderName}。`

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      summary: {
        content: `${title}：${options.senderName} → ${options.targetName}`,
      },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: title },
      subtitle: {
        tag: 'plain_text',
        content: `${options.senderName} → ${options.targetName}`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content: `**${options.targetName}，${action}**\n\n${description}`,
        },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '16px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 3,
              elements: [
                {
                  tag: 'markdown',
                  content: `**项目**\n${escapeFeishuMarkdown(options.workspaceName)}`,
                },
              ],
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 2,
              elements: [
                {
                  tag: 'markdown',
                  content: `**当前环节**\n${isReviewRequest ? '独立审查' : '处理反馈'}`,
                },
              ],
            },
          ],
        },
        {
          tag: 'collapsible_panel',
          expanded: false,
          header: collapsibleHeader(
            isReviewRequest ? '查看审查说明' : '查看审查反馈',
          ),
          vertical_spacing: '8px',
          padding: '8px 8px 8px 8px',
          elements: [
            {
              tag: 'markdown',
              content: escapeFeishuMarkdown(
                markdownPreview(options.prompt, MAX_CARD_ANSWER_LENGTH),
              ),
            },
          ],
        },
        { tag: 'hr' },
        { tag: 'markdown', content: `_${footer}_` },
      ],
    },
  }
}
// 团队卡片
export const buildTeamCard = (options: TeamCardOptions): CardJson => {
  const leader = options.members.find((member) => member.isLeader)

  const memberElements = options.members.map((member) => {
    const badges = [
      member.isLeader ? 'Team Leader' : '',
      member.ready ? '已连接' : '未连接',
    ]
      .filter(Boolean)
      .join(' · ')

    const skills =
      member.skills.length > 0
        ? member.skills.map((skill) => `$${skill}`).join('、')
        : '无'

    return {
      tag: 'markdown',
      content: [
        `**${escapeFeishuMarkdown(member.displayName)}**  _${badges}_`,
        escapeFeishuMarkdown(member.role),
        `引擎：${escapeFeishuMarkdown(member.cliName)}　Skill：${escapeFeishuMarkdown(skills)}`,
      ].join('\n'),
    }
  })

  return {
    schema: '2.0',
    config: {
      summary: { content: `Agent 团队：${options.members.length} 位成员` },
    },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: 'Agent 团队' },
      subtitle: {
        tag: 'plain_text',
        content: leader
          ? `${options.members.length} 位成员 · ${leader.displayName} 负责统筹`
          : `${options.members.length} 位成员`,
      },
    },
    body: {
      direction: 'vertical',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'markdown',
          content:
            '每位成员使用自己的飞书身份、执行引擎和项目 Skill，工作目录与会话彼此独立。',
        },
        { tag: 'hr' },
        ...memberElements,
      ],
    },
  }
}

// 超过单卡片上限的回答拆成多条消息续发
export const answerNeedsContinuation = (answer: string): boolean =>
  answer.length > MAX_CARD_ANSWER_LENGTH

export const answerContinuation = (answer: string): string =>
  answer.slice(markdownSplitIndex(answer, MAX_CARD_ANSWER_LENGTH))

export const splitLongText = (text: string, maxLength = 4_000): string[] => {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    const newline = remaining.lastIndexOf('\n', maxLength)
    const splitAt = newline > maxLength / 2 ? newline : maxLength
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

type UpdateCard = (card: CardJson) => Promise<void>

/** 一秒窗口内无论 push 多少次，只提交最新的一张卡片。 */
export class ThrottledCardUpdater {
  private pendingCard: CardJson | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private updateChain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly updateCard: UpdateCard,
    private readonly intervalMs = 1_000,
  ) {}

  push(card: CardJson): void {
    if (this.closed) return
    this.pendingCard = card
    this.schedule()
  }

  async finish(finalCard: CardJson): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pendingCard = undefined
    await this.updateChain.catch(() => undefined)
    await this.updateCard(finalCard)
  }

  async cancel(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.pendingCard = undefined
    await this.updateChain.catch(() => undefined)
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flushPending()
    }, this.intervalMs)
  }

  private flushPending(): void {
    const card = this.pendingCard
    this.pendingCard = undefined
    if (!card || this.closed) return

    this.updateChain = this.updateChain
      .then(() => this.updateCard(card))
      .finally(() => {
        if (this.pendingCard && !this.closed) this.schedule()
      })
  }
}
