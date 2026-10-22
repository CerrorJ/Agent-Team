/** 明确原生结构化输出的字段层级；不能让模型以普通结果文本冒充可续接人工请求。 */
export const humanOutputInstructions = `纬舟人工处理协议：使用 StructuredOutput 工具提交最终结构化结果，根对象必须包含 outcome。
需要澄清时，使用 {"outcome":{"kind":"clarification","request":{"title":"澄清标题","intro":"说明","questions":[{"id":"format","prompt":"问题","options":[{"id":"a","label":"选项一"},{"id":"b","label":"选项二"}]}]}}}。
需要方案确认时，使用 {"outcome":{"kind":"plan","title":"方案标题","summary":"待确认方案正文"}}。
需要单次操作批准时，使用 {"outcome":{"kind":"operation","request":{"operation":"操作名称","detail":"具体操作","impact":"影响","rollback":"回滚方式","timeoutSeconds":600}}}。
提交人工请求后立即结束当前段；不要自答、提前执行待确认操作，或用 kind=result 的普通文本提问代替请求。
真正完成工作时才使用 {"outcome":{"kind":"result","answer":"完成说明"}}。收到所有者后续决定时继续同一会话，最终结果仍遵循以上结构。`
