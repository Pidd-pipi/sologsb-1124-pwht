<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useMergeStore } from '@/stores/mergeStore'
import type { MergeTask } from '@/types/merge'

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{
  'update:visible': [value: boolean]
  /** 请求打开合并核对对话框（迁移建议 / 想重新核对时） */
  review: [taskId: number]
  /** 数据可能已变化，请父组件刷新各 store */
  changed: []
}>()

const mergeStore = useMergeStore()
const busyId = ref<number | null>(null)
const filterStatus = ref<'' | 'active' | 'failed' | 'done'>('active')

const drawerVisible = computed({
  get: () => props.visible,
  set: (v) => emit('update:visible', v)
})

const shownTasks = computed(() => {
  const all = [...mergeStore.list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (filterStatus.value === 'active') {
    return all.filter((t) => t.status === 'pending' || t.status === 'failed' || t.status === 'running')
  }
  if (filterStatus.value === 'failed') return all.filter((t) => t.status === 'failed')
  if (filterStatus.value === 'done') return all.filter((t) => t.status === 'done')
  return all
})

const runnableCount = computed(
  () =>
    mergeStore.list.filter(
      (t) =>
        (t.status === 'pending' || t.status === 'failed') &&
        !(t.kind === 'merge' && !t.snapshot)
    ).length
)

const STATUS_TAG: Record<
  MergeTask['status'],
  { type: 'info' | 'warning' | 'danger' | 'success'; text: string }
> = {
  pending: { type: 'warning', text: '待处理' },
  running: { type: 'info', text: '执行中' },
  failed: { type: 'danger', text: '写入失败' },
  done: { type: 'success', text: '已完成' }
}

function needsReview(task: MergeTask): boolean {
  return task.kind === 'merge' && !task.snapshot
}

function actionLabel(task: MergeTask): string {
  if (task.kind === 'linkDedup') return '去重处理'
  return needsReview(task) ? '逐项核对' : '重试续跑'
}

async function runTask(task: MergeTask): Promise<void> {
  if (typeof task.id !== 'number') return
  if (task.kind === 'merge' && !task.snapshot) {
    emit('review', task.id)
    drawerVisible.value = false
    return
  }
  busyId.value = task.id
  try {
    const result = await mergeStore.execute(task.id)
    if (result?.status === 'done') {
      ElMessage.success(`批次 ${task.batchNo} 已完成`)
      emit('changed')
    } else {
      ElMessage.error(`批次 ${task.batchNo} 仍未完成：${result?.lastError ?? '未知错误'}（已保留待重试）`)
    }
  } finally {
    busyId.value = null
  }
}

async function reviewTask(task: MergeTask): Promise<void> {
  if (typeof task.id !== 'number') return
  emit('review', task.id)
  drawerVisible.value = false
}

async function retryAll(): Promise<void> {
  await mergeStore.retryAll()
  emit('changed')
  const left = mergeStore.list.filter((t) => t.status === 'failed').length
  if (left > 0) ElMessage.warning(`仍有 ${left} 个批次写入失败，已保留可继续重试`)
  else ElMessage.success('可执行批次均已处理完毕')
}

async function discard(task: MergeTask): Promise<void> {
  if (typeof task.id !== 'number') return
  if (task.status !== 'done') {
    await ElMessageBox.confirm(
      `确定把批次 ${task.batchNo} 移出处理清单？未完成的合并 / 去重不会对数据生效，移出后需重新发起。`,
      '移出处理清单',
      { type: 'warning', confirmButtonText: '移出', cancelButtonText: '取消' }
    )
  }
  await mergeStore.discard(task.id)
  ElMessage.success('已移出处理清单')
}
</script>

<template>
  <el-drawer
    :model-value="drawerVisible"
    title="邮戳合并处理清单"
    size="640px"
    @update:model-value="drawerVisible = $event"
  >
    <div class="merge-queue__head">
      <el-radio-group v-model="filterStatus" size="small">
        <el-radio-button value="active">待处理</el-radio-button>
        <el-radio-button value="failed">失败</el-radio-button>
        <el-radio-button value="done">已完成</el-radio-button>
        <el-radio-button value="">全部</el-radio-button>
      </el-radio-group>
      <el-button
        size="small"
        type="primary"
        plain
        :disabled="runnableCount === 0"
        @click="retryAll"
      >
        一键重试（{{ runnableCount }}）
      </el-button>
    </div>
    <p class="merge-queue__intro">
      合并写入中途失败的批次、旧数据升级发现的重复档案与重复关联都在此清单；失败批次按已完成步骤断点续跑。
    </p>

    <p v-if="!shownTasks.length" class="gb-empty">该分类下暂无处理项。</p>

    <ul v-else class="merge-queue__list">
      <li v-for="task in shownTasks" :key="task.id" class="merge-queue__item">
        <div class="merge-queue__item-head">
          <span class="merge-queue__no">{{ task.batchNo }}</span>
          <el-tag size="small" :type="STATUS_TAG[task.status].type" effect="dark">
            {{ STATUS_TAG[task.status].text }}
          </el-tag>
          <el-tag size="small" :type="task.kind === 'merge' ? 'warning' : 'info'" effect="plain">
            {{ task.kind === 'merge' ? '邮戳合并' : '关联去重' }}
          </el-tag>
          <el-tag v-if="task.source === 'migration'" size="small" type="success" effect="plain">
            升级发现
          </el-tag>
          <el-tag v-else size="small" type="info" effect="plain">手动发起</el-tag>
        </div>
        <p class="merge-queue__title">{{ task.title }}</p>
        <p class="merge-queue__note">{{ task.note }}</p>
        <p v-if="task.lastError" class="merge-queue__error">失败原因：{{ task.lastError }}</p>
        <p v-if="task.attempts > 0" class="merge-queue__meta">
          已尝试 {{ task.attempts }} 次 ·
          {{ task.kind === 'merge' && task.doneSteps.length ? `已完成 ${task.doneSteps.length}/5 步 · ` : '' }}
          {{ new Date(task.updatedAt).toLocaleString() }}
        </p>
        <div class="merge-queue__actions">
          <el-button
            v-if="task.status !== 'done'"
            size="small"
            type="primary"
            :loading="busyId === task.id"
            @click="runTask(task)"
          >
            {{ actionLabel(task) }}
          </el-button>
          <el-button
            v-if="task.kind === 'merge' && task.status !== 'done' && task.snapshot"
            size="small"
            @click="reviewTask(task)"
          >
            重新核对
          </el-button>
          <el-button size="small" link type="info" @click="discard(task)">
            {{ task.status === 'done' ? '清掉记录' : '放弃并移出' }}
          </el-button>
        </div>
      </li>
    </ul>
  </el-drawer>
</template>

<style scoped>
.merge-queue__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.merge-queue__intro {
  font-size: 12px;
  color: var(--gb-muted);
  margin: 0 0 14px;
}
.merge-queue__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 12px;
}
.merge-queue__item {
  border: 1px solid var(--gb-line);
  border-radius: 10px;
  background: #fffdf8;
  padding: 10px 12px;
}
.merge-queue__item-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.merge-queue__no {
  font-weight: 700;
  color: #5d3325;
  font-size: 13px;
}
.merge-queue__title {
  margin: 2px 0;
  font-size: 13px;
  font-weight: 600;
}
.merge-queue__note {
  margin: 2px 0;
  font-size: 12px;
  color: var(--gb-muted);
  line-height: 1.6;
}
.merge-queue__error {
  margin: 4px 0 0;
  font-size: 12px;
  color: #b02a1e;
  background: #fdecea;
  border-radius: 6px;
  padding: 4px 8px;
}
.merge-queue__meta {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--gb-muted);
}
.merge-queue__actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
</style>
