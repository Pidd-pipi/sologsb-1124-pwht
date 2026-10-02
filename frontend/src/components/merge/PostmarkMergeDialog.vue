<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { usePostmarkStore } from '@/stores/postmarkStore'
import { useMergeStore } from '@/stores/mergeStore'
import type { Postmark } from '@/types/postmark'
import type { MergeImagePick, MergeSide, MergedPostmarkSnapshot } from '@/types/merge'
import {
  MERGE_FIELDS,
  buildMergeSnapshot,
  mergeConflictFields,
  mergeFieldValue,
  type MergeFieldKey,
  type MergeFieldRow
} from '@/utils/mergeFields'
import { affectedCoverCount } from '@/utils/mergeRunner'

const props = defineProps<{
  visible: boolean
  /** 手动发起时预选的主档 id；打开已有批次时由 taskId 指定 */
  preselectMasterId?: number | null
  /** 处理清单中已有批次（迁移发现 / 失败重试） */
  taskId?: number | null
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  /** 合并批次执行完毕，通知父组件刷新各页面数据 */
  merged: []
}>()

const postmarkStore = usePostmarkStore()
const mergeStore = useMergeStore()

const step = ref<'pick' | 'review'>('pick')
const busy = ref(false)
const taskId = ref<number | null>(null)
const masterId = ref<number | null>(null)
const duplicateId = ref<number | null>(null)
const choices = ref<Record<MergeFieldKey, MergeSide>>({} as Record<MergeFieldKey, MergeSide>)
const imagePick = ref<MergeImagePick>('master')
const affected = ref(0)

const dialogVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v)
})

const master = computed<Postmark | null>(() =>
  masterId.value == null ? null : postmarkStore.byId(masterId.value)
)
const duplicate = computed<Postmark | null>(() =>
  duplicateId.value == null ? null : postmarkStore.byId(duplicateId.value)
)

const masterOptions = computed(() =>
  postmarkStore.list
    .filter((pm) => pm.id !== duplicateId.value)
    .map((pm) => ({ label: `${pm.pmNo} ${pm.office}（${pm.yearFrom}-${pm.yearTo}）`, value: pm.id as number }))
)
const duplicateOptions = computed(() =>
  postmarkStore.list
    .filter((pm) => pm.id !== masterId.value)
    .map((pm) => ({ label: `${pm.pmNo} ${pm.office}（${pm.yearFrom}-${pm.yearTo}）`, value: pm.id as number }))
)

const conflicts = computed(() =>
  master.value && duplicate.value ? mergeConflictFields(master.value, duplicate.value) : []
)
const conflictSet = computed(() => new Set<MergeFieldKey>(conflicts.value))
const existingTask = computed(() => mergeStore.byId(taskId.value))

function defaultChoices(): Record<MergeFieldKey, MergeSide> {
  const init = {} as Record<MergeFieldKey, MergeSide>
  for (const field of MERGE_FIELDS) init[field.key] = 'master'
  return init
}

function snapshotValue(snapshot: MergedPostmarkSnapshot, key: MergeFieldKey): string {
  switch (key) {
    case 'letteringTop':
      return snapshot.lettering.top
    case 'letteringMiddle':
      return snapshot.lettering.middle
    case 'letteringBottom':
      return snapshot.lettering.bottom
    case 'bilingual':
      return snapshot.bilingual ? '是' : '否'
    case 'dateOnStamp':
      return snapshot.dateOnStamp || '未注'
    case 'province':
      return snapshot.province || '待考'
    case 'note':
      return snapshot.note || '无'
    default:
      return String(snapshot[key] ?? '')
  }
}

function snapshotToChoices(snapshot: MergedPostmarkSnapshot): void {
  // 依据已有快照反推每个字段取自哪一边
  for (const field of MERGE_FIELDS) {
    const masterVal = master.value ? mergeFieldValue(master.value, field.key) : ''
    const dupVal = duplicate.value ? mergeFieldValue(duplicate.value, field.key) : ''
    const current = snapshotValue(snapshot, field.key)
    choices.value[field.key] = current === dupVal && dupVal !== masterVal ? 'duplicate' : 'master'
  }
}

async function goReview(): Promise<void> {
  if (masterId.value == null || duplicateId.value == null) {
    ElMessage.warning('请选择需要合并的两枚邮戳')
    return
  }
  if (masterId.value === duplicateId.value) {
    ElMessage.warning('主档与被合并邮戳不能是同一条')
    return
  }
  await enterReview()
}

async function enterReview(): Promise<void> {
  const m = postmarkStore.byId(masterId.value)
  if (!m) {
    ElMessage.warning('主档邮戳已不存在')
    return
  }
  choices.value = defaultChoices()
  const task = existingTask.value
  if (task?.snapshot) {
    imagePick.value = task.snapshot.imagePick
    snapshotToChoices(task.snapshot)
  } else {
    imagePick.value = 'master'
  }
  affected.value = await affectedCoverCount(masterId.value as number, duplicateId.value as number)
  step.value = 'review'
}

async function openFromTask(): Promise<void> {
  if (props.taskId == null) return
  const task = mergeStore.byId(props.taskId)
  if (!task || task.kind !== 'merge') {
    ElMessage.warning('该处理项不是邮戳合并批次')
    dialogVisible.value = false
    return
  }
  taskId.value = props.taskId
  masterId.value = task.masterId
  duplicateId.value = task.duplicateId
  await enterReview()
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) return
    if (!postmarkStore.loaded) await postmarkStore.load()
    if (!mergeStore.loaded) await mergeStore.load()
    step.value = 'pick'
    taskId.value = props.taskId ?? null
    masterId.value = props.preselectMasterId ?? null
    duplicateId.value = null
    choices.value = defaultChoices()
    imagePick.value = 'master'
    affected.value = 0
    if (taskId.value != null) await openFromTask()
  }
)

/** 互换主从：被并档变主档，取舍全部回到新主档 */
function swapSides(): void {
  const oldMaster = masterId.value
  masterId.value = duplicateId.value
  duplicateId.value = oldMaster
  choices.value = defaultChoices()
  imagePick.value = 'master'
  void enterReview()
}

function chooseAll(side: MergeSide): void {
  for (const field of MERGE_FIELDS) choices.value[field.key] = side
}

async function confirmMerge(): Promise<void> {
  if (!master.value || !duplicate.value) return
  const snapshot = buildMergeSnapshot(master.value, duplicate.value, choices.value, imagePick.value)
  if (snapshot.yearFrom > snapshot.yearTo) {
    ElMessage.warning('合并后的使用年代，起始年不能晚于结束年')
    return
  }
  busy.value = true
  try {
    let id = taskId.value
    if (id == null) {
      id = await mergeStore.enqueueMerge(masterId.value as number, duplicateId.value as number)
      taskId.value = id
    }
    await mergeStore.saveSnapshot(id, snapshot)
    const result = await mergeStore.execute(id)
    if (result?.status === 'done') {
      ElMessage.success(
        `已完成合并：${duplicate.value.pmNo} 的实寄封关联已转至 ${master.value.pmNo}（${affected.value} 封受影响）`
      )
      emit('merged')
      dialogVisible.value = false
    } else {
      ElMessage.warning(
        `写入中途失败，批次 ${result?.batchNo ?? ''} 已保留在处理清单，可稍后重试（${result?.lastError ?? '未知错误'}）`
      )
      emit('merged')
      dialogVisible.value = false
    }
  } finally {
    busy.value = false
  }
}

function valueOf(pm: Postmark | null, key: MergeFieldKey): string {
  return pm ? mergeFieldValue(pm, key) : '—'
}
</script>

<template>
  <el-dialog
    :model-value="dialogVisible"
    :title="taskId ? `合并核对 · ${existingTask?.batchNo ?? ''}` : '合并邮戳档案'"
    width="900px"
    @update:model-value="dialogVisible = $event"
  >
    <!-- 第一步：选择并排核对的两枚邮戳 -->
    <div v-if="step === 'pick'">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="先选定主档（保留的一条）与被合并邮戳（核对后删除的一条），再逐项核对戳型、局所、年代与戳样图。"
        style="margin-bottom: 14px"
      />
      <el-form label-width="130px">
        <el-form-item label="主档（保留）">
          <el-select
            v-model="masterId"
            placeholder="选择保留的邮戳档案"
            filterable
            style="width: 100%"
          >
            <el-option v-for="opt in masterOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="被合并（删除）">
          <el-select
            v-model="duplicateId"
            placeholder="选择错录另建的那一条"
            filterable
            style="width: 100%"
          >
            <el-option v-for="opt in duplicateOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
      </el-form>
    </div>

    <!-- 第二步：并排核对，逐项决定保留哪边 -->
    <div v-else>
      <div class="merge-dialog__head">
        <div class="merge-dialog__side">
          <el-tag type="success" effect="dark">主档保留</el-tag>
          <strong>{{ master?.pmNo }}</strong>
          <span>{{ master?.office }}</span>
        </div>
        <el-button size="small" @click="swapSides">互换主从</el-button>
        <div class="merge-dialog__side">
          <el-tag type="warning" effect="plain">被合并删除</el-tag>
          <strong>{{ duplicate?.pmNo }}</strong>
          <span>{{ duplicate?.office }}</span>
        </div>
      </div>

      <div class="merge-dialog__quick">
        <span>快速选择：</span>
        <el-button size="small" @click="chooseAll('master')">冲突项全取主档</el-button>
        <el-button size="small" @click="chooseAll('duplicate')">冲突项全取被并档</el-button>
        <span class="merge-dialog__hint">一致字段无需处理；编目号固定保留主档 {{ master?.pmNo }}</span>
      </div>

      <el-table :data="MERGE_FIELDS" border size="small" class="merge-dialog__table">
        <el-table-column label="核对项" width="150">
          <template #default="{ row }: { row: MergeFieldRow }">
            <span :class="{ 'is-conflict-label': conflictSet.has(row.key) }">{{ row.label }}</span>
          </template>
        </el-table-column>
        <el-table-column label="主档" min-width="200">
          <template #default="{ row }: { row: MergeFieldRow }">
            <el-radio v-model="choices[row.key]" value="master" class="merge-dialog__radio">
              <span :class="{ 'is-chosen': choices[row.key] === 'master' }">
                {{ valueOf(master, row.key) }}
              </span>
            </el-radio>
          </template>
        </el-table-column>
        <el-table-column label="被合并邮戳" min-width="200">
          <template #default="{ row }: { row: MergeFieldRow }">
            <el-radio v-model="choices[row.key]" value="duplicate" class="merge-dialog__radio">
              <span :class="{ 'is-chosen': choices[row.key] === 'duplicate' }">
                {{ valueOf(duplicate, row.key) }}
              </span>
            </el-radio>
          </template>
        </el-table-column>
      </el-table>

      <div class="merge-dialog__images">
        <div
          v-for="pick in (['master', 'duplicate'] as MergeImagePick[])"
          :key="pick"
          class="merge-dialog__figure"
          :class="{ 'is-picked': imagePick === pick }"
          @click="imagePick = pick"
        >
          <el-radio v-model="imagePick" :value="pick">
            {{ pick === 'master' ? '戳样图保留主档' : '戳样图取被并档（原图一并搬运）' }}
          </el-radio>
          <img
            v-if="(pick === 'master' ? master : duplicate)?.imageDataUrl"
            :src="(pick === 'master' ? master : duplicate)?.imageDataUrl"
            alt="戳样图"
          />
          <span v-else class="merge-dialog__no-image">该条暂无戳样图</span>
        </div>
      </div>

      <el-alert
        type="warning"
        :closable="false"
        show-icon
        :title="`确认后：${duplicate?.pmNo} 将被删除，其实寄封关联全部转到 ${master?.pmNo}（约 ${affected} 封实寄封受影响）；票戳组合与综合检索随即按主档显示。`"
      />
    </div>

    <template #footer>
      <el-button @click="step === 'pick' ? (dialogVisible = false) : (step = 'pick')">
        {{ step === 'pick' ? '取消' : '上一步' }}
      </el-button>
      <el-button v-if="step === 'pick'" type="primary" :disabled="masterId == null || duplicateId == null" @click="goReview">
        并排核对
      </el-button>
      <el-button v-else type="primary" :loading="busy" @click="confirmMerge">
        确认合并并转关联
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.merge-dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.merge-dialog__side {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex: 1;
}
.merge-dialog__side:last-child {
  justify-content: flex-end;
}
.merge-dialog__quick {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.merge-dialog__hint {
  font-size: 12px;
  color: var(--gb-muted);
}
.merge-dialog__table {
  margin-bottom: 14px;
}
.is-conflict-label {
  color: #b02a1e;
  font-weight: 700;
}
.merge-dialog__radio {
  height: auto;
  align-items: flex-start;
  white-space: normal;
}
.is-chosen {
  font-weight: 700;
  color: #5d3325;
}
.merge-dialog__images {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 14px;
}
.merge-dialog__figure {
  border: 1px dashed var(--gb-line);
  border-radius: 10px;
  padding: 8px;
  cursor: pointer;
  background: #fffdf8;
}
.merge-dialog__figure.is-picked {
  border-color: #8c3b2e;
  border-style: solid;
}
.merge-dialog__figure img {
  display: block;
  width: 100%;
  max-height: 180px;
  object-fit: contain;
  margin-top: 6px;
  border-radius: 6px;
}
.merge-dialog__no-image {
  display: block;
  text-align: center;
  font-size: 12px;
  color: var(--gb-muted);
  padding: 30px 0;
}
</style>
