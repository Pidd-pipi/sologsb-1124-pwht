<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { UploadFile } from 'element-plus'
import MergeDialog from '@/components/MergeDialog.vue'
import StampCard from '@/components/common/StampCard.vue'
import ScarceTag from '@/components/common/ScarceTag.vue'
import { useCatalogFilter } from '@/hooks/useCatalogFilter'
import { useMergeStore } from '@/stores/mergeStore'
import { usePostmarkStore, type ImagePayload } from '@/stores/postmarkStore'
import type { Postmark } from '@/types/postmark'
import type { PostmarkMergeBatch } from '@/types/merge'
import {
  INK_COLORS,
  POSTMARK_TYPES,
  PROVINCES,
  SCARCE_LEVELS,
  createEmptyPostmark
} from '@/types/postmark'
import { clearDraft, draftSavedAt, loadDraft, saveDraft } from '@/utils/draft'
import { nowIso, toNumber } from '@/utils/id'
import { COMPARE_FIELDS } from '@/utils/merge'

const store = usePostmarkStore()
const mergeStore = useMergeStore()
const source = computed(() => store.list)
const { filters, filtered, activeCount, reset } = useCatalogFilter<Postmark>('postmark', source)

const viewMode = ref<'wall' | 'list'>('wall')
const dialogVisible = ref(false)
const detailVisible = ref(false)
const sampleVisible = ref(false)
const mergeDialogVisible = ref(false)
const presetMasterId = ref<number | null>(null)
const batchDetailVisible = ref(false)
const currentBatch = ref<PostmarkMergeBatch | null>(null)
const current = ref<Postmark | null>(null)
const sampleText = ref('')
const imagePayload = ref<ImagePayload | null>(null)
const draftHint = ref('')
const form = reactive<Postmark>(createEmptyPostmark())

onMounted(async () => {
  if (!store.loaded) await store.load()
  if (!mergeStore.loaded) await mergeStore.load()
  draftHint.value = draftSavedAt('postmark')
})

watch(
  form,
  () => {
    if (!dialogVisible.value) return
    saveDraft('postmark', { ...form, lettering: { ...form.lettering } })
    draftHint.value = nowIso()
  },
  { deep: true }
)

function openCreate(): void {
  Object.assign(form, createEmptyPostmark())
  form.pmNo = store.nextPmNo()
  form.lettering = { top: '', middle: '', bottom: '' }
  imagePayload.value = null
  const draft = loadDraft<Postmark>('postmark')
  if (draft) {
    Object.assign(form, draft)
    form.lettering = draft.lettering ?? { top: '', middle: '', bottom: '' }
    if (form.imageDataUrl) imagePayload.value = { dataUrl: form.imageDataUrl, fileName: '草稿戳样' }
  }
  dialogVisible.value = true
}

function discardDraft(): void {
  clearDraft('postmark')
  draftHint.value = ''
  Object.assign(form, createEmptyPostmark())
  form.pmNo = store.nextPmNo()
  form.lettering = { top: '', middle: '', bottom: '' }
  imagePayload.value = null
  ElMessage.info('已清除本地草稿')
}

function onFileChange(file: UploadFile): void {
  const raw = file.raw
  if (!raw) return
  if (raw.size > 2 * 1024 * 1024) {
    ElMessage.warning('戳样图请控制在 2MB 以内')
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = String(reader.result ?? '')
    form.imageDataUrl = dataUrl
    imagePayload.value = { dataUrl, fileName: raw.name }
  }
  reader.readAsDataURL(raw)
}

async function submit(): Promise<void> {
  if (!form.office.trim()) {
    ElMessage.warning('请填写使用局所')
    return
  }
  if (toNumber(form.yearFrom) > toNumber(form.yearTo)) {
    ElMessage.warning('使用年代的起始年不能晚于结束年')
    return
  }
  const pmNo = form.pmNo || store.nextPmNo()
  await store.create({ ...form, pmNo, lettering: { ...form.lettering } }, imagePayload.value)
  clearDraft('postmark')
  draftHint.value = ''
  dialogVisible.value = false
  ElMessage.success(`已编目邮戳 ${pmNo}`)
}

function showDetail(pm: Postmark): void {
  current.value = pm
  detailVisible.value = true
}

function buildSampleText(pm: Postmark): string {
  return [
    `戳样条目 ${pm.pmNo}`,
    `戳型：${pm.type}`,
    `局所：${pm.office}（${pm.province || '省份待考'}）`,
    `使用年代：${pm.yearFrom}-${pm.yearTo}`,
    `戳面日期：${pm.dateOnStamp || '未注'}`,
    `戳径/墨色：${pm.diameter}mm / ${pm.inkColor}`,
    `戳面文字：上格「${pm.lettering.top}」 中格「${pm.lettering.middle}」 下格「${pm.lettering.bottom}」`,
    `文字：${pm.bilingual ? '中英双文字' : '单文字'}`,
    `稀见度：${pm.scarceLevel}`,
    `备注：${pm.note || '无'}`
  ].join('\n')
}

function generateSample(pm: Postmark): void {
  sampleText.value = buildSampleText(pm)
  sampleVisible.value = true
}

async function copySample(): Promise<void> {
  try {
    await navigator.clipboard.writeText(sampleText.value)
    ElMessage.success('戳样条目已复制')
  } catch {
    ElMessage.info('浏览器未授权剪贴板，请手动选择文本')
  }
}

function openMerge(): void {
  presetMasterId.value = null
  mergeDialogVisible.value = true
}

function openMergeWith(pm: Postmark): void {
  presetMasterId.value = pm.id ?? null
  mergeDialogVisible.value = true
}

async function retryMerge(batch: PostmarkMergeBatch): Promise<void> {
  if (batch.id == null) return
  try {
    await mergeStore.retry(batch.id)
    ElMessage.success('合并已重试成功')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ElMessage.error(`重试失败：${message}`)
  }
}

async function removeMerge(batch: PostmarkMergeBatch): Promise<void> {
  if (batch.id == null) return
  await mergeStore.remove(batch.id)
  ElMessage.success('批次已删除')
}

async function clearDoneBatches(): Promise<void> {
  await mergeStore.clearDone()
  ElMessage.success('已清除已完成批次')
}

function viewBatch(batch: PostmarkMergeBatch): void {
  currentBatch.value = batch
  batchDetailVisible.value = true
}

function choiceLabel(batch: PostmarkMergeBatch, fieldKey: string): string {
  const side = batch.fieldChoices?.[fieldKey] ?? 'master'
  return side === 'master' ? '保留主档' : '保留次档'
}

function fieldLabel(fieldKey: string): string {
  const found = COMPARE_FIELDS.find((f) => f.key === fieldKey)
  return found?.label ?? fieldKey
}

function pmLabelOf(id: number): string {
  return store.labelOf(id)
}

function mergeStatusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: '待处理',
    applying: '写入中',
    done: '已完成',
    failed: '失败待重试'
  }
  return map[status] ?? status
}

function mergeStatusType(status: string): '' | 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'done') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'applying') return 'warning'
  return 'info'
}

async function onMergeApplied(): Promise<void> {
  // 合并成功后重新加载邮戳与批次列表，确保封关联与检索结果按主档显示
  await store.load()
  await mergeStore.load()
}
</script>

<template>
  <div class="gb-page postmark-page">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">邮戳目录</h1>
        <p class="gb-page__subtitle">
          共 {{ store.total }} 枚邮戳，其中罕见以上 {{ store.scarceCount }} 枚；按戳型、局所、年代区间检索。
        </p>
      </div>
      <div class="postmark-page__actions">
        <el-radio-group v-model="viewMode" size="small">
          <el-radio-button value="wall">图片墙</el-radio-button>
          <el-radio-button value="list">列表</el-radio-button>
        </el-radio-group>
        <el-button @click="openMerge">合并邮戳</el-button>
        <el-button type="primary" @click="openCreate">新增邮戳</el-button>
      </div>
    </header>

    <section class="gb-panel">
      <h2 class="gb-panel__title">筛选（{{ activeCount }} 项生效）</h2>
      <el-form :inline="true" label-width="72px" @submit.prevent>
        <el-form-item label="关键词">
          <el-input v-model="filters.keyword" placeholder="编目号 / 戳面文字 / 备注" clearable />
        </el-form-item>
        <el-form-item label="戳型">
          <el-select v-model="filters.type" placeholder="全部戳型" clearable style="width: 150px">
            <el-option v-for="t in POSTMARK_TYPES" :key="t" :label="t" :value="t" />
          </el-select>
        </el-form-item>
        <el-form-item label="局所">
          <el-input v-model="filters.office" placeholder="如 上海" clearable />
        </el-form-item>
        <el-form-item label="省份">
          <el-select v-model="filters.province" placeholder="全部省份" clearable style="width: 130px">
            <el-option v-for="p in PROVINCES" :key="p" :label="p" :value="p" />
          </el-select>
        </el-form-item>
        <el-form-item label="年代区间">
          <el-input v-model="filters.era" placeholder="如 1900-1949" clearable style="width: 150px" />
        </el-form-item>
        <el-form-item label="稀见度">
          <el-select v-model="filters.scarceLevel" placeholder="全部" clearable style="width: 120px">
            <el-option v-for="s in SCARCE_LEVELS" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="排序">
          <el-select v-model="filters.sortKey" style="width: 150px">
            <el-option label="最近更新" value="recent" />
            <el-option label="编号升序" value="noAsc" />
            <el-option label="年代升序" value="yearAsc" />
            <el-option label="年代降序" value="yearDesc" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button @click="reset">重置筛选</el-button>
        </el-form-item>
      </el-form>
    </section>

    <section v-if="mergeStore.batches.length" class="gb-panel merge-batches">
      <h2 class="gb-panel__title">
        合并处理清单
        <el-tag
          v-if="mergeStore.pendingCount"
          size="small"
          type="danger"
          effect="plain"
          class="merge-batches__badge"
        >
          {{ mergeStore.pendingCount }} 项待处理
        </el-tag>
        <el-button
          v-if="mergeStore.batches.some((b) => b.status === 'done')"
          size="small"
          link
          type="info"
          class="merge-batches__clear"
          @click="clearDoneBatches"
        >
          清除已完成
        </el-button>
      </h2>
      <el-table :data="mergeStore.batches" border stripe size="small">
        <el-table-column label="主档" min-width="160">
          <template #default="{ row }">
            {{ row.masterSnapshot?.pmNo }} {{ row.masterSnapshot?.office }}
          </template>
        </el-table-column>
        <el-table-column label="次档" min-width="160">
          <template #default="{ row }">
            {{ row.secondarySnapshot?.pmNo }} {{ row.secondarySnapshot?.office }}
          </template>
        </el-table-column>
        <el-table-column label="受影响封" width="110" align="center">
          <template #default="{ row }">{{ row.affectedCoverIds?.length ?? 0 }} 封</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="mergeStatusType(row.status)" effect="plain">
              {{ mergeStatusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" min-width="160">
          <template #default="{ row }">
            <span v-if="row.status === 'failed'" class="merge-batches__error">{{ row.error }}</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="240">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="viewBatch(row)">查看</el-button>
            <el-button
              v-if="row.status === 'failed' || row.status === 'pending'"
              size="small"
              link
              type="primary"
              @click="retryMerge(row)"
            >
              {{ row.status === 'failed' ? '重试' : '应用' }}
            </el-button>
            <el-button size="small" link type="danger" @click="removeMerge(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <p v-if="!filtered.length" class="gb-empty">没有符合当前条件的邮戳，试试放宽年代区间或清空戳型。</p>

    <div v-else-if="viewMode === 'wall'" class="gb-grid">
      <StampCard
        v-for="pm in filtered"
        :key="pm.id"
        :postmark="pm"
        :active="current?.id === pm.id"
        @select="showDetail"
      />
    </div>

    <el-table v-else :data="filtered" border stripe @row-click="showDetail">
      <el-table-column prop="pmNo" label="编目号" width="120" />
      <el-table-column prop="type" label="戳型" width="130" />
      <el-table-column prop="office" label="使用局所" min-width="160" />
      <el-table-column prop="province" label="省份" width="90" />
      <el-table-column label="使用年代" width="120">
        <template #default="{ row }">{{ row.yearFrom }}-{{ row.yearTo }}</template>
      </el-table-column>
      <el-table-column prop="dateOnStamp" label="戳面日期" width="120" />
      <el-table-column label="戳径" width="90">
        <template #default="{ row }">{{ row.diameter }}mm</template>
      </el-table-column>
      <el-table-column prop="inkColor" label="墨色" width="80" />
      <el-table-column label="稀见度" width="100">
        <template #default="{ row }">
          <ScarceTag :level="row.scarceLevel" />
        </template>
      </el-table-column>
      <el-table-column label="操作" width="190">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click.stop="showDetail(row)">查看</el-button>
          <el-button size="small" link type="primary" @click.stop="generateSample(row)">
            生成戳样条目
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" title="新增邮戳" width="720px">
      <el-form label-width="104px" label-position="right">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="编目号">
              <el-input v-model="form.pmNo" placeholder="留空自动生成" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="戳型">
              <el-select v-model="form.type" style="width: 100%">
                <el-option v-for="t in POSTMARK_TYPES" :key="t" :label="t" :value="t" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="使用局所">
              <el-input v-model="form.office" placeholder="如 上海邮政总局" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="省份">
              <el-select v-model="form.province" placeholder="选择省份" clearable style="width: 100%">
                <el-option v-for="p in PROVINCES" :key="p" :label="p" :value="p" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="年代起">
              <el-input-number v-model="form.yearFrom" :min="1800" :max="2100" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="年代止">
              <el-input-number v-model="form.yearTo" :min="1800" :max="2100" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="戳面日期">
              <el-date-picker
                v-model="form.dateOnStamp"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="戳面所注日期"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="墨色">
              <el-select v-model="form.inkColor" style="width: 100%">
                <el-option v-for="c in INK_COLORS" :key="c" :label="c" :value="c" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="戳径(mm)">
              <el-input-number v-model="form.diameter" :min="10" :max="90" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="稀见度">
              <el-select v-model="form.scarceLevel" style="width: 100%">
                <el-option v-for="s in SCARCE_LEVELS" :key="s" :label="s" :value="s" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="上格">
              <el-input v-model="form.lettering.top" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="中格">
              <el-input v-model="form.lettering.middle" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="下格">
              <el-input v-model="form.lettering.bottom" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="中英双文字">
              <el-switch v-model="form.bilingual" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="戳样图">
              <el-upload
                :auto-upload="false"
                :show-file-list="false"
                accept="image/*"
                :on-change="onFileChange"
              >
                <el-button>选择戳样图</el-button>
              </el-upload>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input v-model="form.note" type="textarea" :rows="2" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <div class="postmark-page__footer">
          <span class="postmark-page__draft">
            {{ draftHint ? '表单草稿已存入浏览器 localStorage' : '未保存草稿' }}
          </span>
          <span>
            <el-button link type="info" @click="discardDraft">清除草稿</el-button>
            <el-button @click="dialogVisible = false">取消</el-button>
            <el-button type="primary" @click="submit">保存邮戳</el-button>
          </span>
        </div>
      </template>
    </el-dialog>

    <el-drawer v-model="detailVisible" title="邮戳档案" size="460px">
      <div v-if="current" class="postmark-page__detail">
        <div class="gb-figure">
          <img v-if="current.imageDataUrl" :src="current.imageDataUrl" :alt="`${current.pmNo} 戳样`" />
          <span v-else class="postmark-page__no-image">暂无戳样图</span>
        </div>
        <h3 class="gb-panel__title">{{ current.pmNo }} · {{ current.type }}</h3>
        <ScarceTag :level="current.scarceLevel" />
        <dl class="gb-facts">
          <div><dt>使用局所</dt><dd>{{ current.office }}</dd></div>
          <div><dt>省份</dt><dd>{{ current.province || '待考' }}</dd></div>
          <div><dt>使用年代</dt><dd>{{ current.yearFrom }}-{{ current.yearTo }}</dd></div>
          <div><dt>戳面日期</dt><dd>{{ current.dateOnStamp || '未注' }}</dd></div>
          <div><dt>戳径</dt><dd>{{ current.diameter }} mm</dd></div>
          <div><dt>墨色</dt><dd>{{ current.inkColor }}</dd></div>
          <div><dt>戳面文字</dt><dd>{{ current.lettering.top }} / {{ current.lettering.middle }} / {{ current.lettering.bottom }}</dd></div>
          <div><dt>文字</dt><dd>{{ current.bilingual ? '中英双文字' : '单文字' }}</dd></div>
        </dl>
        <p class="postmark-page__note">{{ current.note || '暂无备注' }}</p>
        <div class="postmark-page__detail-actions">
          <el-button type="primary" plain @click="generateSample(current)">生成戳样条目</el-button>
          <el-button plain @click="openMergeWith(current)">合并此邮戳</el-button>
        </div>
      </div>
    </el-drawer>

    <el-dialog v-model="sampleVisible" title="戳样条目" width="560px">
      <el-input v-model="sampleText" type="textarea" :rows="10" readonly />
      <template #footer>
        <el-button @click="sampleVisible = false">关闭</el-button>
        <el-button type="primary" @click="copySample">复制条目</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchDetailVisible" title="合并批次详情" width="620px">
      <div v-if="currentBatch" class="batch-detail">
        <div class="batch-detail__sides">
          <div class="batch-detail__side">
            <h4>主档（保留）</h4>
            <p>{{ currentBatch.masterSnapshot?.pmNo }} · {{ currentBatch.masterSnapshot?.office }}</p>
            <p class="batch-detail__meta">{{ currentBatch.masterSnapshot?.type }} · {{ currentBatch.masterSnapshot?.yearFrom }}-{{ currentBatch.masterSnapshot?.yearTo }}</p>
          </div>
          <div class="batch-detail__side">
            <h4>次档（合并后删除）</h4>
            <p>{{ currentBatch.secondarySnapshot?.pmNo }} · {{ currentBatch.secondarySnapshot?.office }}</p>
            <p class="batch-detail__meta">{{ currentBatch.secondarySnapshot?.type }} · {{ currentBatch.secondarySnapshot?.yearFrom }}-{{ currentBatch.secondarySnapshot?.yearTo }}</p>
          </div>
        </div>

        <h4 class="batch-detail__section">字段保留方</h4>
        <el-table :data="Object.keys(currentBatch.fieldChoices || {})" border stripe size="small">
          <el-table-column label="字段" min-width="140">
            <template #default="{ row }">{{ fieldLabel(row) }}</template>
          </el-table-column>
          <el-table-column label="保留方" min-width="120">
            <template #default="{ row }">
              <el-tag size="small" :type="currentBatch.fieldChoices[row] === 'secondary' ? 'warning' : 'success'" effect="plain">
                {{ choiceLabel(currentBatch, row) }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <p v-if="!Object.keys(currentBatch.fieldChoices || {}).length" class="batch-detail__empty">
          无冲突字段，全部保留主档。
        </p>

        <h4 class="batch-detail__section">受影响实寄封（{{ currentBatch.affectedCoverIds?.length ?? 0 }} 封）</h4>
        <p class="batch-detail__covers">
          <span v-for="(id, i) in currentBatch.affectedCoverIds || []" :key="id">
            {{ pmLabelOf(id) }}<span v-if="i < (currentBatch.affectedCoverIds?.length ?? 0) - 1">、</span>
          </span>
        </p>

        <p v-if="currentBatch.status === 'failed'" class="batch-detail__error">
          失败原因：{{ currentBatch.error }}
        </p>
      </div>
      <template #footer>
        <el-button @click="batchDetailVisible = false">关闭</el-button>
        <el-button
          v-if="currentBatch && (currentBatch.status === 'failed' || currentBatch.status === 'pending')"
          type="primary"
          @click="retryMerge(currentBatch); batchDetailVisible = false"
        >
          {{ currentBatch.status === 'failed' ? '重试' : '应用' }}
        </el-button>
      </template>
    </el-dialog>

    <MergeDialog v-model="mergeDialogVisible" :preset-master-id="presetMasterId" @applied="onMergeApplied" />
  </div>
</template>

<style scoped>
.postmark-page__actions {
  display: flex;
  gap: 10px;
  align-items: center;
}
.postmark-page__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.postmark-page__draft {
  font-size: 12px;
  color: var(--gb-muted);
}
.postmark-page__detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.postmark-page__no-image {
  font-size: 12px;
  color: var(--gb-muted);
}
.postmark-page__note {
  font-size: 13px;
  color: var(--gb-muted);
  line-height: 1.6;
}
.postmark-page__detail-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.merge-batches__badge {
  margin-left: 8px;
}
.merge-batches__clear {
  margin-left: 12px;
}
.merge-batches__error {
  font-size: 12px;
  color: #b02a1e;
}
.batch-detail__sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 14px;
}
.batch-detail__side {
  padding: 10px;
  border: 1px solid var(--gb-line);
  border-radius: 8px;
  background: #fffdf8;
}
.batch-detail__side h4 {
  margin: 0 0 6px;
  font-size: 13px;
  color: #5d3325;
}
.batch-detail__side p {
  margin: 2px 0;
  font-size: 13px;
}
.batch-detail__meta {
  color: var(--gb-muted);
  font-size: 12px !important;
}
.batch-detail__section {
  margin: 12px 0 6px;
  font-size: 14px;
  color: #5d3325;
}
.batch-detail__empty {
  font-size: 12px;
  color: var(--gb-muted);
}
.batch-detail__covers {
  font-size: 13px;
  color: #5d3325;
}
.batch-detail__error {
  margin-top: 12px;
  padding: 8px 10px;
  font-size: 12px;
  color: #b02a1e;
  background: #fdf3ef;
  border-radius: 8px;
}
</style>
