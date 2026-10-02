/**
 * 邮戳合并批次的状态管理：创建批次、应用合并、失败重试、删除批次。
 * 写入中途失败时保留批次（status=failed），可从处理清单重试。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type { Postmark } from '@/types/postmark'
import type { Cover } from '@/types/cover'
import type { CatalogAsset } from '@/types/asset'
import type { PostmarkMergeBatch, MergeSide } from '@/types/merge'
import { buildResolved, dedupeIds, findConflicts } from '@/utils/merge'
import { nowIso } from '@/utils/id'

export const useMergeStore = defineStore('merge', () => {
  const batches = ref<PostmarkMergeBatch[]>([])
  const loading = ref(false)
  const loaded = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      batches.value = await db.mergeBatches.orderBy('createdAt').toArray()
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  /** 待处理（pending）与失败待重试（failed）的批次数，供徽标展示。 */
  const pendingCount = computed(() =>
    batches.value.filter((b) => b.status === 'pending' || b.status === 'failed').length
  )

  /**
   * 创建一枚合并批次。
   * @param master 主档（保留）
   * @param secondary 次档（合并后删除）
   * @param choices 各冲突字段的保留方
   */
  async function createBatch(
    master: Postmark,
    secondary: Postmark,
    choices: Record<string, MergeSide>
  ): Promise<number> {
    const now = nowIso()
    const resolved = buildResolved(master, secondary, choices)
    const affectedCoverIds = await findAffectedCovers(secondary.id!)
    const batch: PostmarkMergeBatch = {
      masterId: master.id!,
      secondaryId: secondary.id!,
      masterSnapshot: { ...master, lettering: { ...master.lettering } },
      secondarySnapshot: { ...secondary, lettering: { ...secondary.lettering } },
      fieldChoices: { ...choices },
      resolved,
      affectedCoverIds,
      status: 'pending',
      createdAt: now,
      updatedAt: now
    }
    const id = await db.mergeBatches.add(batch)
    await load()
    return id
  }

  /** 查找引用了指定邮戳的实寄封 id 列表。 */
  async function findAffectedCovers(postmarkId: number): Promise<number[]> {
    const covers = await db.covers.toArray()
    return covers
      .filter((c) => Array.isArray(c.cancelPmIds) && c.cancelPmIds.includes(postmarkId))
      .map((c) => c.id!)
      .filter((id): id is number => typeof id === 'number')
  }

  /** 应用一枚合并批次：在事务中更新主档、改写封关联、转移原图、删除次档。 */
  async function applyMerge(batchId: number): Promise<void> {
    const batch = await db.mergeBatches.get(batchId)
    if (!batch) throw new Error('合并批次不存在')
    const master = await db.postmarks.get(batch.masterId)
    const secondary = await db.postmarks.get(batch.secondaryId)
    if (!master) throw new Error(`主档 #${batch.masterId} 不存在，可能已被删除`)
    if (!secondary) throw new Error(`次档 #${batch.secondaryId} 不存在，可能已被删除`)

    // 标记为写入中
    await db.mergeBatches.update(batchId, { status: 'applying', updatedAt: nowIso() })

    // 重新计算受影响的封，避免批次创建后新增的关联被遗漏
    const affectedCoverIds = await findAffectedCovers(batch.secondaryId)

    try {
      const merged: Postmark = {
        ...batch.resolved,
        id: master.id,
        pmNo: master.pmNo,
        lettering: { ...batch.resolved.lettering },
        updatedAt: nowIso()
      }

      await db.transaction(
        'rw',
        db.postmarks,
        db.covers,
        db.assets,
        db.mergeBatches,
        async () => {
          // 1. 写入合并后的主档字段
          await db.postmarks.put(merged)

          // 2. 把引用次档的封关联改写为主档，并去重
          for (const coverId of affectedCoverIds) {
            const cover = await db.covers.get(coverId)
            if (!cover) continue
            const nextIds = dedupeIds(
              cover.cancelPmIds.map((id) => (id === batch.secondaryId ? batch.masterId : id))
            )
            await db.covers.update(coverId, { cancelPmIds: nextIds, updatedAt: nowIso() })
          }

          // 3. 转移次档的戳样原图到主档；主档已有该面则删除次档的
          const secondaryAssets = await db.assets
            .where('[ownerType+ownerId]')
            .equals(['postmark', batch.secondaryId])
            .toArray()
          for (const asset of secondaryAssets) {
            const existing = await db.assets
              .where('[ownerType+ownerId]')
              .equals(['postmark', batch.masterId])
              .filter((a: CatalogAsset) => a.side === asset.side)
              .first()
            if (existing) {
              await db.assets.delete(asset.id!)
            } else {
              await db.assets.update(asset.id!, { ownerId: batch.masterId })
            }
          }

          // 4. 删除次档邮戳
          await db.postmarks.delete(batch.secondaryId)

          // 5. 标记批次完成，并记录实际受影响的封数
          await db.mergeBatches.update(batchId, {
            status: 'done',
            affectedCoverIds,
            error: undefined,
            updatedAt: nowIso()
          })
        }
      )
    } catch (err) {
      // 写入失败：保留批次为 failed，记录原因，供重试
      const message = err instanceof Error ? err.message : String(err)
      await db.mergeBatches.update(batchId, {
        status: 'failed',
        error: message,
        updatedAt: nowIso()
      })
      await load()
      throw err
    }

    await load()
  }

  /** 重试一枚失败的批次。 */
  async function retry(batchId: number): Promise<void> {
    await applyMerge(batchId)
  }

  /** 删除一枚批次（已完成或失败的均可）。 */
  async function remove(batchId: number): Promise<void> {
    await db.mergeBatches.delete(batchId)
    await load()
  }

  /** 批量删除已完成的批次。 */
  async function clearDone(): Promise<void> {
    const doneIds = batches.value.filter((b) => b.status === 'done').map((b) => b.id!)
    await db.mergeBatches.bulkDelete(doneIds)
    await load()
  }

  /** 两枚邮戳的冲突字段列表（供 UI 预览）。 */
  function conflictsOf(master: Postmark, secondary: Postmark): string[] {
    return findConflicts(master, secondary)
  }

  return {
    batches,
    loading,
    loaded,
    pendingCount,
    load,
    createBatch,
    applyMerge,
    retry,
    remove,
    clearDone,
    conflictsOf
  }
})
