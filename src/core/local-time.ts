// 会话持久化面向人工排查，采用本机本地时间的固定格式，避免 JSON 中出现 UTC 的 Z 后缀。
// 注意：这个格式不携带时区，只适用于当前机器上的本地数据展示与恢复。
const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

const pad = (value: number): string => String(value).padStart(2, '0')

export const formatLocalDateTime = (date: Date): string => {
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join(
      '-',
    ) +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export const isLocalDateTime = (value: string): boolean => {
  const match = value.match(LOCAL_DATE_TIME_PATTERN)
  if (!match) return false

  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const date = new Date(year, month - 1, day, hour, minute, second)
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute &&
    date.getSeconds() === second
  )
}

// 仅用于把旧版 ISO/UTC 会话记录迁为本地格式。无效值返回 undefined，交给调用方清理。
export const migrateToLocalDateTime = (value: string): string | undefined => {
  if (isLocalDateTime(value)) return value
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : formatLocalDateTime(date)
}
