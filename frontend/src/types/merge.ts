/**
 * 合并处理清单（MergeTask）：邮戳档案错录后「两条并一条」的处理批次。
 * 操作者逐项核对冲突字段、确认后执行；写入中途失败时任务保留，可按步骤重试。
 * 旧数据升级迁移发现的重复关联也以同一结构进入这份清单。
 */
import type { PostmarkLettering } from './postmark'

/** merge：两枚邮戳合并；linkDedup：清理同一实寄封里重复的邮戳关联 */
export type MergeTaskKind = 'merge' | 'linkDedup'

/** pending 待处理 / running 执行中 / failed 写入失败待重试 / done 已完成 */
export type MergeTaskStatus = 'pending' | 'running' | 'failed' | 'done'

/** manual 操作者手动发起；migration 旧数据升级迁移时发现 */
export type MergeTaskSource = 'manual' | 'migration'

/** 合并后戳样图（含 assets 原图）保留哪边 */
export type MergeImagePick = 'master' | 'duplicate'

/** 冲突字段逐项决定保留哪边 */
export type MergeSide = 'master' | 'duplicate'

/** 合并分步：每步各自落库，失败重试从首个未完成步骤继续 */
export const MERGE_STEPS = [
  'updateMaster',
  'remapCovers',
  'moveAssets',
  'deleteDuplicate',
  'finish'
] as const
export type MergeStep = (typeof MERGE_STEPS)[number]

/** 操作者逐项取舍后确定的主档字段快照（编目号固定保留主档，不在这里） */
export interface MergedPostmarkSnapshot {
  type: string
  office: string
  province: string
  yearFrom: number
  yearTo: number
  dateOnStamp: string
  inkColor: string
  diameter: number
  lettering: PostmarkLettering
  bilingual: boolean
  scarceLevel: string
  note: string
  /** 戳样图保留哪边，执行时据此搬运 assets 原图与缩略图 */
  imagePick: MergeImagePick
}

export interface MergeTask {
  id?: number
  /** 批次号，如 MG-0001 */
  batchNo: string
  kind: MergeTaskKind
  status: MergeTaskStatus
  source: MergeTaskSource
  /** 清单中展示的说明标题 */
  title: string
  /** 详细说明（命中的重复情况等） */
  note: string
  createdAt: string
  updatedAt: string
  /** 最近一次写入失败的原因，成功后清空 */
  lastError: string
  /** 已尝试次数 */
  attempts: number

  /* ---- merge 专属 ---- */
  /** 主档邮戳 id（保留的一条） */
  masterId: number
  /** 被合并邮戳 id（合并后删除） */
  duplicateId: number
  /** 操作者确认逐项取舍后生成的快照；迁移发现的建议任务在核对前为空 */
  snapshot: MergedPostmarkSnapshot | null
  /** 已完成的步骤；全部完成即为 done，失败后据此续跑 */
  doneSteps: MergeStep[]

  /* ---- linkDedup 专属 ---- */
  /** 需要清理重复关联的实寄封 id */
  coverId: number
}
