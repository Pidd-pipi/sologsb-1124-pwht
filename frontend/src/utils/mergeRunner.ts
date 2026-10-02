/**
 * 合并批次执行器：把一次「两条邮戳并一条」拆成若干可重入的步骤，
 * 每步各自一个 IndexedDB 事务并即时登记进度；任何一步写入失败，
 * 批次保留为 failed，重试时从首个未完成步骤继续，已完成步骤天然幂等。
 */
import { db } from '@/utils/db'
import { nowIso } from '@/utils/id'
import type { MergeStep, MergeTask } from '@/types/merge'
import { MERGE_STEPS } from '@/types/merge'
import type { Postmark } from '@/types/postmark'

const STEP_LABEL: Record<MergeStep, string> = {
  updateMaster: '写回主档字段',
  remapCovers: '转移实寄封关联',
  moveAssets: '搬运戳样原图',
  deleteDuplicate: '删除被合并档案',
  finish: '完结批次'
}

export function mergeStepLabel(step: MergeStep): string {
  return STEP_LABEL[step]
}

async function postmarkAssets(ownerId: number) {
  return db.assets.where('[ownerType+ownerId]').equals(['postmark', ownerId]).toArray()
}

async function persist(id: number, patch: Partial<MergeTask>): Promise<void> {
  await db.mergeTasks.update(id, patch)
}

/** 统计将受合并影响的实寄封数（关联了任一侧，或同时挂了两侧）。 */
export async function affectedCoverCount(masterId: number, duplicateId: number): Promise<number> {
  const covers = await db.covers.toArray()
  return covers.filter((c) => {
    const ids = Array.isArray(c.cancelPmIds) ? c.cancelPmIds : []
    return ids.includes(masterId) || ids.includes(duplicateId)
  }).length
}

async function runMergeSteps(task: MergeTask): Promise<void> {
  const id = task.id as number
  if (!task.snapshot) throw new Error('该批次尚未完成逐项核对，无法执行')
  const snapshot = task.snapshot
  const done = new Set<MergeStep>(task.doneSteps)
  const stamp = nowIso()

  // 步骤 1：按确认后的快照写回主档（编目号固定保留主档，不在快照内）
  if (!done.has('updateMaster')) {
    await db.transaction('rw', db.postmarks, async () => {
      const master = await db.postmarks.get(task.masterId)
      if (!master) throw new Error(`主档邮戳 #${task.masterId} 已不存在，无法合并`)
      const patch: Partial<Postmark> = {
        type: snapshot.type as Postmark['type'],
        office: snapshot.office,
        province: snapshot.province,
        yearFrom: snapshot.yearFrom,
        yearTo: snapshot.yearTo,
        dateOnStamp: snapshot.dateOnStamp,
        inkColor: snapshot.inkColor,
        diameter: snapshot.diameter,
        scarceLevel: snapshot.scarceLevel as Postmark['scarceLevel'],
        bilingual: snapshot.bilingual,
        note: snapshot.note
      }
      let imageDataUrl = master.imageDataUrl
      if (snapshot.imagePick === 'duplicate') {
        const duplicate = await db.postmarks.get(task.duplicateId)
        if (duplicate?.imageDataUrl) imageDataUrl = duplicate.imageDataUrl
      }
      await db.postmarks.update(task.masterId, {
        ...patch,
        lettering: { ...snapshot.lettering },
        imageDataUrl,
        updatedAt: stamp
      })
    })
    done.add('updateMaster')
    await persist(id, { doneSteps: [...done], updatedAt: stamp })
  }

  // 步骤 2：把实寄封对被并档的关联转到主档，同时去掉同封内的重复关联
  if (!done.has('remapCovers')) {
    await db.transaction('rw', db.covers, async () => {
      const covers = await db.covers
        .filter((c) => Array.isArray(c.cancelPmIds) && c.cancelPmIds.includes(task.duplicateId))
        .toArray()
      for (const cover of covers) {
        const next: number[] = []
        for (const raw of cover.cancelPmIds) {
          const pmId = raw === task.duplicateId ? task.masterId : raw
          if (!next.includes(pmId)) next.push(pmId)
        }
        await db.covers.update(cover.id as number, {
          cancelPmIds: next,
          updatedAt: stamp
        })
      }
    })
    done.add('remapCovers')
    await persist(id, { doneSteps: [...done], updatedAt: stamp })
  }

  // 步骤 3：按戳样图取舍搬运 assets 原图（同 owner + side 只保留一张）
  if (!done.has('moveAssets')) {
    await db.transaction('rw', db.assets, async () => {
      const dupAssets = await postmarkAssets(task.duplicateId)
      const masterAssets = await postmarkAssets(task.masterId)
      const masterHasSample = masterAssets.some((a) => a.side === 'sample')
      for (const asset of dupAssets) {
        if (asset.side !== 'sample') continue
        if (snapshot.imagePick === 'duplicate' && !masterHasSample) {
          await db.assets.update(asset.id as number, {
            ownerId: task.masterId,
            updatedAt: stamp
          })
        } else {
          await db.assets.delete(asset.id as number)
        }
      }
    })
    done.add('moveAssets')
    await persist(id, { doneSteps: [...done], updatedAt: stamp })
  }

  // 步骤 4：删除被合并邮戳及其残余原图
  if (!done.has('deleteDuplicate')) {
    await db.transaction('rw', db.postmarks, db.assets, async () => {
      const leftovers = await postmarkAssets(task.duplicateId)
      if (leftovers.length) {
        await db.assets.bulkDelete(leftovers.map((a) => a.id as number))
      }
      await db.postmarks.delete(task.duplicateId)
    })
    done.add('deleteDuplicate')
    await persist(id, { doneSteps: [...done], updatedAt: stamp })
  }

  // 步骤 5：完结
  await persist(id, {
    status: 'done',
    doneSteps: MERGE_STEPS.slice(),
    lastError: '',
    updatedAt: nowIso()
  })
}

async function runLinkDedup(task: MergeTask): Promise<void> {
  const id = task.id as number
  await db.transaction('rw', db.covers, async () => {
    const cover = await db.covers.get(task.coverId)
    if (!cover) return // 实寄封已不在：重复关联随之消失，视为完成
    const next: number[] = []
    for (const pmId of Array.isArray(cover.cancelPmIds) ? cover.cancelPmIds : []) {
      if (!next.includes(pmId)) next.push(pmId)
    }
    if (next.length !== (cover.cancelPmIds?.length ?? 0)) {
      await db.covers.update(task.coverId, { cancelPmIds: next, updatedAt: nowIso() })
    }
  })
  await persist(id, {
    status: 'done',
    doneSteps: ['finish'],
    lastError: '',
    updatedAt: nowIso()
  })
}

/**
 * 执行（或断点续跑）一个处理清单项。
 * 成功后任务为 done；失败时保留 failed 与 lastError，不抛出，由界面提示重试。
 */
export async function runMergeTask(task: MergeTask): Promise<MergeTask> {
  if (typeof task.id !== 'number') throw new Error('批次尚未入库，不能执行')
  const startedAt = nowIso()
  await persist(task.id, {
    status: 'running',
    attempts: task.attempts + 1,
    updatedAt: startedAt
  })
  try {
    if (task.kind === 'merge') {
      await runMergeSteps(task)
    } else {
      await runLinkDedup(task)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await persist(task.id, {
      status: 'failed',
      lastError: message,
      updatedAt: nowIso()
    })
  }
  const fresh = await db.mergeTasks.get(task.id)
  if (!fresh) throw new Error('批次在执行后丢失')
  return fresh
}
