import type { RequirementVersion } from './product-contracts.js'

type Metadata = Pick<RequirementVersion, 'priority' | 'stage'>

/** 旧渠道省略字段时保留当前值；显式null清除。缺省键保持缺省，历史JSON从不重写。 */
export const resolveRequirementMetadata = (
  submitted: Metadata,
  previous: Metadata | undefined,
): Metadata => {
  const priority =
    submitted.priority === undefined ? previous?.priority : submitted.priority

  const stage =
    submitted.stage === undefined ? previous?.stage : submitted.stage

  return {
    ...(priority === undefined ? {} : { priority }),
    ...(stage === undefined ? {} : { stage }),
  }
}
