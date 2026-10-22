const unsupported = new Set([
  '$schema',
  'minimum',
  'maximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
])

/** 官方结构化输出只支持 JSON Schema 子集。传输时简化约束，返回后仍按完整领域 schema 校验。 */
export const claudeJsonSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(claudeJsonSchema)
  if (!value || typeof value !== 'object') return value
  const result: Record<string, unknown> = {}
  const notes: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (omitConstraint(key, item)) {
      if (key !== '$schema') notes.push(`${key}=${String(item)}`)
      continue
    }
    result[key === 'oneOf' ? 'anyOf' : key] = schemaChild(key, item)
  }
  if (notes.length)
    result.description =
      `${String(result.description ?? '')} (${notes.join(', ')})`.trim()
  return result
}

const omitConstraint = (key: string, value: unknown) =>
  unsupported.has(key) || (key === 'minItems' && Number(value) > 1)

const schemaChild = (key: string, value: unknown): unknown => {
  if (!['properties', '$defs', 'definitions'].includes(key))
    return claudeJsonSchema(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  // properties 的键是业务字段名，不能把名为 maximum 的字段误认为约束并删掉。
  return Object.fromEntries(
    Object.entries(value).map(([name, schema]) => [
      name,
      claudeJsonSchema(schema),
    ]),
  )
}
