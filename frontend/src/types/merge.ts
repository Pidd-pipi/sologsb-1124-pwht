/** 邮戳合并（PostmarkMerge）数据模型：两枚邮戳并排核对后合并为主档的批次记录。 */

import type { Postmark } from './postmark'

/** 合并批次状态：待处理 / 写入中 / 已完成 / 失败待重试 */
export type MergeStatus = 'pending' | 'applying' | 'done' | 'failed'

/** 字段保留方：主档或次档 */
export type MergeSide = 'master' | 'secondary'

export interface PostmarkMergeBatch {
  id?: number
  /** 合并后保留的主档 id */
  masterId: number
  /** 被合并删除的次档 id */
  secondaryId: number
  /** 主档快照（合并时留存，供处理清单核对） */
  masterSnapshot: Postmark
  /** 次档快照（合并时留存，供处理清单核对） */
  secondarySnapshot: Postmark
  /** 各冲突字段的保留方：key 为字段路径，value 为 'master' | 'secondary' */
  fieldChoices: Record<string, MergeSide>
  /** 合并后的主档字段快照（应用时写入主档） */
  resolved: Postmark
  /** 受影响（关联需改写）的实寄封 id 列表 */
  affectedCoverIds: number[]
  status: MergeStatus
  /** 失败原因（status 为 failed 时填写） */
  error?: string
  createdAt: string
  updatedAt: string
}
