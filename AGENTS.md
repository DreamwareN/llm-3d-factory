# AGENTS.md

LLM-driven 3D modeling platform. pnpm monorepo: `apps/server` (Fastify + AI SDK v7 + SQLite), `apps/web` (React 19 + Vite + Three.js), `packages/shared` (zod protocols, the single source of truth). Product overview in `README.md`; the authoritative tool spec is `docs/agent_tool_call.md` (RFC-002). Normative development constraints live in `docs/spec/` — read the relevant spec before changing tools, protocol, sandbox, persistence, or the conversation runtime.

## Domain model

- **Project = one scene.** The scene is persisted as a GLB snapshot (`project_scenes`) and shared by all conversations of that project. `scene_operations` is an audit log only — it is never replayed. Artifacts are project-scoped too.
- **Conversation** = chat + model selection, scoped to a project. A conversation can switch provider/model mid-way (keep or reset context).
- Only **one conversation per project may generate at a time**; different projects run in parallel. `SessionManager` enforces this with a scene lock.
- Models must be vision-capable: `capture_viewport` images are always sent to the model. There is no `supportsVision` flag.

## Commands

- `pnpm install` — pnpm 11.20.0 is pinned; `better-sqlite3`/`esbuild` build allowlist is in `pnpm-workspace.yaml` (`allowBuilds`).
- `pnpm dev` — API on 8787, Vite on 5173 (proxies `/api` and `/ws` to 8787).
- `pnpm typecheck` — the only static check. There is **no ESLint/Prettier/Biome config**; don't add or expect one.
- `pnpm test` — only `apps/server` has tests (vitest, colocated `src/**/*.test.ts`; web/shared are skipped).
  - One file: `pnpm --filter @llm3d/server exec vitest run src/tools/tools.test.ts`
  - One test: `pnpm --filter @llm3d/server exec vitest run -t "records mutating tools"`
- `pnpm build` — web builds the sandbox IIFE first, then the app; server bundles with tsup.
- Offline E2E (no key): `pnpm --filter @llm3d/server smoke` — spawns mock provider :9999 + API :8790, verifies the tool loop, self-cleans.
- Live E2E: from `apps/server`, `LIVE_API_KEY=... LIVE_MODEL=... node scripts/live-test.mjs` (all `LIVE_*` vars documented in its header). Hard timeout, self-cleans.

On Windows, don't leave dev servers running in an agent shell — the smoke/live scripts already clean up child trees with `taskkill /T /F`; reuse them instead of juggling manual servers.

## Architecture

- `packages/shared` is consumed as **raw TypeScript** (`main: ./src/index.ts`, no build step). Server inlines it via tsup `noExternal`; Vite transpiles it. New files only need re-export from `src/index.ts`.
- Server runtime: `SessionManager` (`apps/server/src/conversation/session-manager.ts`) owns `ConversationSession`s and per-project `ProjectHub`s. `ConversationSession` (`conversation-session.ts`) runs AI SDK v7 `streamText` with `stopWhen: [isStepCount(maxSteps), hasToolCall('finish')]`; `ProjectHub` (`apps/server/src/project/project-hub.ts`) owns preview clients, scene operations and artifacts.
- The 14 modeling tools + `export_glb` are **client tools**: the server sends `tool.client_request` over WS, a browser tab with the project preview attached executes it in the sandbox iframe, and replies `client.tool_result`. With no preview attached, client tools fail.
- Sandbox: `apps/web/src/sandbox/runtime.ts` compiles to a separate IIFE at `apps/web/public/sandbox/runtime.js` (gitignored). `pnpm dev` builds it **once and does not watch it** — after editing `runtime.ts`, run `pnpm --filter @llm3d/web build:sandbox` or restart. The iframe uses `sandbox="allow-scripts"` + CSP `connect-src 'none'`; host↔sandbox messages are in `packages/shared/src/sandbox-contract.ts` (protocol version 4).
- Scene state is a project-level **GLB snapshot** (`project_scenes`): at the end of every turn (`conversation.turn_finished`) the preview client exports the sandbox scene and sends `scene.snapshot`; the server upserts it. On attach/switch the sandbox loads that GLB (`SandboxController.loadScene`), never an operation log. Keep tools deterministic so exports are stable; `MUTATING_TOOL_NAMES` in `packages/shared/src/tools.ts` decides what gets written to the audit log.
- Preview reuses **one iframe / one WebGL context**: switching projects re-attaches the same sandbox element and loads the new project's GLB (`SandboxController.attach` keeps `ready` when the iframe element is unchanged; the watchdog ignores hidden iframes). `PreviewPanel` keeps the preview mounted via `TabsContent forceMount` and loads when the project snapshot lands (`ProjectRuntimeState.snapshotAt`). Do not remount the iframe on tab/project switches.
- Adding/changing a tool touches four places: `packages/shared/src/tools.ts` (schema + name lists), `apps/server/src/tools/index.ts` (wiring, `toModelOutput` for vision screenshots), `apps/web/src/sandbox/runtime.ts` (implementation), `apps/server/src/conversation/system-prompt.ts` (prompt). Vision tool output uses AI SDK v7 `toModelOutput` → `{type:'content', value:[..., {type:'file', ...}]}`.
- DB: SQLite (better-sqlite3 + Drizzle). Migrations are raw idempotent SQL in `apps/server/src/db/migrate.ts` — there are **no drizzle-kit migration files**. `CREATE TABLE IF NOT EXISTS` won't alter an existing DB, so after schema changes delete `apps/server/data/llm3d.sqlite` in dev.
- Server paths are **cwd-relative** (`apps/server/src/config.ts`): `DATABASE_PATH` and `../web/dist` resolve from `process.cwd()`, and dotenv loads `.env` from cwd. Run server commands from `apps/server` (pnpm does this); a repo-root `.env` is ignored.

## Conventions

- Server and shared relative imports use explicit `.js` extensions; web does not.
- shadcn/ui components (`apps/web/src/components/ui`, `components.json`, new-york style) are CLI-generated and import `cn` from the `"cn"` package plus primitives from `"radix-ui"` — keep those imports, don't rewrite to `@radix-ui/react-*`. Feature code uses `cn` from `@/lib/utils`. Load the `shadcn` skill (`.agents/skills/shadcn/SKILL.md`) when touching UI.
- WS messages are zod-validated `v: 2` envelopes in `packages/shared/src/protocol.ts`; server→client types are a plain union. Change both sides together.
- `PROTOCOL_VERSION` lives in `packages/shared/src/version.ts` and is exported both from the package entry and the `@llm3d/shared/version` subpath. The browser WS client (`apps/web/src/lib/ws.ts`) must import it from the subpath so the web bundle does not pull zod in; never hardcode the version.
- Browser code must import runtime values from zod-free subpaths (`@llm3d/shared/version`, `@llm3d/shared/tool-names`). Importing the package entry from `apps/web` pulls zod into the bundle (~90 kB); type-only imports are fine.
- `apps/web/src/components/ui/sidebar.tsx` + `hooks/use-mobile.ts` are CLI-generated shadcn files; app-specific composition lives in `features/conversations/AppSidebar.tsx`. `components/confirm-dialog.tsx` is a local (non-CLI) component used for destructive confirmations.
