# XETH--7 / STRATAGEM X7 — Project Context

> **Last updated**: 2026-05-04 — v0.3.27

---

## 1. Repository & Toolchain

| Key | Value |
|---|---|
| **Path** | `D:\Mods\xethryon\new agent\XETH--7` |
| **Branch** | `xeth-7-dev` (all work goes here — never `main`) |
| **NPM package** | `stratagem-x7` on npmjs.com |
| **Current version** | `0.3.27` |
| **Global install** | `npm i -g stratagem-x7` |
| **CLI commands** | `stx7`, `openclaude`, `xeth7` |
| **Build** | `bun run build` → `dist/cli.mjs` |
| **Publish workflow** | `bun run build` → `npm version patch --no-git-tag-version` → `npm publish` → `git add -A; git commit; git push` |
| **Test (targeted)** | `bun test <path>` (e.g. `bun test src/utils/autonomy.test.ts`) |
| **Smoke test** | `stx7 --version` |
| **Runtime** | Bun bundler + Node.js compatible output |

---

## 2. Ancestry & Identity

- **XETH--7** is a fork of **OpenClaude** (Anthropic's CLI agent).
- **XETHRYON** (the user's other agent) is a separate fork of **OpenCode** — different base entirely.
- XETHRYON can be used for **inspiration** but NOT 1:1 parity or blind copying.
- The project is fully rebranded to **STRATAGEM X7**. All user-facing strings say "Stratagem", not "Claude".
- Remaining stray "Claude" references in user-facing text are bugs — fix them on sight.

---

## 3. Project Structure

### Top-level layout

```
XETH--7/
├── bin/                    # CLI entry scripts (openclaude, stx7, xeth7)
├── dist/                   # Build output (cli.mjs — single bundle)
├── scripts/                # Build scripts (build.ts)
├── src/                    # All source code
├── package.json            # v0.3.27, name: stratagem-x7
├── XETH7_CONTEXT.md        # This file
└── STRATAGEM.md            # Project-level instructions for the agent
```

### `src/` directory map

| Directory | Purpose |
|---|---|
| `src/bootstrap/` | App startup, state initialization, project root resolution |
| `src/cli/` | CLI argument parsing, entry setup |
| `src/commands/` | Slash-command handlers (`/autonomy`, `/memory`, `/config`, etc.) |
| `src/components/` | **Ink (React-terminal) UI components** — the entire TUI |
| `src/context/` | Context assembly for model prompts |
| `src/entrypoints/` | Main entry points for different run modes |
| `src/hooks/` | React hooks for TUI state |
| `src/keybindings/` | Keyboard shortcut registration and handling |
| `src/memdir/` | **Auto-memory system** — knowledge graph, persistence, paths |
| `src/screens/` | Top-level screen components (REPL, etc.) |
| `src/services/` | Backend services (API, analytics, MCP, plugins, etc.) |
| `src/skills/` | Skill system (reusable action templates) |
| `src/tools/` | **All agent tools** (46 tool directories) |
| `src/utils/` | Shared utilities (git, permissions, settings, config, etc.) |
| `src/main.tsx` | **Main application file** (~237KB — core app orchestration) |
| `src/query.ts` | Query engine / model interaction loop |
| `src/commands.ts` | Slash-command registry |
| `src/tools.ts` | Tool registry and loading |

---

## 4. Key Systems

### 4.1 Instruction Files (STRATAGEM.md)

The agent reads project instructions from markdown files. Resolution priority:

| Priority | File | Scope |
|---|---|---|
| 1 | `STRATAGEM.md` | Project root (primary) |
| 2 | `AGENTS.md` | Project root (secondary) |
| 3 | `CLAUDE.md` | Project root (legacy fallback) |
| 4 | `.stratagem/STRATAGEM.md` | Project config dir |
| 5 | `.claude/CLAUDE.md` | Legacy config dir |
| 6 | `.stratagem/rules/*.md` | Conditional rules |
| 7 | `.claude/rules/*.md` | Legacy rules |
| 8 | `STRATAGEM.local.md` | Local/private (gitignored) |
| 9 | `CLAUDE.local.md` | Legacy local |
| 10 | `~/.stratagem/STRATAGEM.md` | User-level global |
| 11 | `~/.stratagem/CLAUDE.md` | Legacy user-level |

**Key files:**
- `src/utils/projectInstructions.ts` — filename constants and resolution
- `src/utils/claudemd.ts` — full discovery, loading, and parsing logic
- `src/utils/config.ts` → `getMemoryPath()` — path resolution per memory type

### 4.2 Auto-Memory System

Automatic persistent knowledge graph stored **outside** the project directory:

```
~/.stratagem/projects/<project-hash>/memory/
├── index.md          # Entrypoint (not MEMORY.md)
├── daily/            # Session logs
└── knowledge/        # Categorized knowledge subtrees
```

- **Per-project isolation**: Each CWD gets its own memory directory. Filesystem root git repos (e.g. `D:\`) are rejected to prevent cross-project contamination.
- The `isFilesystemRoot()` guard in `getAutoMemBase()` ensures drive-root repos fall back to CWD-based scoping.

**Key files:**
- `src/memdir/paths.ts` — path resolution, `getAutoMemBase()`, `isFilesystemRoot()`
- `src/memdir/memdir.ts` — memory read/write operations
- `src/memdir/memoryScan.ts` — memory file scanning
- `src/memdir/findRelevantMemories.ts` — relevance ranking
- `src/memdir/memoryTypes.ts` — memory prompt/schema definitions

### 4.3 Provider System (Multi-LLM)

Stratagem supports any OpenAI-compatible API, not just Anthropic:

- **OpenAI shim**: `src/services/api/openaiShim.ts` (~68KB) — translates Anthropic message format to/from OpenAI Chat Completions format
- **`sanitizeToolId()`**: Strips illegal chars (colons) from tool IDs for cross-provider compat
- **Tool ID sanitization at ingestion**: `src/services/api/sessionIngress.ts` sanitizes IDs during streaming, not just replay
- **Provider config**: `src/services/api/providerConfig.ts` — provider profile storage and validation
- **Provider setup UI**: `src/components/ProviderManager.tsx` (~56KB) — add/edit/delete providers, auto-discover models via `/v1/models`
- **Provider profiles**: `src/utils/providerProfiles.ts` — pre-configured provider templates

### 4.4 Autonomy System (Buffer Modes)

Three-tier permission system:

| Mode | Behavior | Buffer Label |
|---|---|---|
| `OFF` | Normal approval prompts | `BUFFER:OFF` |
| `SMART` | Auto-approve safe ops, ask for destructive | `BUFFER:SMART` |
| `AGGRESSIVE` | Bypass all permissions | `BUFFER:AGGRESSIVE` |

- Toggle: `Shift+Tab` cycles tiers, `/autonomy <mode>` slash command
- **Key files:**
  - `src/utils/autonomy.ts` — mode logic
  - `src/commands/autonomy/` — slash command
  - `src/utils/permissions/permissionSetup.ts` — permission mapping

### 4.5 Agent Teams / Swarm

Always enabled (no feature flag needed). Sub-agents run as teammates with shared task board.

| Tool | Purpose |
|---|---|
| `TeamCreate` | Creates a team with shared context |
| `TeamDelete` | Disbands the team |
| `SendMessage` | Inter-agent messaging via mailboxes |
| `AgentTool` | Spawns sub-agents |
| `TaskCreate/Update/List` | Shared task board CRUD |

- **Windows**: In-process mode (background threads, no tmux)
- **macOS/Linux**: tmux/iTerm2 backends
- **Key files:**
  - `src/utils/agentSwarmsEnabled.ts` — always returns `true`
  - `src/utils/swarm/` — full swarm module
  - `src/tools/TeamCreateTool/`, `TeamDeleteTool/`, `SendMessageTool/`

### 4.6 TUI / Shell (Ink/React)

The terminal UI uses **Ink** (React for terminal). Key surfaces:

| Component | File | Purpose |
|---|---|---|
| Breach Header | `src/components/BreachHeader.tsx` | Startup banner |
| Status Line | `src/components/StatusLine.tsx` | Bottom status bar |
| REPL | `src/screens/REPL.tsx` | Main interaction loop |
| Message Display | `src/components/Messages.tsx` | Message rendering |
| Message Row | `src/components/MessageRow.tsx` | Individual message layout |
| Prompt Input | `src/components/PromptInput/` | User input area + footer |
| Fullscreen Layout | `src/components/FullscreenLayout.tsx` | Virtual scroll container |
| Virtual Message List | `src/components/VirtualMessageList.tsx` | Virtualized rendering |
| Provider Manager | `src/components/ProviderManager.tsx` | Provider setup wizard |
| Model Picker | `src/components/ModelPicker.tsx` | Model selection UI |

**Visual direction:**
- Acid lime / yellow-green primary chrome
- Cyan active signal accents
- Dark olive-black / near-black backgrounds
- Segmented protocol panels
- Breach / buffer / matrix / uplink language
- Message prefixes: `USER` (user), `STRATAGEM` (AI), `TRACE//COGNITION` (thinking)

### 4.7 Tool System

46 tool directories under `src/tools/`. Each tool is a directory with a main `.ts`/`.tsx` file implementing the tool interface from `src/Tool.ts`. Tools are registered in `src/tools.ts`.

Core tools: `BashTool`, `PowerShellTool`, `FileReadTool`, `FileEditTool`, `FileWriteTool`, `GrepTool`, `GlobTool`, `WebFetchTool`, `WebSearchTool`, `AgentTool`, `MCPTool`, `AskUserQuestionTool`, `TodoWriteTool`, `SkillTool`.

### 4.8 Build System

- **Bundler**: Bun's built-in bundler via `scripts/build.ts`
- **Feature flags**: `import { feature } from 'bun:bundle'` — dead code elimination at build time
- **Telemetry stub**: 21 analytics modules are stubbed (no telemetry sent)
- **Feature pre-processing**: 206 files processed for flag evaluation
- **Output**: Single `dist/cli.mjs` bundle (~20.8MB)

### 4.9 Analytics & Telemetry

- `src/services/analytics/config.ts` — `isAnalyticsDisabled()` always returns `true`
- GrowthBook feature flags are effectively dead (depend on 1P event logging)
- This is intentional — Stratagem is a standalone fork, no data goes to Anthropic

---

## 5. Recent Commit History (v0.3.13 → v0.3.27)

| Version | Commit | Change |
|---|---|---|
| **0.3.27** | `7b2a92b` | fix: rebrand "Claude's questions" → "Stratagem's questions" in AskUserQuestionTool |
| **0.3.25-26** | `1e52f06` | feat: complete Stratagem identity migration — per-project memory isolation + STRATAGEM.md branding |
| **0.3.23** | `5f72e0f` | release: v0.3.23 |
| **0.3.22** | `354a2f9` | feat: add model auto-detection fallback for all provider edit flows |
| **0.3.21** | `21bf35f` | feat: expand Codex model picker with all GPT models |
| **0.3.20** | `3863e9e` | ui: dynamically center BreachHeader in fullscreen viewport |
| **0.3.19** | `fc70284` | feat: enable fullscreen + virtual scroll by default |
| **0.3.18** | `112ddc8` | fix: sanitize tool IDs at streaming ingestion |
| **0.3.17** | `ec6798b` | fix: Alt+H fully hides thinking blocks |
| **0.3.16** | `2ae052e` | fix: default verbose=true, Alt+H toggles thinking |
| **0.3.15** | `de82601` | fix: always show thinking blocks expanded |
| **0.3.14** | `dd7d01d` | fix: always show thinking/reasoning blocks after streaming |
| **0.3.13** | `ddf4762` | feat: persistent Shell Command Mode (Ctrl+P toggle) |

---

## 6. Known Issues & Gotchas

### Build
- Full typecheck may surface pre-existing upstream issues — `bun run build` + targeted tests is the practical baseline
- Feature flags via `bun:bundle` are compile-time only — runtime checks use `feature('FLAG')` calls

### Shell / UI
- Failed persistent-header experiment was reverted — do NOT reintroduce giant live-resizing ASCII header logic
- Some surfaces still retain upstream OpenClaude layout DNA and need further work
- Fullscreen + virtual scroll is enabled by default since v0.3.19

### Providers
- Providers using `reasoning_content` field (Kimi, Moonshot, DeepSeek) need special handling in the shim
- Tool ID sanitization happens at two points: streaming ingestion (`sessionIngress.ts`) and replay (`openaiShim.ts`)

### Memory
- A stray `.git` at `D:\` caused all D: projects to share memory — fixed in v0.3.25 via `isFilesystemRoot()` guard
- Old shared `D--` folders in `~/.stratagem/projects/` can be manually cleaned up

---

## 7. Good Next Targets

| Area | Notes |
|---|---|
| Settings/config surfaces | Still upstream-looking |
| Permission dialogs | Need breach-HUD styling |
| MCP panels | Need visual overhaul |
| Task detail/dialog views | Generic upstream look |
| Transcript layout | Further differentiation from upstream |
| Picker and modal consistency | Some pickers are unstyled |
| Swarm/team UX | Visual feedback for running teammates |
| Deeper shell architecture | Move beyond color/chrome into structural originality |
| Remaining Claude references | Grep for `Claude` in user-facing strings — fix on sight |

---

## 8. Development Conventions

### Workflow
- Work on `xeth-7-dev` only
- Keep the repo buildable after changes
- Keep `stx7` runnable from any directory
- Commit substantial phases when asked

### Collaboration style
- User prefers direct action — just do it, don't ask for permission on obvious fixes
- User wants minimal hesitation
- STRATAGEM X7 should feel truly distinct, not upstream with a skin
- Aggressive redesign welcome if it improves originality
- Useful concepts from XETHRYON are fine to borrow, but no forced architectural parity

### Naming
- **User-facing**: "Stratagem" or "STRATAGEM" — never "Claude" or "OpenClaude"
- **Instruction files**: `STRATAGEM.md` (primary), `AGENTS.md` (secondary), `CLAUDE.md` (legacy)
- **Config dirs**: `.stratagem/` preferred, `.claude/` for backward compat
- **CLI**: `stx7` is the primary command

### Testing
- `bun run build` must always pass
- Run targeted tests for changed areas (`bun test src/path/to/test.ts`)
- `stx7 --version` for quick smoke test
