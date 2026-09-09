# 持久化规范（SQLite）

## 1. 存储与位置

- SQLite（better-sqlite3 + Drizzle），启用 WAL、外键与 5s `busy_timeout`（`apps/server/src/db/client.ts`）。
- 表结构：`apps/server/src/db/schema.ts`；仓储：`apps/server/src/db/repositories.ts`。
- `DATABASE_PATH` 相对 `process.cwd()` 解析；服务端脚本必须从 `apps/server` 运行，本地文件位于 `apps/server/data/llm3d.sqlite`（gitignored）。

## 2. 表与归属

| 表 | 归属 | 说明 |
| --- | --- | --- |
| `projects` | — | 一个项目 = 一个场景 |
| `conversations` | 项目 | 对话 + 当前 `provider_profile_id` / `model` / `config` / `status` |
| `messages` | 对话 | 聊天记录，`seq` 按对话递增 |
| `project_scenes` | **项目** | 场景权威状态：最新 GLB 快照 + 灯光配置，每轮生成结束时由预览客户端上传 |
| `scene_operations` | **项目** | 场景操作审计日志（只读历史），`seq` 按项目递增；`conversation_id` 可空，仅作溯源 |
| `artifacts` | **项目** | GLB / 截图等产物；`conversation_id` 可空，仅作溯源 |
| `conversation_state` | 对话 | `model_messages` / `timeline` / `usage` 缓存 |
| `provider_profiles` | — | Provider 配置；无 `supports_vision`（系统只支持视觉模型） |

## 3. 迁移

- 迁移是 `apps/server/src/db/migrate.ts` 中的幂等 SQL；禁止引入 drizzle-kit 生成的迁移文件（`drizzle-kit` 仅作为开发工具存在，不参与运行）。
- 每条迁移语句必须可重复执行。
- `CREATE TABLE IF NOT EXISTS` 不会修改已存在的表。新增 / 修改列时必须：
  - 显式编写 `ALTER TABLE ...`（需处理「列已存在」的情况），或
  - 在变更说明中明确要求删除本地数据库文件。
- 当前没有 schema 版本表与数据迁移机制；破坏性变更必须在 PR 中说明影响。

## 4. 级联与删除

- `projects` → `conversations` / `project_scenes` / `scene_operations` / `artifacts` 全部 `ON DELETE CASCADE`。
- `conversations` → `messages` / `conversation_state` 级联删除；`scene_operations.conversation_id` 与 `artifacts.conversation_id` 为 `ON DELETE SET NULL`，即**删除对话不会删除场景操作与产物**（它们属于项目场景）。
- 删除项目会连带删除其所有对话、场景与产物，这是有意设计。

## 5. 序号（seq）

- `messages.seq` 按对话内 `MAX(seq)+1`；`scene_operations.seq` 按**项目内** `MAX(seq)+1`。
- 都不是全局序号；分配由单进程内串行调用保证，禁止多进程并发写同一个 DB 文件。

## 6. 场景状态与操作日志

- `project_scenes` 是项目场景的**唯一权威来源**：每轮生成结束时（含取消/失败），预览客户端从沙箱导出 GLB 并发送 `scene.snapshot`；服务端校验 GLB 魔数后按项目 upsert。
- 预览挂载或切换项目时必须加载 `project_scenes` 的 GLB（`GET /api/projects/:id/scene`），禁止再用操作日志重建场景。
- `scene_operations` 只记录成功的 mutating 工具（`result.success !== false`），作为审计历史展示；不再用于回放，也不影响场景状态。
- 审计日志默认**只追加**：禁止更新单条操作；项目删除时级联清理。唯一删除路径为 `POST /api/projects/:id/operations/prune`（body `{ ids }`），必须校验 id 属于该项目；删除后广播 `scene.operations_pruned`。
- `input` / `result` 必须是可 JSON 序列化的纯数据；禁止存 Buffer、函数或循环引用。
- GLB 快照大小受 `MAX_ARTIFACT_BYTES` 限制，超限必须拒绝写入。灯光配置（`SetupLightingInput`）随快照保存在 `project_scenes.lighting`，因为 glTF 无法表达 Three.js 灯光。

## 7. 产物

- 二进制内容存 `artifacts.data`（BLOB）；列表 / 查询接口不得返回 `data`，只通过 `getData(id)` 获取。
- 单产物大小受 `MAX_ARTIFACT_BYTES`（默认 12MB）限制，超限必须拒绝写入。
- 文件名必须净化，禁止路径穿越；下载响应必须使用存储的 mime。

## 8. 对话状态缓存

- `conversation_state.model_messages` / `timeline` / `usage` 是缓存，用于断点续跑与上下文保留；`messages` 与 `scene_operations` 才是权威数据。
- 切换模型选择「清空上下文」时，只清 `model_messages`，不得删除 `messages` 或场景操作。
- 保存采用 400ms 防抖（`schedulePersist`）；崩溃最多丢失 400ms 的 timeline 增量。
