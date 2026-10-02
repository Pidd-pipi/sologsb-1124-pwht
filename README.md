# 邮戳与实寄封编目台（gbpostmark）

面向邮品收藏者与邮政史研究者：为邮戳、邮路和实寄封建编目，记录戳型、使用年代、邮路节点与封上票戳组合，并以时间轴还原一封邮件的实际寄递过程。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21824>

停止（保留镜像）：

```bash
docker compose down
```

> 若 21824 端口被占用，修改 `.env` 中的 `FRONTEND_PORT` 后重新执行上面两条命令即可。

## 二、技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + 组合式 API） |
| 语言 | TypeScript（`strict`，构建时 `vue-tsc` 类型检查零错误） |
| 构建 | Vite 6 |
| UI | Element Plus + `@element-plus/icons-vue` |
| 状态 | Pinia（`postmarkStore` / `coverStore` / `routeStore` / `mergeStore`） |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地数据 | IndexedDB（Dexie，含版本号与升级迁移）+ localStorage（表单草稿） |
| 托管 | nginx:alpine（gzip + SPA 回退） |

### 邮戳档案合并（错录另建的归并）

邮戳目录提供「合并邮戳」向导与「合并处理清单」：

1. **并排核对**：选定主档（保留）与被合并邮戳（删除），两枚邮戳的戳型、局所、年代（起/止）、戳面日期、墨色、戳径、稀见度、戳面文字三格、中英双文、备注与**戳样图**逐行并排；一致字段直接沿用，冲突字段由操作者逐项单选保留哪边（支持一键全取一侧、互换主从），编目号固定保留主档。
2. **确认执行**：主档写入取舍结果后，把所有实寄封对被并档的 `cancelPmIds` 关联转到主档并去重，assets 表中的戳样原图按选择搬运，最后删除被并档案。实寄封详情的票戳组合与综合检索随即全部按主档显示。
3. **中途失败保留批次**：合并拆成「写回主档 → 转关联 → 搬原图 → 删旧档 → 完结」五步，每步独立事务并登记 `doneSteps`；任一步写入失败，批次留在处理清单（failed + 原因），重试从首个未完成步骤断点续跑，已完成步骤幂等；支持单项重试与一键重试。
4. **旧数据升级兼容**：数据库升级到 v3 时不自动改动数据，而是把发现的问题写入**同一份处理清单**：同一实寄封 `cancelPmIds` 中的字面重复关联（关联去重任务）、同编目号或同戳型局所且年代重叠的疑似重复邮戳（逐对合并建议，仍需操作者逐项核对确认）。

## 三、核心数据模型

| 模型 | 文件 | 说明 |
| --- | --- | --- |
| Postmark 邮戳 | `frontend/src/types/postmark.ts` | 编目号、戳型、局所、省份、使用年代、戳面日期、墨色、戳径、戳面文字、中英双文字、稀见度、戳样图、备注 |
| Cover 实寄封 | `frontend/src/types/cover.ts` | 封号、寄出/收件地、寄出/到达日期、贴票构成、关联邮戳、邮路、中转地、给据、品相、来源、购入价、藏册页位 |
| PostalRoute 邮路 | `frontend/src/types/route.ts` | 邮路号、名称、时期、运输方式、节点数组（局所/到达日期/中转戳）、全程天数、班期、备注 |
| StamplessEntry 票戳组合 | `frontend/src/types/stampentry.ts` | 所属封、邮票名称、面值、发行年份、齿度、变体、封上位置 |

另有 `frontend/src/types/asset.ts`：戳样与封的正反面原图在 IndexedDB 中**单独建表**（`assets`）。
`frontend/src/types/merge.ts`：邮戳合并处理清单 `MergeTask`（手动合并、写入失败待重试批次、升级迁移发现的重复关联共用同一结构，按步骤断点续跑）。

## 四、页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/` | 重定向到 `/postmarks` | — |
| `/postmarks` | 邮戳目录（按戳型、局所、年代区间筛选，图片墙 ↔ 列表切换） | Postmark |
| `/covers` | 实寄封目录（按收寄地、年代、品相、是否给据筛选，行内显示贴票枚数与关联邮戳数） | Cover |
| `/covers/:id` | 实寄封详情（正反面图、票戳组合表、寄递事实时间轴） | Cover、StamplessEntry、PostalRoute |
| `/routes/:id` | 邮路编辑器（节点拖拽排序、增删中转地、按节点日期自动算全程天数） | PostalRoute |
| `/search` | 综合检索（跨三类按关键词与年代分组检索） | Postmark、Cover、PostalRoute |

## 五、共享组件与 hooks / utils

- 组件：`frontend/src/components/common/` 下的 `StampCard.vue`、`CoverCard.vue`、`RouteTimeline.vue`、`ScarceTag.vue`；`frontend/src/components/merge/` 下的 `PostmarkMergeDialog.vue`（并排核对向导）、`MergeQueueDrawer.vue`（处理清单）
- hooks：`frontend/src/hooks/useCatalogFilter.ts`（统一过滤与排序）、`frontend/src/hooks/useCoverRoute.ts`（寄递时间轴与在途天数）
- utils：`frontend/src/utils/db.ts`（Dexie 封装/版本迁移/样例数据）、`frontend/src/utils/mergeFields.ts`（合并字段核对与重复档案探测）、`frontend/src/utils/mergeRunner.ts`（分步可续跑的合并执行器）、`frontend/src/utils/dateRange.ts`（年代区间、干支互转、日期先后校验）、`frontend/src/utils/id.ts`（编目号与唯一键）、`frontend/src/utils/draft.ts`（localStorage 草稿）

## 六、本地开发（可选，需要本机 Node 20+）

```bash
cd frontend
npm install
npm run dev          # http://localhost:21824
npm run build        # vue-tsc 类型检查 + vite 构建
```

## 七、目录结构

```
sologsb-1124/
├── docker-compose.yml
├── .env.example / .env
├── README.md
└── frontend/
    ├── Dockerfile          # node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf          # try_files + gzip
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/          # postmark / cover / route / stampentry / asset
        ├── stores/         # postmarkStore / coverStore / routeStore
        ├── components/common/
        ├── hooks/
        ├── pages/
        ├── router/
        ├── utils/
        ├── styles/
        ├── App.vue
        └── main.ts
```

## 八、数据存储说明

- **编目数据**：IndexedDB（Dexie，库名 `gbpostmark`）。表结构含版本号，`version(2)` 会把戳样与封图迁移到独立的 `assets` 表并补齐历史记录缺省字段；`version(3)` 新增 `mergeTasks` 合并处理清单表，并在升级时扫描出重复邮戳档案与实寄封中的重复邮戳关联，以待处理任务形式入清单（不自动改动数据，全部由操作者核对确认）。首次运行写入样例数据，便于直接查看各页面效果。
- **表单草稿**：localStorage，键名前缀 `gbpostmark:draft:`（邮戳、实寄封、邮路各一份），刷新或误关页面后可恢复，可一键清除。
- **无后端**：不请求任何外部接口，容器无状态，不使用数据库服务与命名卷；清除浏览器站点数据即等于清空数据。
