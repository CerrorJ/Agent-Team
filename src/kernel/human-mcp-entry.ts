import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { ClarificationRequestSchema } from '../core/clarification.js'
import { ApprovalRequestSchema } from '../core/approval.js'

// 独立受信服务不读 .env、不访问业务数据库、不执行请求中的操作。
// 回执仅要求当前轮次收束；只有 Runner 取得进程结束证据后，内核才发布可处理请求。
const server = new McpServer({ name: 'agent-team-human', version: '0.4.0' })

const acknowledge = async () => ({
  content: [
    {
      type: 'text' as const,
      text: '人工请求已交给宿主。立即结束本轮，不要自行回答、批准或执行待批准操作，等待所有者决定。',
    },
  ],
})

server.registerTool(
  'request_clarification',
  {
    description:
      '存在必须由所有者回答的问题时提交。答案由所有者提供，调用后立即停止当前工作。',
    inputSchema: ClarificationRequestSchema,
  },
  acknowledge,
)
server.registerTool(
  'request_approval',
  {
    description:
      '提交当前单次操作的目的、影响和回退方式，等待所有者决定；不得先执行或扩展成其他操作的授权。',
    inputSchema: ApprovalRequestSchema,
  },
  acknowledge,
)
server.registerTool(
  'request_plan_review',
  {
    description: '提交本次任务的完整方案摘要，等待所有者确认，调用后停止实现。',
    inputSchema: z
      .object({
        title: z.string().trim().min(1).max(200),
        summary: z.string().trim().min(1).max(20_000),
      })
      .strict(),
  },
  acknowledge,
)
await server.connect(new StdioServerTransport())
