# 对话运行时规范（Conversation Runtime）

## 1. 状态机与并发

`idle → running → idle | failed`

- 加载对话时若持久化状态是 `running`，必须重置为 `idle`（`ConversationSession` 构造器），避免僵尸状态。
- **同一项目同时只允许一个对话生成**：`SessionManager.runTurn` 用 `projectId → conversationId` 场景锁串行化；被占用时直接报错，不排队。
- 不同项目可并行：每个对话拥有独立消息历史、事件订阅与 AbortController。
- 同一对话执行中再次 `start` / `sendUserMessage` 必须报错。

## 2. 循环与终止

- 使用 AI SDK v7 `streamText`，`stopWhen: [isStepCount(maxSteps), hasToolCall('finish')]`。
- `finish` 是唯一正常完成信号；步数耗尽也以 `idle` 结束（不是失败），但提示词必须要求模型主动 `finish`。
- 流中的 `error` part 必须转成 `failed` + `conversation.error` + error timeline。
- 事件监听器抛错不得中断 Run（`emit` 内已隔离）。

## 3. 模型切换

- `ConversationSession.update({ providerProfileId?, model?, resetContext? })` 负责切换；生成中禁止修改。
- 每轮开始时解析当前 Provider/模型，因此切换后下一条消息生效。
- `resetContext: true` 清空 `modelMessages`（保留聊天记录与场景操作）；`false` 保留上下文。
- 跨 Provider 且保留上下文时，发送前必须剥离 `reasoning` parts（避免目标 Provider 拒绝），不得剥离图片。

## 4. 客户端工具

- 执行前 `requirePreview()`（项目级预览）；无预览时快速失败，提示用户打开预览面板。
- 超时 `CLIENT_TOOL_TIMEOUT_MS`（默认 60s）；收到 `client.tool_ack` 时重置计时；超时、取消或回合结束都必须清理 pending 定时器并 reject，超时或取消时同时广播 `tool.cancel`。
- 工具失败是模型可见的工具结果，不是回合失败；模型应读取 `error_code` / `suggestion` 后重试。

## 5. 取消

- `cancel()` 触发 `abortController.abort()`，并立即 reject 所有 pending 客户端工具（同时广播 `tool.cancel`），避免 run 循环被工具执行阻塞而延迟停止；循环捕获后状态置 `idle`，`finally` 中 `rejectAllPending` 兜底。
- 取消后必须发送 `conversation.turn_finished`，前端据此结束 loading 状态。

## 6. 用量与持久化

- 每个 `finish-step` 累加 `usage`（含 reasoning / cached tokens）并推送 `usage` 事件。
- 消息创建 / 更新立即写库；timeline 与 `conversation_state` 走 400ms 防抖。
- 每轮结束（含取消/失败）发出 `conversation.turn_finished` 后，预览客户端必须导出当前场景 GLB 并发送 `scene.snapshot`；服务端 upsert `project_scenes`（见 [persistence.md](./persistence.md) §6）。
- `modelMessages` 必须完整持久化，以支持同一对话继续与跨模型保留上下文。
- 场景写入（操作日志、产物）必须委托 `ProjectHub`，禁止对话直接写项目级数据。

## 7. 提示词

- `buildSystemPrompt` 必须与工具集保持同步；新增工具、修改返回协议或工作流时必须更新。
- 提示词固定声明模型可查看 `capture_viewport` 截图（系统只支持视觉模型）；`hasPreview` 决定是否提示预览未连接。

## 8. 验证要求

- 修改循环、工具接线、协议：`pnpm --filter @llm3d/server smoke`（离线、确定性）。
- 修改 provider 交互、视觉输出、真实工具调用：`apps/server/scripts/live-test.mjs`。
- 不得只靠 `pnpm typecheck` 验证 Agent 行为。
