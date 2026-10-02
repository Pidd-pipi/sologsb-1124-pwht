import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import { nowIso, nextSerialNo } from '@/utils/id'
import { runMergeTask } from '@/utils/mergeRunner'
import type { MergeTask, MergeTaskStatus, MergedPostmarkSnapshot } from '@/types/merge'

/**
 * 邮戳合并处理清单：手动发起的合并、写入中途失败待重试的批次、
 * 以及旧数据升级时发现的重复关联，全部存放在同一份 mergeTasks 表中。
 */
export const useMergeStore = defineStore('merge', () => {
  const list = ref<MergeTask[]>([])
  const loaded = ref(false)

  async function load(): Promise<void> {
    list.value = await db.mergeTasks.orderBy('batchNo').toArray()
    loaded.value = true
  }

  function byId(id: number | null | undefined): MergeTask | null {
    if (id == null) return null
    return list.value.find((t) => t.id === id) ?? null
  }

  const pendingCount = computed(
    () => list.value.filter((t) => t.status === 'pending' || t.status === 'failed').length
  )
  const failedCount = computed(() => list.value.filter((t) => t.status === 'failed').length)
  const migrationCount = computed(() => list.value.filter((t) => t.source === 'migration').length)

  /** 登记一条手动合并批次，返回任务 id；随后由合并对话框逐项核对。 */
  async function enqueueMerge(masterId: number, duplicateId: number): Promise<number> {
    const now = nowIso()
    const batchNo = nextSerialNo(
      'MG-',
      (await db.mergeTasks.orderBy('batchNo').keys()) as string[]
    )
    const master = await db.postmarks.get(masterId)
    const duplicate = await db.postmarks.get(duplicateId)
    const task: MergeTask = {
      batchNo,
      kind: 'merge',
      status: 'pending',
      source: 'manual',
      title: `合并邮戳：${duplicate?.pmNo ?? '#' + duplicateId} 并入 ${master?.pmNo ?? '#' + masterId}`,
      note: '操作者手动发起的邮戳合并，请逐项核对冲突字段后确认。',
      createdAt: now,
      updatedAt: now,
      lastError: '',
      attempts: 0,
      masterId,
      duplicateId,
      snapshot: null,
      doneSteps: [],
      coverId: 0
    }
    const id = await db.mergeTasks.add(task)
    await load()
    return id
  }

  /** 逐项核对完成后保存取舍快照（仍不写入业务表，等确认执行）。 */
  async function saveSnapshot(id: number, snapshot: MergedPostmarkSnapshot): Promise<void> {
    await db.mergeTasks.update(id, { snapshot, updatedAt: nowIso() })
    await load()
  }

  /** 执行 / 断点续跑单个批次，返回最新任务状态。 */
  async function execute(id: number): Promise<MergeTask | null> {
    const task = await db.mergeTasks.get(id)
    if (!task) return null
    const fresh = await runMergeTask(task)
    await load()
    return fresh
  }

  /** 一键续跑所有可执行批次（尚未逐项核对的合并建议需先打开核对）。 */
  async function retryAll(): Promise<void> {
    const targets = list.value.filter((t) => {
      if (t.status !== 'pending' && t.status !== 'failed') return false
      return !(t.kind === 'merge' && !t.snapshot)
    })
    for (const task of targets) {
      if (typeof task.id === 'number') await execute(task.id)
    }
  }

  async function setStatus(id: number, status: MergeTaskStatus, note?: string): Promise<void> {
    const patch: Partial<MergeTask> = { status, updatedAt: nowIso() }
    if (note !== undefined) patch.note = note
    await db.mergeTasks.update(id, patch)
    await load()
  }

  /** 从清单移除（仅限已完成或已忽略的批次，失败批次建议先重试）。 */
  async function discard(id: number): Promise<void> {
    await db.mergeTasks.delete(id)
    await load()
  }

  return {
    list,
    loaded,
    pendingCount,
    failedCount,
    migrationCount,
    load,
    byId,
    enqueueMerge,
    saveSnapshot,
    execute,
    retryAll,
    setStatus,
    discard
  }
})
