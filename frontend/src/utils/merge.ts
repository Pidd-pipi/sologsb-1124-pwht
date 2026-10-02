/** 邮戳合并的纯工具：字段核对、嵌套取值、合并结果构建、重复关联检测。 */

import type { Cover } from '@/types/cover'
import type { Postmark } from '@/types/postmark'
import type { MergeSide } from '@/types/merge'
import { nowIso } from '@/utils/id'

/** 可核对字段定义 */
export interface CompareField {
  /** 字段路径，支持点号嵌套，如 lettering.top */
  key: string
  /** 字段中文名 */
  label: string
  /** 是否为重点核对字段（戳型 / 局所 / 年代 / 戳样图） */
  highlight?: boolean
}

/** 两枚邮戳并排核对的字段清单 */
export const COMPARE_FIELDS: CompareField[] = [
  { key: 'type', label: '戳型', highlight: true },
  { key: 'office', label: '局所', highlight: true },
  { key: 'province', label: '省份' },
  { key: 'yearFrom', label: '年代起', highlight: true },
  { key: 'yearTo', label: '年代止', highlight: true },
  { key: 'dateOnStamp', label: '戳面日期' },
  { key: 'inkColor', label: '墨色' },
  { key: 'diameter', label: '戳径' },
  { key: 'lettering.top', label: '上格文字' },
  { key: 'lettering.middle', label: '中格文字' },
  { key: 'lettering.bottom', label: '下格文字' },
  { key: 'bilingual', label: '中英双文字' },
  { key: 'scarceLevel', label: '稀见度' },
  { key: 'imageDataUrl', label: '戳样图', highlight: true },
  { key: 'note', label: '备注' }
]

/** 读取嵌套字段值。 */
export function getNestedValue(obj: Record<string, any>, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

/** 设置嵌套字段值（中间层不存在时静默跳过）。 */
export function setNestedValue(obj: Record<string, any>, path: string, value: any): void {
  const keys = path.split('.')
  const last = keys.pop()
  if (!last) return
  const target = keys.reduce((o, k) => (o == null ? o : o[k]), obj)
  if (target != null && typeof target === 'object') target[last] = value
}

/** 判断两个字段值是否相等（对象按 JSON 比较）。 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == b
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return a === b
}

/** 找出两枚邮戳的冲突字段（值不相等的字段路径）。 */
export function findConflicts(master: Postmark, secondary: Postmark): string[] {
  const conflicts: string[] = []
  for (const field of COMPARE_FIELDS) {
    const a = getNestedValue(master as unknown as Record<string, any>, field.key)
    const b = getNestedValue(secondary as unknown as Record<string, any>, field.key)
    if (!valuesEqual(a, b)) conflicts.push(field.key)
  }
  return conflicts
}

/** 依据字段保留方构建合并后的主档字段快照。 */
export function buildResolved(
  master: Postmark,
  secondary: Postmark,
  choices: Record<string, MergeSide>
): Postmark {
  const resolved: Postmark = {
    ...master,
    lettering: { ...master.lettering }
  }
  for (const [key, side] of Object.entries(choices)) {
    if (side === 'secondary') {
      const value = getNestedValue(secondary as unknown as Record<string, any>, key)
      setNestedValue(resolved as unknown as Record<string, any>, key, value)
    }
  }
  // 编目号始终保留主档的
  resolved.pmNo = master.pmNo
  resolved.updatedAt = nowIso()
  return resolved
}

/** 数组去重，保持首次出现顺序。 */
export function dedupeIds(ids: number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const id of ids) {
    if (typeof id !== 'number' || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}

/** 判断两枚邮戳是否为疑似重复（同戳型 + 同局所 + 年代区间相交）。 */
export function isDuplicatePair(a: Postmark, b: Postmark): boolean {
  if (a.type !== b.type || a.office !== b.office) return false
  return a.yearFrom <= b.yearTo && b.yearFrom <= a.yearTo
}

export interface MergeCandidate {
  master: Postmark
  secondary: Postmark
  /** 同时引用了这两枚邮戳的实寄封 id */
  affectedCoverIds: number[]
}

/**
 * 从已有数据中检测重复关联：
 * 若一枚实寄封同时引用了两枚疑似重复的邮戳，则列为待合并候选。
 * 供旧数据升级兼容时生成处理清单使用。
 */
export function detectDuplicateAssociations(
  postmarks: Postmark[],
  covers: Cover[]
): MergeCandidate[] {
  const candidates: MergeCandidate[] = []
  const seenPairs = new Set<string>()
  for (let i = 0; i < postmarks.length; i += 1) {
    for (let j = i + 1; j < postmarks.length; j += 1) {
      const a = postmarks[i]
      const b = postmarks[j]
      if (!isDuplicatePair(a, b)) continue
      const affected = covers
        .filter(
          (c) =>
            Array.isArray(c.cancelPmIds) &&
            c.cancelPmIds.includes(a.id!) &&
            c.cancelPmIds.includes(b.id!)
        )
        .map((c) => c.id!)
        .filter((id): id is number => typeof id === 'number')
      if (!affected.length) continue
      const pairKey = [a.id, b.id].filter((id): id is number => typeof id === 'number').sort((x, y) => x - y).join('-')
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)
      candidates.push({ master: a, secondary: b, affectedCoverIds: affected })
    }
  }
  return candidates
}
