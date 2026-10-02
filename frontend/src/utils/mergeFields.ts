/**
 * 邮戳合并的纯逻辑：字段并排核对、冲突判定、取舍快照，以及旧数据升级时的
 * 重复档案 / 重复关联探测。不依赖 Dexie 实例，便于迁移代码与 UI 共用。
 */
import type { Postmark } from '@/types/postmark'
import type { MergeImagePick, MergeSide, MergedPostmarkSnapshot } from '@/types/merge'

/** 并排核对的字段键；image（戳样图）单独成行处理 */
export type MergeFieldKey =
  | 'type'
  | 'office'
  | 'province'
  | 'yearFrom'
  | 'yearTo'
  | 'dateOnStamp'
  | 'inkColor'
  | 'diameter'
  | 'scarceLevel'
  | 'letteringTop'
  | 'letteringMiddle'
  | 'letteringBottom'
  | 'bilingual'
  | 'note'

export interface MergeFieldRow {
  key: MergeFieldKey
  label: string
  /** 是否长文本（备注等） */
  textarea?: boolean
}

/** 需求指定核对的戳型、局所、年代、戳样图，其余事实一并并排供逐项决定 */
export const MERGE_FIELDS: MergeFieldRow[] = [
  { key: 'type', label: '戳型' },
  { key: 'office', label: '使用局所' },
  { key: 'province', label: '省份' },
  { key: 'yearFrom', label: '年代起' },
  { key: 'yearTo', label: '年代止' },
  { key: 'dateOnStamp', label: '戳面日期' },
  { key: 'inkColor', label: '墨色' },
  { key: 'diameter', label: '戳径(mm)' },
  { key: 'scarceLevel', label: '稀见度' },
  { key: 'letteringTop', label: '戳面文字·上格' },
  { key: 'letteringMiddle', label: '戳面文字·中格' },
  { key: 'letteringBottom', label: '戳面文字·下格' },
  { key: 'bilingual', label: '中英双文字' },
  { key: 'note', label: '备注', textarea: true }
]

/** 读取一条邮戳在某个核对字段上的展示值（统一转字符串比较 / 渲染）。 */
export function mergeFieldValue(pm: Postmark, key: MergeFieldKey): string {
  switch (key) {
    case 'letteringTop':
      return pm.lettering?.top ?? ''
    case 'letteringMiddle':
      return pm.lettering?.middle ?? ''
    case 'letteringBottom':
      return pm.lettering?.bottom ?? ''
    case 'bilingual':
      return pm.bilingual ? '是' : '否'
    case 'dateOnStamp':
      return pm.dateOnStamp || '未注'
    case 'province':
      return pm.province || '待考'
    case 'note':
      return pm.note || '无'
    default:
      return String(pm[key] ?? '')
  }
}

/** 两个展示值是否一致（空白语义归一，避免「未注」与空串被误判为冲突）。 */
export function mergeFieldEqual(master: Postmark, duplicate: Postmark, key: MergeFieldKey): boolean {
  return mergeFieldValue(master, key) === mergeFieldValue(duplicate, key)
}

/** 当前存在冲突、需要操作者逐项决定的字段。 */
export function mergeConflictFields(master: Postmark, duplicate: Postmark): MergeFieldKey[] {
  return MERGE_FIELDS.filter((f) => !mergeFieldEqual(master, duplicate, f.key)).map((f) => f.key)
}

/** 把单字段取舍结果应用到累积快照。 */
function applyFieldChoice(
  snapshot: MergedPostmarkSnapshot,
  key: MergeFieldKey,
  chosen: Postmark
): void {
  const num = Number
  switch (key) {
    case 'type':
      snapshot.type = chosen.type
      break
    case 'office':
      snapshot.office = chosen.office
      break
    case 'province':
      snapshot.province = chosen.province
      break
    case 'yearFrom':
      snapshot.yearFrom = num(chosen.yearFrom)
      break
    case 'yearTo':
      snapshot.yearTo = num(chosen.yearTo)
      break
    case 'dateOnStamp':
      snapshot.dateOnStamp = chosen.dateOnStamp
      break
    case 'inkColor':
      snapshot.inkColor = chosen.inkColor
      break
    case 'diameter':
      snapshot.diameter = num(chosen.diameter)
      break
    case 'scarceLevel':
      snapshot.scarceLevel = chosen.scarceLevel
      break
    case 'letteringTop':
      snapshot.lettering.top = chosen.lettering.top
      break
    case 'letteringMiddle':
      snapshot.lettering.middle = chosen.lettering.middle
      break
    case 'letteringBottom':
      snapshot.lettering.bottom = chosen.lettering.bottom
      break
    case 'bilingual':
      snapshot.bilingual = chosen.bilingual
      break
    case 'note':
      snapshot.note = chosen.note
      break
  }
}

/**
 * 依据逐字段取舍生成主档最终快照。
 * choices 未覆盖的字段（值相同的字段）默认取主档。
 */
export function buildMergeSnapshot(
  master: Postmark,
  duplicate: Postmark,
  choices: Record<MergeFieldKey, MergeSide>,
  imagePick: MergeImagePick
): MergedPostmarkSnapshot {
  const snapshot: MergedPostmarkSnapshot = {
    type: master.type,
    office: master.office,
    province: master.province,
    yearFrom: master.yearFrom,
    yearTo: master.yearTo,
    dateOnStamp: master.dateOnStamp,
    inkColor: master.inkColor,
    diameter: master.diameter,
    lettering: { ...master.lettering },
    bilingual: master.bilingual,
    scarceLevel: master.scarceLevel,
    note: master.note,
    imagePick
  }
  for (const field of MERGE_FIELDS) {
    const side: MergeSide = choices[field.key] ?? 'master'
    applyFieldChoice(snapshot, field.key, side === 'master' ? master : duplicate)
  }
  return snapshot
}

/* ------------------------ 旧数据升级的重复探测 ------------------------ */

function normalizeNo(text: string): string {
  return (text || '').trim().toUpperCase()
}

function normalizeOffice(text: string): string {
  return (text || '').trim().replace(/\s+/g, '')
}

function normalizeProvince(text: string): string {
  return (text || '').trim()
}

/** 年代区间互相包含（典型的年代错录：起止年只在一端有小出入），仅相交不算重复。 */
function rangesContain(a: Postmark, b: Postmark): boolean {
  const aContainsB = Number(a.yearFrom) <= Number(b.yearFrom) && Number(b.yearTo) <= Number(a.yearTo)
  const bContainsA = Number(b.yearFrom) <= Number(a.yearFrom) && Number(a.yearTo) <= Number(b.yearTo)
  return aContainsB || bContainsA
}

/** 同编目号；或同戳型 + 同局所 + 同省份 + 年代区间互相包含（典型的局所 / 年代错录另建）。 */
export function looksDuplicatePair(a: Postmark, b: Postmark): boolean {
  if (a.id === b.id) return false
  const noA = normalizeNo(a.pmNo)
  const noB = normalizeNo(b.pmNo)
  if (noA && noA === noB) return true
  const provinceA = normalizeProvince(a.province)
  const provinceB = normalizeProvince(b.province)
  return (
    a.type === b.type &&
    normalizeOffice(a.office) !== '' &&
    normalizeOffice(a.office) === normalizeOffice(b.office) &&
    (provinceA === '' || provinceB === '' || provinceA === provinceB) &&
    rangesContain(a, b)
  )
}

export interface DuplicateGroup {
  /** 组内邮戳 id，按升序排列，首个默认作为建议主档 */
  ids: number[]
  reason: string
}

/**
 * 在全部邮戳中找出疑似重复分组（并查集）。
 * 同编目号一定成组；同戳型局所且年代重叠也连成一组。
 */
export function detectDuplicatePostmarks(postmarks: Postmark[]): DuplicateGroup[] {
  const valid = postmarks.filter((p) => typeof p.id === 'number')
  const parent = new Map<number, number>()
  const reasons = new Map<number, string>()
  for (const pm of valid) {
    parent.set(pm.id as number, pm.id as number)
  }

  function find(x: number): number {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root) as number
    let cur = x
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur) as number
      parent.set(cur, root)
      cur = next
    }
    return root
  }

  function union(a: number, b: number, reason: string): void {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    parent.set(rb, ra)
    reasons.set(ra, reasons.get(ra) ? `${reasons.get(ra)}；${reason}` : reason)
  }

  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      if (looksDuplicatePair(valid[i], valid[j])) {
        const noA = normalizeNo(valid[i].pmNo)
        const noB = normalizeNo(valid[j].pmNo)
        const reason = noA && noA === noB ? `编目号同为 ${noA}` : '戳型、局所相同且年代重叠'
        union(valid[i].id as number, valid[j].id as number, reason)
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (const pm of valid) {
    const root = find(pm.id as number)
    const list = groups.get(root) ?? []
    list.push(pm.id as number)
    groups.set(root, list)
  }

  const result: DuplicateGroup[] = []
  for (const [root, ids] of groups) {
    if (ids.length < 2) continue
    ids.sort((x, y) => x - y)
    result.push({ ids, reason: reasons.get(root) ?? '戳型、局所相同且年代重叠' })
  }
  return result
}
