# 沙箱规范（Preview Sandbox）

预览在独立 iframe 中运行 Three.js 场景。本规范定义安全边界、消息协议与回放约束。

## 1. 安全不变量（禁止削弱）

- iframe 必须使用 `sandbox="allow-scripts"`；禁止添加 `allow-same-origin`。
- CSP 必须保持 `default-src 'none'`、`script-src <self origin>`、`connect-src 'none'`、`worker-src 'none'`；不得为沙箱开放网络、worker 或外部字体。
- 沙箱内代码禁止访问宿主 DOM、Cookie、localStorage；跨边界通信只能走 `postMessage`。
- 宿主必须校验 `event.source === iframe.contentWindow` 后才处理消息（`sandbox-controller.ts` 已实现）。
- 沙箱应当校验 `event.source === window.parent`（当前仅校验消息形状，见「已知缺口」）。
- `eval_code_fallback` 的用户代码只能在沙箱内用 `new Function` 执行；禁止移到服务端执行，也禁止在服务端做 AST / 黑名单校验（会误伤 CanvasTexture 等合法用法）。沙箱本身就是安全边界。

## 2. 消息协议（v4）

- 版本号 `SANDBOX_PROTOCOL_VERSION` 定义在 `packages/shared/src/sandbox-contract.ts`。
- host → sandbox：`reset`、`exec`、`loadScene`、`resize`、`screenshot`、`setCamera`、`exportGlb`。
- sandbox → host：`ready`、`toolResult`、`loadSceneDone`、`sceneUpdated`、`heartbeat`、`console`、`screenshotResult`、`cameraResult`、`glbResult`（含 `lighting`）、`error`。
- 带 `requestId` 的请求必须恰好返回一个同 `requestId` 的响应；`reset` / `resize` 是 fire-and-forget。
- 双方必须忽略未知 `type`（向前兼容）；破坏性改动必须提升协议版本号。

## 3. 生命周期与超时

- 沙箱加载完成后发送 `ready`；宿主在 `whenReady()` 之前不得发送请求。
- 切换项目必须复用同一个 iframe：`SandboxController.attach()` 在 iframe 元素未变时保留 `ready` 与心跳（只清在途请求、更新 `projectId`），使 `whenReady()` 立即返回并由 `loadScene` 加载新项目场景。禁止在切换项目/标签时重建 iframe。
- 预览不可见时（非激活标签 `display:none`）看门狗不得判定卡死：iframe 隐藏期间浏览器会暂停其 `rAF` 并节流定时器，宿主必须跳过这段的失联检查。
- 沙箱每 500ms 发送 `heartbeat`；宿主看门狗每 1s 检查，超过 15s 无心跳（且 iframe 可见、无在途请求）判定卡死并重建 iframe。有在途请求时主线程可能被同步操作（如截图读回）占用，禁止判定卡死。
- 宿主请求超时 45s（`REQUEST_TIMEOUT_MS`）；超时后必须 reject Promise，不得悬挂。

## 4. 场景加载与快照

- `loadScene` 必须先 `resetScene()`，再（可选）应用灯光配置，最后用 `GLTFLoader` 解析 GLB 并把顶层节点加入场景；不带 `dataBase64` 表示加载空场景。
- 对象 ID 通过 GLTF `extras` 持久化（`userData.objectId`）；加载时必须按 `userData.objectId`（回退到节点名）重建注册表，并据 `prefix_NNN` 回填 ID 计数器，保证后续工具的 ID 不与已加载对象冲突。
- 加载后的 mesh 必须恢复 `castShadow` / `receiveShadow`；`wireframe` 无法由 glTF 表达，必须从 `material.userData.wireframe` 恢复。
- 灯光是场景级状态，不写入 GLB（导出时剔除）；`exportGlb` 必须随结果返回 `lighting`，`loadScene` 按传入灯光重建。
- 切换项目后的加载必须发生在该项目快照落地之后（`ProjectRuntimeState.snapshotAt` 变化时触发）。
- 每轮 `conversation.turn_finished` 后，预览客户端必须调用 `exportGlb` 并发送 `scene.snapshot` 保存项目场景（见 [persistence.md](./persistence.md) §6）。
- 宿主禁止把历史 `result` 或操作日志回灌沙箱；场景的唯一权威来源是 GLB 快照。

## 5. 构建约束

- `apps/web/src/sandbox/runtime.ts` 单独构建为 IIFE 到 `apps/web/public/sandbox/runtime.js`（gitignored）。
- `pnpm dev` 只在启动时构建一次，不监听 runtime 源码；修改后必须执行 `pnpm --filter @llm3d/web build:sandbox` 或重启。
- runtime 只能依赖 `three`、`three-bvh-csg` 与 `@llm3d/shared`；禁止 import 宿主代码（`@/` 别名）或依赖 Vite 专属注入。

## 6. 已知缺口（改动相关代码时应顺带修复）

- 沙箱侧未校验 `event.source === window.parent`，仅校验消息形状。
- `eval_code_fallback` 没有单次执行时长限制，依赖心跳看门狗兜底。
