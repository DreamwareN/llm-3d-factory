# 协议规范（WebSocket & REST）

适用范围：浏览器 ↔ 服务器。浏览器内部（宿主 ↔ 沙箱 iframe）另见 [sandbox.md](./sandbox.md)。

## 1. 信封与校验

- 所有 WS 消息使用统一信封 `{ v: 2, id, ts }`，定义与构造在 `packages/shared/src/protocol.ts`。
- 客户端 → 服务端消息必须通过 `clientMessageSchema`（zod）校验；校验失败时服务端只记录 warn 并丢弃，不得抛异常。
- 服务端 → 客户端消息是 TypeScript 联合类型，不做运行时校验；因此任何字段改动必须同时修改 `protocol.ts` 与 `apps/web/src/stores/useAppStore.ts` 的消费分支。

## 2. 版本规则

- `v` 当前为 2，没有协商机制。
- `PROTOCOL_VERSION` 定义在 `packages/shared/src/version.ts`，同时从包入口与 `@llm3d/shared/version` 子路径导出；`protocol.ts` 的 `z.literal` 与 `makeEnvelope` 必须引用它。前端 WS 客户端（`apps/web/src/lib/ws.ts`）必须从子路径导入并盖在 `v` 上，禁止硬编码（从入口导入会把 zod 打进浏览器包）。
- 新增消息类型必须是增量变更，禁止复用或重命名已有 `type` 字符串。
- 破坏性改动必须提升 `PROTOCOL_VERSION`，并在同一变更中更新服务端与前端；本项目不支持新旧版本混部。

## 3. 订阅模型

- 场景事件按**项目**订阅与广播：`scene.updated`、`scene.operation`、`scene.operations_pruned`、`artifact.created`、`tool.client_request`。
- 对话事件按**对话**订阅与推送：`message.*`、`timeline.*`、`usage`、`conversation.*`。
- 客户端必须先 `project.subscribe` 才能收到该项目的场景事件；必须先 `conversation.subscribe` 才能收到该对话的聊天事件。

## 4. 关键语义

- `project.subscribe`：成功后服务端先发 `project.snapshot`（项目、对话元数据、场景 GLB 元数据 `scene`、场景操作审计、产物），再推送场景增量事件。
- `conversation.subscribe`：成功后服务端先发 `conversation.snapshot`（消息、时间线、用量、待处理客户端工具），再推送增量事件；客户端重连只需重新订阅。
- `scene.snapshot`：客户端 → 服务端，携带当前场景 GLB（`dataBase64`）与灯光配置；仅接受已 `project.subscribe` 的连接，服务端校验 GLB 魔数后 upsert `project_scenes` 并广播 `scene.updated`。每轮 `conversation.turn_finished` 后由预览客户端发送。
- `scene.updated`：服务端 → 客户端，广播项目场景快照元数据（`updatedAt` / `size` / `lighting`）。
- `conversation.start` / `conversation.user_message`：同一项目同时只允许一个对话生成；被占用时服务端发 `error`，不得排队。
- `tool.client_request`：只发送给该项目的 `preview.ready` 连接（`apps/server/src/ws/gateway.ts`），其他订阅者不得收到。
- `client.tool_ack`：客户端收到请求后立即回执（即使沙箱尚未就绪）；服务端据此重置该请求的超时计时。
- `tool.cancel`：服务端在请求超时或对话取消后广播；客户端必须丢弃尚未开始执行的同 `requestId` 请求，避免超时/取消后仍产生无记录的场景变更。
- `client.tool_result`：以 `requestId` 关联，归属对话由 `conversationId` 指定；未知或过期的 `requestId` 必须静默忽略。
- `preview.ready` / `preview.detach`：维护「哪个连接正在渲染哪个项目场景」；连接断开时服务端自动 detach。
- `conversation.status` / `conversation.updated` / `conversation.turn_finished`：状态与元数据变化；`turn_finished` 的 `status` 为 `idle`（正常或取消）或 `failed`。
- `ping` / `pong`：应用层保活；服务端另有 30s 的 WS ping。
- 流式输出：`message.delta` 只用于 `text` / `reasoning` 增量；最终一致内容以 `message.updated` 与 `conversation.snapshot` 为准。

## 5. REST

- 所有 HTTP 端点位于 `/api` 下，请求体必须经 zod 校验（见 `apps/server/src/http/api.ts`），非法输入返回 4xx。
- 项目即场景：`GET /api/projects/:id/operations`、`GET /api/projects/:id/artifacts` 返回项目级数据；`GET /api/projects/:id/scene` 返回当前场景 GLB（`model/gltf-binary`，无快照时 404）。
- 无效操作清理：`POST /api/projects/:id/operations/prune`，body `{ ids: string[] }`；只允许删除属于该项目的操作，成功后返回 `{ removed, operations }` 并广播 `scene.operations_pruned`。
- 对话：`POST /api/projects/:id/conversations`、`GET/PATCH/DELETE /api/conversations/:id`、`POST /api/conversations/:id/cancel`、`GET /api/conversations/:id/snapshot`。
- `PATCH /api/conversations/:id` 支持 `{ title?, providerProfileId?, model?, resetContext? }`；换模型时 `resetContext` 决定是否清空模型上下文（聊天记录保留）。
- 产物下载固定为 `GET /api/artifacts/:id/download`。
- 前端禁止散落 `fetch` / `WebSocket`：统一走 `apps/web/src/lib/api.ts` 与 `apps/web/src/lib/ws.ts`。
