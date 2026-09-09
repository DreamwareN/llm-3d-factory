# 工具契约（Tool Contract）

工具是 Agent 写入场景的唯一入口。RFC-002（`docs/agent_tool_call.md`）定义工具的语义与参数；本规范定义实现侧必须遵守的约束。

## 1. 代码位置（缺一不可）

| 内容 | 位置 |
| --- | --- |
| zod 输入 schema、工具名列表、`MUTATING_TOOL_NAMES` | `packages/shared/src/tools.ts` |
| `ToolExecutionResult` 等结果类型 | `packages/shared/src/domain.ts` |
| 服务端注册、英文描述、`toModelOutput` | `apps/server/src/tools/index.ts` |
| 沙箱实现与 `exec` 分发 | `apps/web/src/sandbox/runtime.ts` |
| 系统提示词 | `apps/server/src/conversation/system-prompt.ts` |
| 工具调用展示 | `apps/web/src/features/chat/ToolCallCard.tsx` |

## 2. 命名与分类

- 工具名一律 `snake_case`，且必须与 `toolInputSchemas` 的键一致。
- 新增 / 删除工具必须同时更新 `MODELING_TOOL_NAMES` 与 `CLIENT_TOOL_NAMES`，并判断是否加入 `MUTATING_TOOL_NAMES`。
- 分类规则：
  - 只读工具（`inspect_scene`、`capture_viewport`）禁止加入 `MUTATING_TOOL_NAMES`。
  - `export_glb` 是客户端工具但属于只读导出，禁止记录为操作。
  - `finish` 是服务端控制工具，禁止出现在 `CLIENT_TOOL_NAMES`。

## 3. 返回契约

- 所有工具必须返回 `ToolExecutionResult` 对象，禁止把 `throw` 当作正常失败路径（异常会被包装成工具错误，丢失 `error_code` / `suggestion`）。
- 失败必须返回 `{ success: false, error_code, error, suggestion? }`；`error` 描述原因，`suggestion` 给出可执行的修复动作。
- 成功时：
  - 创建类工具必须返回 `object_id` 与 `aabb`；
  - 批量 / 变更类工具应返回 `affected_ids` 与最终 `aabb`；
  - `message` 用一句英文描述实际发生的结果。
- `error_code` 使用 `SCREAMING_SNAKE_CASE`。已用值：`OBJECT_NOT_FOUND`、`UNSUPPORTED_PRIMITIVE`、`CSG_REQUIRES_MESH`、`CSG_EVALUATION_FAILED`、`CSG_EMPTY_GEOMETRY`、`EVAL_INVALID_ARGUMENT`、`EVAL_CODE_ERROR`、`UNKNOWN_TOOL`、`TOOL_EXECUTION_ERROR`、`INVALID_CLIENT_RESULT`、`NAME_TAKEN`、`OBJECT_ALREADY_GROUPED`。
- 显式 `name` / `group_name` / `name_prefix` 与已有对象 ID 冲突时必须返回 `NAME_TAKEN`，禁止静默加 `_2` 后缀（回放/重复执行会让模型无法追踪真实 ID）。
- `group_objects` 的成员若已在其他 Group 内，必须返回 `OBJECT_ALREADY_GROUPED`（重复编组会从原 Group 中“偷走”成员，破坏之前的操作记录）。

## 4. 确定性与回放（硬约束）

`MUTATING_TOOL_NAMES` 中的工具会被持久化并按顺序重放，因此：

- 相同输入序列必须产生完全相同的对象 ID 与几何结果。
- 禁止用 `Math.random()`、`Date.now()`、`performance.now()` 等影响几何或 ID 的取值。
- 自动 ID 必须来自 `resetScene()` 会清零的 `idCounters`（`nextId(prefix)`）；显式 `name` 必须优先使用。
- 重放只传入 `{ tool, input }`，不传历史 `result`；工具不得依赖上一次执行留下的外部状态。
- 新增 mutating 工具必须自测：连续两次 `reset + replay` 后，`inspect_scene` 输出一致。

## 5. 客户端工具

- 执行前必须调用 `host.requirePreview()`；无预览连接时快速失败，提示用户打开预览面板。
- 服务端只向该 Run 已发送 `preview.ready` 的连接转发 `tool.client_request`。
- 客户端超时（`CLIENT_TOOL_TIMEOUT_MS`，默认 60s）或断开时，本次工具调用失败；Agent 可重试，但工具应保证重复创建可被发现（如 `inspect_scene` 或稳定命名）。
- 浏览器收到请求后必须先回 `client.tool_ack`（即使沙箱尚未就绪），服务端收到 ack 后重置超时计时，避免把「慢但存活」的客户端误判为断开。
- 服务端超时时必须向该项目广播 `tool.cancel`；客户端若尚未开始执行该 requestId，必须丢弃（禁止超时后仍执行变更，否则会产生无操作记录的幽灵对象）。
- 服务端不得假设客户端返回结构合法：`capture_viewport` / `export_glb` 必须校验 `data` 字段后再使用（见 `apps/server/src/tools/index.ts`）。
- `export_glb` 是异步宿主导出（`GLTFExporter`），必须走 `SandboxController.executeTool` 的 `exportGlb` 分支，不能走沙箱同步 `exec`（否则返回 `UNKNOWN_TOOL`）。
- 浏览器端 `executeClientTool` 必须按 requestId 去重（在途请求集合），并只在沙箱挂载的项目与请求所属项目一致时执行；沙箱就绪后重放遗留的 pending 请求。

## 6. 视觉输出

- `capture_viewport` 通过 `toModelOutput` 返回 `{ type: 'content', value: [text, { type: 'file', ... }] }`。
- `capture_multiview` 在一条结果中返回多张图：每个视角前先放一条 `text` 说明视角名，再放 `file` 图片；每张图都保存为独立 PNG 产物。实现思路见 `docs/agent_glb_inspect.md`（多视角图看外观 + `inspect_scene` 场景树读结构）。
- 系统只支持视觉模型，因此 `capture_viewport` / `capture_multiview` 始终把图片附带进模型消息；无图片数据时降级为文本摘要。
- 图片数据只取客户端 `dataUrl` 的 base64 部分，禁止把 dataUrl 整体塞进模型消息。

## 7. 新增工具检查清单

- [ ] `packages/shared/src/tools.ts`：input schema + 类型导出 + 名称列表 + `toolInputSchemas`
- [ ] `packages/shared/src/domain.ts`：如需新增结果字段
- [ ] `apps/server/src/tools/index.ts`：注册、英文描述、必要的 `toModelOutput` 与结果校验
- [ ] `apps/web/src/sandbox/runtime.ts`：实现 + `exec` 分发 + 确定性
- [ ] `apps/server/src/conversation/system-prompt.ts`：工具说明与工作流
- [ ] `apps/web/src/features/chat/ToolCallCard.tsx`：展示名称 / 摘要（如需）
- [ ] `apps/server/src/tools/tools.test.ts`：记录 / 不记录、失败不记录
- [ ] 运行 `pnpm typecheck`、`pnpm --filter @llm3d/server test`、`pnpm --filter @llm3d/server smoke`
