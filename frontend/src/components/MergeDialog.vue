<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useCoverStore } from '@/stores/coverStore'
import { useMergeStore } from '@/stores/mergeStore'
import { usePostmarkStore } from '@/stores/postmarkStore'
import type { Postmark } from '@/types/postmark'
import type { MergeSide } from '@/types/merge'
import {
  COMPARE_FIELDS,
  buildResolved,
  findConflicts,
  getNestedValue
} from '@/utils/merge'

const props = defineProps<{
  modelValue: boolean
  /** 预选的主档 id（从详情页触发时传入） */
  presetMasterId?: number | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  applied: []
}>()

const postmarkStore = usePostmarkStore()
const coverStore = useCoverStore()
const mergeStore = useMergeStore()

const masterId = ref<number | null>(null)
const secondaryId = ref<number | null>(null)
const choices = reactive<Record<string, MergeSide>>({})
const submitting = ref(false)

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

const master = computed<Postmark | null>(() =>
  masterId.value == null ? null : postmarkStore.byId(masterId.value)
)
const secondary = computed<Postmark | null>(() =>
  secondaryId.value == null ? null : postmarkStore.byId(secondaryId.value)
)

const postmarkOptions = computed(() =>
  postmarkStore.list.flatMap((pm) =>
    typeof pm.id === 'number' ? [{ label: `${pm.pmNo} ${pm.office}`, value: pm.id }] : []
  )
)

const conflicts = computed<string[]>(() =>
  master.value && secondary.value ? findConflicts(master.value, secondary.value) : []
)

const affectedCovers = computed(() => {
  if (!secondary.value) return []
  return coverStore.list.filter(
    (c) => Array.isArray(c.cancelPmIds) && c.cancelPmIds.includes(secondary.value!.id!)
  )
})

/** 各冲突字段的主档 / 次档值，供并排展示。 */
const compareRows = computed(() => {
  if (!master.value || !secondary.value) return []
  return COMPARE_FIELDS.filter((f) => conflicts.value.includes(f.key)).map((f) => ({
    ...f,
    masterValue: getNestedValue(master.value as unknown as Record<string, any>, f.key),
    secondaryValue: getNestedValue(secondary.value as unknown as Record<string, any>, f.key)
  }))
})

const resolvedPreview = computed<Postmark | null>(() => {
  if (!master.value || !secondary.value) return null
  return buildResolved(master.value, secondary.value, choices)
})

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      masterId.value = props.presetMasterId ?? null
      secondaryId.value = null
      Object.keys(choices).forEach((k) => delete choices[k])
      if (!coverStore.loaded) await coverStore.load()
    }
  }
)

watch(conflicts, (keys) => {
  // 初始化新增冲突字段的保留方为 master
  for (const key of keys) {
    if (!(key in choices)) choices[key] = 'master'
  }
  // 清理已不存在的冲突字段
  for (const key of Object.keys(choices)) {
    if (!keys.includes(key)) delete choices[key]
  }
})

function formatValue(value: unknown, fieldKey: string): string {
  if (value == null || value === '') return '—'
  if (fieldKey === 'bilingual') return value ? '是' : '否'
  if (fieldKey === 'imageDataUrl') return ''
  return String(value)
}

function swapSides(): void {
  const tmp = masterId.value
  masterId.value = secondaryId.value
  secondaryId.value = tmp
}

async function confirm(): Promise<void> {
  if (!master.value || !secondary.value) {
    ElMessage.warning('请先选择要合并的两枚邮戳')
    return
  }
  if (master.value.id === secondary.value.id) {
    ElMessage.warning('不能合并同一枚邮戳')
    return
  }
  submitting.value = true
  try {
    const id = await mergeStore.createBatch(master.value, secondary.value, { ...choices })
    await mergeStore.applyMerge(id)
    ElMessage.success(`已合并邮戳 ${secondary.value.pmNo} → ${master.value.pmNo}`)
    visible.value = false
    emit('applied')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ElMessage.error(`合并失败：${message}，批次已保留，可在处理清单重试`)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="合并邮戳" width="860px" top="5vh">
    <div class="merge-dialog">
      <p class="merge-dialog__tip">
        选择主档（保留）与次档（合并后删除），并排核对戳型、局所、年代与戳样图；冲突字段逐项决定保留哪边，确认后实寄封关联将转至主档。
      </p>

      <div class="merge-dialog__selectors">
        <div class="merge-dialog__selector">
          <h4 class="merge-dialog__selector-title">主档（保留）</h4>
          <el-select
            v-model="masterId"
            placeholder="选择保留的邮戳"
            filterable
            style="width: 100%"
          >
            <el-option v-for="opt in postmarkOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
          <div v-if="master" class="merge-dialog__pm">
            <img v-if="master.imageDataUrl" :src="master.imageDataUrl" :alt="master.pmNo" />
            <span v-else class="merge-dialog__no-image">暂无戳样</span>
            <p>{{ master.pmNo }} · {{ master.office }}</p>
          </div>
        </div>

        <div class="merge-dialog__swap">
          <el-button size="small" @click="swapSides" :disabled="!masterId || !secondaryId">⇄ 交换</el-button>
        </div>

        <div class="merge-dialog__selector">
          <h4 class="merge-dialog__selector-title">次档（合并后删除）</h4>
          <el-select
            v-model="secondaryId"
            placeholder="选择被合并的邮戳"
            filterable
            style="width: 100%"
          >
            <el-option
              v-for="opt in postmarkOptions.filter((o) => o.value !== masterId)"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
            />
          </el-select>
          <div v-if="secondary" class="merge-dialog__pm">
            <img v-if="secondary.imageDataUrl" :src="secondary.imageDataUrl" :alt="secondary.pmNo" />
            <span v-else class="merge-dialog__no-image">暂无戳样</span>
            <p>{{ secondary.pmNo }} · {{ secondary.office }}</p>
          </div>
        </div>
      </div>

      <template v-if="compareRows.length">
        <h4 class="merge-dialog__section-title">
          冲突字段核对（{{ compareRows.length }} 项）
        </h4>
        <el-table :data="compareRows" border stripe size="small">
          <el-table-column label="字段" width="130">
            <template #default="{ row }">
              <span :class="{ 'merge-dialog__field--highlight': row.highlight }">{{ row.label }}</span>
            </template>
          </el-table-column>
          <el-table-column label="主档" min-width="160">
            <template #default="{ row }">
              <img
                v-if="row.key === 'imageDataUrl' && row.masterValue"
                :src="row.masterValue"
                class="merge-dialog__thumb"
              />
              <span v-else>{{ formatValue(row.masterValue, row.key) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="次档" min-width="160">
            <template #default="{ row }">
              <img
                v-if="row.key === 'imageDataUrl' && row.secondaryValue"
                :src="row.secondaryValue"
                class="merge-dialog__thumb"
              />
              <span v-else>{{ formatValue(row.secondaryValue, row.key) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="保留方" width="180">
            <template #default="{ row }">
              <el-radio-group v-model="choices[row.key]" size="small">
                <el-radio-button value="master">主档</el-radio-button>
                <el-radio-button value="secondary">次档</el-radio-button>
              </el-radio-group>
            </template>
          </el-table-column>
        </el-table>
      </template>

      <p v-else-if="master && secondary" class="merge-dialog__no-conflict">
        两枚邮戳的字段完全一致，无需核对，可直接合并。
      </p>

      <p v-if="affectedCovers.length" class="merge-dialog__affected">
        受影响实寄封 {{ affectedCovers.length }} 封（关联将转至主档）：
        <span v-for="(c, i) in affectedCovers" :key="c.id" class="merge-dialog__affected-item">
          {{ c.coverNo }}<span v-if="i < affectedCovers.length - 1">、</span>
        </span>
      </p>

      <div v-if="resolvedPreview" class="merge-dialog__preview">
        <h4 class="merge-dialog__section-title">合并后预览</h4>
        <dl class="gb-facts">
          <div><dt>编目号</dt><dd>{{ resolvedPreview.pmNo }}</dd></div>
          <div><dt>戳型</dt><dd>{{ resolvedPreview.type }}</dd></div>
          <div><dt>局所</dt><dd>{{ resolvedPreview.office }}</dd></div>
          <div><dt>年代</dt><dd>{{ resolvedPreview.yearFrom }}-{{ resolvedPreview.yearTo }}</dd></div>
          <div><dt>戳面日期</dt><dd>{{ resolvedPreview.dateOnStamp || '未注' }}</dd></div>
          <div><dt>戳径/墨色</dt><dd>{{ resolvedPreview.diameter }}mm / {{ resolvedPreview.inkColor }}</dd></div>
        </dl>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="confirm">确认合并</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.merge-dialog__tip {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--gb-muted);
  line-height: 1.6;
}
.merge-dialog__selectors {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 12px;
  align-items: start;
  margin-bottom: 16px;
}
.merge-dialog__selector-title {
  margin: 0 0 6px;
  font-size: 13px;
  color: #5d3325;
}
.merge-dialog__swap {
  display: flex;
  align-items: center;
  padding-top: 22px;
}
.merge-dialog__pm {
  margin-top: 8px;
  padding: 8px;
  border: 1px solid var(--gb-line);
  border-radius: 8px;
  background: #fffdf8;
  text-align: center;
}
.merge-dialog__pm img {
  max-width: 100%;
  max-height: 120px;
  border-radius: 6px;
}
.merge-dialog__pm p {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--gb-muted);
}
.merge-dialog__no-image {
  display: block;
  padding: 24px 0;
  font-size: 12px;
  color: var(--gb-muted);
}
.merge-dialog__section-title {
  margin: 0 0 8px;
  font-size: 14px;
  color: #5d3325;
}
.merge-dialog__field--highlight {
  color: var(--gb-brown);
  font-weight: 600;
}
.merge-dialog__thumb {
  max-width: 80px;
  max-height: 60px;
  border-radius: 4px;
  border: 1px solid var(--gb-line);
}
.merge-dialog__no-conflict {
  margin: 0 0 16px;
  padding: 10px;
  font-size: 13px;
  color: #2f7a4d;
  background: #f0f7f2;
  border-radius: 8px;
}
.merge-dialog__affected {
  margin: 0 0 16px;
  padding: 10px;
  font-size: 13px;
  color: #8c3b2e;
  background: #fdf3ef;
  border-radius: 8px;
}
.merge-dialog__affected-item {
  color: #5d3325;
}
.merge-dialog__preview {
  margin-top: 16px;
  padding: 12px;
  border: 1px solid var(--gb-line);
  border-radius: 10px;
  background: #fbf7f0;
}
</style>
