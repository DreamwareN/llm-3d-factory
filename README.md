# LLM 3D Factory

用 LLM 生成 3D 模型的平台。**每个项目就是一个 3D 场景**，项目里可以有多个对话；对话用一套结构化的 Three.js 场景图工具（RFC-002）逐步构建/修改这个共享场景，并且可以随时切换模型。平台原生支持多个项目并行运行，每个对话可绑定不同的 LLM Provider。

```
React SPA (Vite + shadcn/ui)                      Node 服务 (Fastify)
┌──────────────────────────────────┐   REST    ┌──────────────────────────────────────┐
│ 项目（场景）列表 / 对话列表        │ ◀───────▶ │  SessionManager                       │
│ 对话：聊天 / 进度 / 模型切换       │   WS v2   │   ├─ ProjectHub（场景，1 项目 1 个）  │
│ Three.js 预览 (sandbox iframe)     │ ◀───────▶ │   │   ├─ GLB 快照 / 操作历史 / 产物 │
│ 场景操作历史 / 产物下载            │           │   │   └─ 预览客户端 / 场景事件广播   │
└──────────────────────────────────┘           │   └─ ConversationSession（每个对话）  │
        ▲  postMessage                          │       └─ AI SDK v7 streamText         │
        │                                       └──────────────┬───────────────────────┘
  沙箱 runtime：SceneManager + CSG                             │
  （对象注册表 / AABB / GLB 加载）                    SQLite + Drizzle ORM
                                                     （conversations / project_scenes / scene_operations / artifacts）
```

## 功能特性

- **项目即场景**：一个项目对应一个持久的 3D 场景（GLB 快照 + 产物），项目内所有对话共享。
- **多对话**：同一场景可以开多个对话，分别负责不同部分或不同思路；新建对话会自动沿用最近使用的模型，对话内可随时**切换模型**，并选择「保留上下文」或「清空上下文」。
- **并发策略**：不同项目可以同时生成；同一项目同时只允许一个对话在生成，避免两个模型交错修改同一场景。
- **结构化建模工具**：Agent 不写大段脚本，而是调用 14 个语义化场景工具，每步都返回对象 ID 与世界 AABB。
- **视觉自检（必需）**：建模依赖 `capture_viewport` 的截图反馈，因此只支持支持视觉输入的模型。
- **GLB 快照持久化**：每轮生成结束后由预览客户端把当前场景导出为 GLB 存回项目；刷新、重连或切换项目时直接加载快照，不再依赖操作回放。成功的场景变更仍会记录为操作历史供审计。
- **多 Provider**：任何 OpenAI 兼容接口（OpenAI / DeepSeek / OpenRouter / Ollama / vLLM …），对话可随时切换。
- **实时进度**：WebSocket 推送文本流、推理流、工具调用、场景操作、Token 用量与耗时；断线自动重连并恢复快照。
- **沙箱隔离**：预览 iframe 与主应用隔离；支持重置相机、截图、导出 GLB，并展示产物。
- **响应式布局**：侧边栏与右侧面板均可折叠（`Ctrl/⌘ + B` 折叠侧边栏）；窄屏（<1024px）下侧边栏变抽屉、预览全屏，底部只保留一个输入框，进度显示在输入框上方，聊天与进度通过顶栏按钮以底部抽屉查看。
- **CSG 布尔运算**：基于 `three-bvh-csg` 实现挖孔、开槽、融合与求交。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 · Vite 8 · TypeScript · Tailwind v4 · shadcn/ui · Zustand |
| 3D | three.js · OrbitControls · GLTFExporter · three-bvh-csg |
| 后端 | Node 20+ · Fastify 5 · `@fastify/websocket` · AI SDK v7 · zod v4 |
| 持久化 | SQLite（better-sqlite3）· Drizzle ORM（WAL 模式） |
| 工程 | pnpm workspaces · tsx · tsup · vitest |

## 目录结构

```
apps/
  server/   Fastify API + WebSocket + 对话运行时 + SQLite
  web/      React 应用 + Three.js 沙箱 runtime（SceneManager + 工具实现）
packages/
  shared/   WS 协议、工具 schema、沙箱消息协议、领域类型（唯一事实来源）
docs/
  agent_tool_call.md   RFC-002 工具集规范
  spec/                开发规范（工具契约 / 协议 / 沙箱 / 持久化 / 对话运行时）
```

## 快速开始

要求 Node ≥ 20、pnpm ≥ 9。

```bash
pnpm install
cp .env.example apps/server/.env   # 可选：服务端配置（dotenv 从 cwd 读取）；VITE_* 变量请放 apps/web/.env
pnpm dev                           # 同时启动 API (8787) 与 Web (5173)
```

打开 http://127.0.0.1:5173 ，进入「设置」添加一个 Provider：

| 服务商 | Base URL | 示例模型 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4.1` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenRouter | `https://openrouter.ai/api/v1` | 任意 |
| Ollama（本地） | `http://localhost:11434/v1` | `qwen2.5:14b` |

> API Key 仅保存在本地服务端 SQLite 中，不会返回给浏览器。请使用支持视觉输入的模型。

### 无 API Key 体验

仓库内置一个确定性的 OpenAI 兼容 Mock Provider，会按固定脚本依次调用建模工具：

```bash
pnpm --filter @llm3d/server mock:provider        # 启动于 http://127.0.0.1:9999/v1
```

然后在设置中新增 Provider，Base URL 填 `http://127.0.0.1:9999/v1`，模型填 `mock-model` 即可。

## 使用流程

1. 在侧边栏新建项目（`+`）——它就是这个场景。
2. 展开项目，点击列表末尾的「新建对话」即可创建（自动沿用最近使用的模型），在底部输入框发送第一条需求。
3. 对话中：
   - 底部居中的浮动输入框随时发送消息；右侧面板顶部的模型按钮可在对话中途切换模型（保留或清空上下文）。
   - 右侧「对话」查看流式输出与工具调用；「进度」查看时间线、Token 用量与产物；右侧面板可折叠。
   - 左侧「预览」实时渲染场景；「操作」查看项目级场景变更与 AABB；「产物」查看截图与 GLB（切换标签不会重载预览）。
4. 删除项目 / 对话 / Provider 都会弹出二次确认，避免误删。
5. 不同项目可同时运行；同一项目下第二个对话在生成时会提示场景被占用。
6. 窄屏下：预览全屏作为背景，输入框常驻底部，进度显示在输入框上方；点击顶栏的对话按钮可打开底部抽屉查看聊天与进度。
7. 完成后，GLB 与截图会出现在「产物」标签页，可直接下载。

## Agent 工具（RFC-002）

**几何与实体**

| 工具 | 说明 |
| --- | --- |
| `create_primitive` | 创建 box / sphere / cylinder / cone / torus / plane，指定尺寸、位置、PBR 材质 |
| `create_extrude_mesh` | 将 XY 平面闭合轮廓沿 Z 拉伸，支持倒角（异形截面、踢脚线、弧形板） |
| `boolean_mesh` | CSG 布尔运算：subtract 挖孔 / union 融合 / intersect 求交 |
| `duplicate_object` | 线性或环形阵列复制（柱廊、楼梯、椅列） |

**空间装配**

| 工具 | 说明 |
| --- | --- |
| `transform_object` | 绝对/相对平移、旋转、缩放，支持 world / local 空间 |
| `align_object` | 基于 AABB 的语义对齐：吸附、居中、堆叠；`target_id: "ground"` 表示地平面 |
| `group_objects` | 将多个对象编组，支持 center / bottom_center / world_origin 三种 Pivot |
| `delete_object` | 删除对象或整个编组（含子对象），用于替换/清理错误部件 |

**外观**

| 工具 | 说明 |
| --- | --- |
| `modify_material` | 修改 color / roughness / metalness / transmission / opacity / wireframe |
| `setup_lighting` | 灯光预设（studio_soft / sunlight_harsh / warm_interior / cold_minimal）与自定义 |

**自检与兜底**

| 工具 | 说明 |
| --- | --- |
| `inspect_scene` | 返回场景树、对象 ID、世界变换、几何/材质与精确 AABB |
| `capture_viewport` | 从 isometric / front / top / side / perspective_detail 视角截图 |
| `capture_multiview` | 一次渲染多视角（默认 front / side / isometric / back），用于修改既有模型前建立整体认知 |
| `eval_code_fallback` | 最后手段：执行原生 Three.js 片段（弹簧、扭曲网格、数学曲面） |

**交付（扩展）**

| 工具 | 说明 |
| --- | --- |
| `export_glb` | 导出二进制 glTF 并保存为产物 |
| `finish` | 结束本轮生成并给出总结 |

所有成功返回遵循统一协议：

```json
{
  "success": true,
  "object_id": "column",
  "aabb": { "min": [-0.12, 0, -0.12], "max": [0.12, 1.2, 0.12], "size": [0.24, 1.2, 0.24], "center": [0, 0.6, 0] },
  "message": "Created cylinder 'column'."
}
```

失败时返回 `error_code` / `error` / `suggestion`，引导 Agent 自修复（详见 `docs/agent_tool_call.md`）。

## 场景持久化机制

- 沙箱中的 `SceneManager` 维护 `object_id → Object3D` 注册表与 ID 生成器。
- 每轮生成结束（含取消/失败）后，预览客户端把沙箱场景导出为 GLB 并通过 `scene.snapshot` 上传；服务端校验后 upsert 到 **项目级** `project_scenes` 表。
- 预览挂载或切换项目时，从 `GET /api/projects/:id/scene` 加载 GLB；对象 ID 通过 glTF `extras`（`userData.objectId`）保留，灯光配置随快照单独保存。
- 成功的变更类工具调用仍会写入 `scene_operations` 作为审计历史（只读，不再回放）；只读工具（`inspect_scene` / `capture_viewport`）与 `export_glb` 不写入。

## 沙箱与安全

- 预览 iframe 使用 `sandbox="allow-scripts"`（无 `allow-same-origin`），拥有独立 opaque origin，无法访问主应用 DOM、Cookie 或存储。
- iframe 内通过 CSP 禁止网络请求（`connect-src 'none'`），脚本仅可访问注入的 Three.js 运行时。
- `eval_code_fallback` 在沙箱内执行；渲染器每 500ms 发送心跳，若脚本死循环导致心跳丢失，前端会销毁并重建 iframe。
- 平台定位为本地单用户工具，默认监听 `127.0.0.1`。如需暴露到网络，请自行增加认证与 HTTPS。

## 常用脚本

```bash
pnpm dev                                   # 并行启动前后端
pnpm typecheck                             # 全仓 TypeScript 检查
pnpm test                                  # 单元测试
pnpm build                                 # 构建沙箱 runtime + 前端 + 服务端

pnpm --filter @llm3d/server mock:provider  # 启动 Mock LLM
pnpm --filter @llm3d/server smoke          # 离线端到端冒烟（Mock LLM + 模拟预览）
pnpm --filter @llm3d/server start          # 运行已构建的服务端（托管前端 dist）
```

### 真实模型端到端测试

```bash
cd apps/server
LIVE_API_KEY=sk-xxx \
LIVE_MODEL=deepseek-chat \
LIVE_BASE_URL=https://api.deepseek.com/v1 \
node scripts/live-test.mjs
```

该脚本会启动服务、模拟浏览器预览响应全部客户端工具、跑完整对话流程并校验场景操作/产物，内置硬超时，结束自动清理进程。

## 环境变量

见 [`.env.example`](.env.example)：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | API 服务监听地址 |
| `DATABASE_PATH` | `./data/llm3d.sqlite` | SQLite 文件路径（相对 `apps/server`） |
| `CORS_ORIGIN` | `http://localhost:5173` | 开发环境允许的前端来源 |
| `CLIENT_TOOL_TIMEOUT_MS` | `25000` | 客户端工具超时 |
| `MAX_ARTIFACT_BYTES` | `12000000` | 单个产物大小上限 |
| `VITE_API_BASE` / `VITE_WS_BASE` | 空 | 前后端分离部署时的 API/WS 地址 |

## WebSocket 协议（v2）

消息统一为 `{ v: 2, id, ts, type, ...payload }`，定义在 `packages/shared/src/protocol.ts`（客户端消息经 zod 校验）：

- 客户端 → 服务端：`project.subscribe` / `project.unsubscribe` / `conversation.subscribe` / `conversation.unsubscribe` / `conversation.start` / `conversation.user_message` / `conversation.cancel` / `client.tool_result` / `preview.ready` / `preview.detach` / `scene.snapshot` / `ping`
- 服务端 → 客户端：`project.snapshot` / `conversation.snapshot` / `conversation.status` / `conversation.updated` / `conversation.error` / `conversation.turn_finished` / `message.added|delta|updated` / `timeline.added|updated` / `tool.client_request` / `scene.updated` / `scene.operation` / `artifact.created` / `usage` / `error` / `log`

场景事件（`scene.updated`、`scene.operation`、`artifact.created`、`tool.client_request`）按项目广播；对话事件按对话订阅推送。

## 已知限制

- 同一项目同时只能有一个对话在生成；不同项目可并行。
- 客户端场景工具要求浏览器预览已连接，且同一时间只有一个项目拥有预览（即只有当前查看的项目能执行场景工具）；未连接或后台项目的场景工具会返回明确错误。
- GLB 快照无法表达所有 Three.js 特性：`wireframe` 通过 `userData` 保留，灯光配置单独存储；`eval_code_fallback` 中依赖运行时对象（如 CanvasTexture、自定义 Shader）的内容可能无法完整还原。
- 沙箱以 iframe 隔离，不是操作系统级安全边界；请勿在生产环境执行不可信用户提供的脚本。
