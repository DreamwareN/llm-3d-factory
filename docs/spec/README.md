# 开发规范（Specs）

本目录是 llm-3d-factory 的规范性文档，约束「代码必须遵守什么」，不是教程。涉及对应区域的改动必须同步更新相应规范。

## 权威顺序

冲突时按以下优先级判断（高 → 低）：

1. `packages/shared` 的 zod schema 与导出类型 —— 可执行的唯一事实来源
2. 本目录规范
3. `docs/agent_tool_call.md`（RFC-002）—— 工具语义与参数定义
4. `README.md` / `AGENTS.md` —— 面向使用者与编码代理的说明

## 规范索引

| 文件 | 约束范围 |
| --- | --- |
| [tool-contract.md](./tool-contract.md) | 新增 / 修改建模工具必须遵守的契约 |
| [protocol.md](./protocol.md) | WebSocket 协议与前后端消息约定 |
| [sandbox.md](./sandbox.md) | 预览沙箱的安全边界、消息协议与场景回放 |
| [persistence.md](./persistence.md) | SQLite schema、迁移、操作日志与产物 |
| [conversation-runtime.md](./conversation-runtime.md) | 对话生命周期、项目级并发锁、模型切换、超时与取消 |

## 元规则

- 「必须 / 禁止」是强制约束；确需违反时，在 PR 描述中说明原因，并先修改对应规范。
- 规范与实现不一致视为缺陷：要么改代码，要么改规范，禁止长期并存。
- 规范不复制可由 schema 推导的字段清单；引用文件而不是复制内容，避免漂移。
- 新增对外可观察的行为（工具、消息类型、REST 端点、环境变量）必须同时补规范或更新引用处。
