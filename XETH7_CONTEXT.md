# XETH--7 / STRATAGEM X7 — Project Context

> **Last updated**: 2026-05-08 — v0.3.60

---

## 1. Repository & Toolchain

| Key | Value |
|---|---|
| **Path** | `D:\Mods\xethryon\new agent\XETH--7` |
| **Branch** | `xeth-7-dev` (all work goes here — never `main`) |
| **NPM package** | `stratagem-x7` on npmjs.com |
| **Current version** | `0.3.60` |
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
├── package.json            # v0.3.60, name: stratagem-x7
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
- **Subscription default**: Anthropic OAuth users can select "⚡ Subscription default" model, which dynamically resolves via `getDefaultMainLoopModel()` based on their subscription tier. `sanitizeProfile()` allows empty model fields for Anthropic providers to enable this.

### 4.4 Effort System

Effort is a string param sent to the model API; the **server** decides the actual reasoning budget — Stratagem does not own a token-budget mapping. Two parallel naming conventions exist for the same semantic ladder:

| Anthropic (`EFFORT_LEVELS`) | OpenAI/Codex (`OPENAI_EFFORT_LEVELS`) | Use case |
|---|---|---|
| `low` | `low` | Simple tasks |
| `medium` | `medium` | Standard work |
| `high` | `high` | Complex reasoning |
| `max` | `xhigh` | Deepest reasoning (Opus 4.7 / 4.6 only on Anthropic) |

`max` ⇄ `xhigh` are **different names for the same level** — translated via `standardEffortToOpenAI()` / `openAIEffortToStandard()` in `src/utils/effort.ts`. They are not separate levels and the picker shows only one at a time depending on provider.

**Key files:**
- `src/utils/effort.ts` — source of truth for available levels, model support, and convention translation
- `src/services/api/claude.ts` `configureEffortParams()` — sends the effort string to Anthropic via `outputConfig.effort`
- `src/components/EffortPicker.tsx` — picker UI; collapses `xhigh` ⇄ `max` for the comparison logic

### 4.5 Autonomy System (Buffer Modes)

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

### 4.6 Agent Teams / Swarm

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

### 4.7 TUI / Shell (Ink/React)

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
- Message prefixes are rendered as **breach-edge top-border titles** (`─ USER ─...`, `─ STRATAGEM ─...`, `─ TRACE // COGNITION ─...`) — same `borderText` mechanism as Pane / StatusLine / CoordinatorAgentStatus. Collapsed thinking keeps its single-line `│ TRACE // COGNITION <Ctrl+O>` form.

### 4.8 Tool System

46 tool directories under `src/tools/`. Each tool is a directory with a main `.ts`/`.tsx` file implementing the tool interface from `src/Tool.ts`. Tools are registered in `src/tools.ts`.

Core tools: `BashTool`, `PowerShellTool`, `FileReadTool`, `FileEditTool`, `FileWriteTool`, `GrepTool`, `GlobTool`, `WebFetchTool`, `WebSearchTool`, `AgentTool`, `MCPTool`, `AskUserQuestionTool`, `TodoWriteTool`, `SkillTool`.

**Scheduling primitives** (gated by `isKairosCronEnabled()`):
- `CronCreate` / `CronList` / `CronDelete` — recurring + one-shot cron jobs (`src/tools/ScheduleCronTool/`)
- `ScheduleWakeup` — purpose-built one-shot self-pacing primitive for `/loop` dynamic mode. Takes `delaySeconds` / `reason` / `prompt`, clamped to [60, 3600]s. Description bakes in 5-minute prompt-cache TTL guidance (avoid 300s cliff; idle ticks default to 1200–1800s). Internally maps to a session-only one-shot cron task. (`src/tools/ScheduleWakeupTool/`)

### 4.9 Build System

- **Bundler**: Bun's built-in bundler via `scripts/build.ts`
- **Feature flags**: `import { feature } from 'bun:bundle'` — dead code elimination at build time
- **Telemetry stub**: 21 analytics modules are stubbed (no telemetry sent)
- **Feature pre-processing**: 206 files processed for flag evaluation
- **Output**: Single `dist/cli.mjs` bundle (~20.8MB)

### 4.10 Analytics & Telemetry

- `src/services/analytics/config.ts` — `isAnalyticsDisabled()` always returns `true`
- GrowthBook feature flags are effectively dead (depend on 1P event logging)
- This is intentional — Stratagem is a standalone fork, no data goes to Anthropic

---

## 5. External Systems: Knowledge Base (KB) Skill Suite

The user maintains a personal knowledge base system alongside Stratagem. This is a **separate system** — not part of the Stratagem codebase, but integrated via Claude Code skills and hooks.

### Architecture

```
~/.claude/
├── kb/                          # KB Engine (centralized install)
│   ├── AGENTS.md                # Schema spec (article format, conventions)
│   ├── pyproject.toml           # Dependencies (claude-agent-sdk, python-dotenv)
│   ├── scripts/                 # compile.py, query.py, lint.py, flush.py, config.py, utils.py
│   └── hooks/                   # session-start.py, session-end.py, pre-compact.py
├── skills/
│   ├── kb/                      # Skill hub (docs + router)
│   ├── kb-save/                 # /kb-save — mid-session capture
│   ├── kb-compile/              # /kb-compile — compile daily logs → wiki
│   ├── kb-query/                # /kb-query — ask the KB
│   ├── kb-lint/                 # /kb-lint — health checks
│   └── kb-status/               # /kb-status — stats and diagnostics
├── template/                    # AGENTS.md + CLAUDE.md for new projects
│   ├── AGENTS.md
│   └── CLAUDE.md
├── init-project.bat             # Run from any project root to copy templates
└── settings.json                # Hook config pointing to ~/.claude/kb/
```

### Per-project data

Each project gets a `.memory/` directory (hidden dotfolder) created automatically by the SessionEnd hook:

```
<project-root>/.memory/
├── daily/                       # Session logs (YYYY-MM-DD.md)
├── knowledge/                   # Compiled wiki articles
│   ├── index.md                 # Master catalog
│   ├── concepts/                # Atomic knowledge
│   ├── connections/             # Cross-cutting insights
│   └── qa/                      # Filed Q&A answers
├── reports/                     # Lint reports
└── state/                       # Compile hashes, cost tracking, flush.log
```

### Slash commands

| Command | What it does | Cost |
|---|---|---|
| `/kb-save [hint]` | Capture to daily log + wiki articles | Free |
| `/kb-compile` | Compile new/changed daily logs | ~$0.45-0.65/log |
| `/kb-compile --all` | Full rebuild (warns first) | ⚠ per log |
| `/kb-compile --dry-run` | Preview what needs compiling | Free |
| `/kb-query <q>` | Ask the KB | ~$0.15-0.25 |
| `/kb-query <q> --save` | Ask + save answer as Q&A article | ~$0.25-0.40 |
| `/kb-lint` | Structural health checks | Free |
| `/kb-lint --full` | Includes LLM contradiction check | ~$0.15-0.25 |
| `/kb-status` | Counts, cost, flush.log tail | Free |

### Context sync (separate skill)

| Command | What it does |
|---|---|
| `/context-sync` | Router — suggests init or update |
| `/context-init` | Bootstrap `.context/` in a project |
| `/context-update` | Refresh `.context/` at session end |

### Important boundaries

- **`.memory/`** is the KB system's per-project data — NOT the same as Stratagem's auto-memory (`~/.stratagem/projects/<hash>/memory/`)
- **`.context/`** is the cross-session handoff system — separate from both
- The KB system uses Claude Code's built-in credentials — no API key needed

---

## 6. Recent Commit History (v0.3.27 → v0.3.60)

Per-version notes for v0.3.46 onward live in [`changelog/`](changelog/README.md).

| Version | Commit | Change |
|---|---|---|
| **0.3.60** | _pending_ | fix: production-readiness pass — broken import paths, BypassPermissions rebrand, stale test fixes |
| **0.3.59** | `77e4df1` | feat: breach titles for missed Pane callers (FuzzyPicker, /effort, /mobile, /passes, iTerm2 setup) |
| **0.3.58** | `edae18e` | feat: breach-edge turn delimiters for transcript messages |
| **0.3.57** | `31fe7bc` | feat: per-screen breach titles for all Pane-based slash command surfaces |
| **0.3.56** | `9b5a075` | feat: breach-HUD redesign for PermissionDialog |
| **0.3.55** | `7b64ee0` | feat: /whoami slash command + rebrand sweep + small bug cleanup |
| **0.3.54** | `28a0cfb` | fix: system prompt now lists Opus 4.7 as the latest — model identifies as 4.7 not 4 |
| **0.3.53** | `dd14f4f` | fix: replace chalk.dim with chalk.gray in input-area rendering — fixes stray-char flicker |
| **0.3.52** | `a043900` | fix: /logout now scopes to Anthropic creds — preserves Codex/MCP/plugin OAuth |
| **0.3.51** | `6805e51` | fix: don't suggest /login for non-Anthropic provider auth errors |
| **0.3.50** | `e0b4df8` | feat: add MemoryPin / MemoryList / MemoryUnpin — first-class auto-memory tools |
| **0.3.49** | `ce672e1` | fix: revert xhigh from canonical EffortLevel — it's the OpenAI alias for 'max', not a separate level |
| **0.3.48** | `a38d4c5` | fix: sync appState on subscription-default switch + extract sentinel const |
| **0.3.47** | `5512d38` | fix: 3P 'Opus 4.7' option now sends opus-4-7 not opus-4-6, plus effort.ts dead-code cleanup |
| **0.3.46** | `269f6f0` | feat: add ScheduleWakeup tool — purpose-built self-pacing primitive for /loop dynamic mode |
| **0.3.45** | `935e2aa` | fix: allow empty model for Anthropic Subscription default — bypass sanitizeProfile validation |
| **0.3.44** | `5822914` | feat: fix startup model display for subscription users, add xhigh effort level, add Subscription default to Anthropic model picker |
| **0.3.43** | `cba1c31` | feat: enable effort support for Opus 4.7 — effort slider, max effort, default effort |
| **0.3.42** | `e8fdb4e` | feat: add Anthropic model picker to uplink profile step 4/4 |
| **0.3.41** | `7d9168a` | fix: update all remaining Opus 4.6 display strings to 4.7 |
| **0.3.39** | `db1165c` | feat: add Opus 4.7 with correct model ID |
| **0.3.38** | `7bfeb92` | chore: revert to stable scrollbar fix base — removes opus 4.7 experiments |
| **0.3.30** | `1a576c0` | fix: ScrollIndicator infinite loop — snapshot returns primitive string |
| **0.3.29** | `4343cab` | feat: add terminal scrollbar indicator for fullscreen mode |
| **0.3.27** | `7b2a92b` | fix: rebrand "Claude's questions" → "Stratagem's questions" in AskUserQuestionTool |

---

## 7. Known Issues & Gotchas

### Build
- Full typecheck may surface pre-existing upstream issues — `bun run build` + targeted tests is the practical baseline
- The Bun bundler hoists ESM declarations into a single bundle, so circular-import TDZ errors don't surface in `bun run build` but DO surface in `bun test` (per-module live evaluation). Memory tools (`src/tools/MemoryTool/`) hit this — the lazy-schema getter is invoked by `buildTool`'s `{...def}` spread, which runs the factory before `memdir/paths.ts` finishes initializing in the test runner. Production binary unaffected.
- Feature flags via `bun:bundle` are compile-time only — runtime checks use `feature('FLAG')` calls

### Shell / UI
- Failed persistent-header experiment was reverted — do NOT reintroduce giant live-resizing ASCII header logic
- Some surfaces still retain upstream OpenClaude layout DNA and need further work
- Fullscreen + virtual scroll is enabled by default since v0.3.19

### Providers
- Providers using `reasoning_content` field (Kimi, Moonshot, DeepSeek) need special handling in the shim
- Tool ID sanitization happens at two points: streaming ingestion (`sessionIngress.ts`) and replay (`openaiShim.ts`)
- `sanitizeProfile()` in `providerProfiles.ts` allows empty model fields for Anthropic providers — this enables the "Subscription default" feature. Don't re-add model validation for Anthropic.

### Memory
- A stray `.git` at `D:\` caused all D: projects to share memory — fixed in v0.3.25 via `isFilesystemRoot()` guard
- Old shared `D--` folders in `~/.stratagem/projects/` can be manually cleaned up

---

## 8. Good Next Targets

| Area | Notes |
|---|---|
| Settings/config surfaces | Still upstream-looking (some Pane callers got breach titles in 0.3.57; deeper layout work remains) |
| ~~Permission dialogs~~ | ~~Need breach-HUD styling~~ — done in 0.3.56 |
| MCP panels | Need visual overhaul |
| Task detail/dialog views | Generic upstream look |
| Transcript layout | Top-edge breach delimiters landed in 0.3.58; further differentiation possible (per-turn metadata in border, channel-direction language, etc.) |
| Picker and modal consistency | FuzzyPicker / EffortPicker / mobile / passes / iTerm2-setup got titles in 0.3.59 (LanguagePicker / ColorPicker still bare but live inside SETTINGS or wizard panes that already wear chrome) |
| Swarm/team UX | Visual feedback for running teammates |
| Deeper shell architecture | Move beyond color/chrome into structural originality |
| Remaining Claude references | Grep for `Claude` in user-facing strings — fix on sight (sweep done in 0.3.55, but new ones may surface) |

---

## 9. Development Conventions

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
