# STRATAGEM.md — Agent instructions for STRATAGEM X7

You are operating inside the **STRATAGEM X7** repo (npm: `stratagem-x7`), a fork of OpenClaude. Your operator is **VME**.

The full project reference lives in [XETH7_CONTEXT.md](XETH7_CONTEXT.md). Treat that as canonical for repo facts (paths, systems, history).

@./XETH7_CONTEXT.md

---

## Hard rules (do not violate)

- **Branch:** Work on `xeth-7-dev`. Never commit to `main`.
- **Naming:** User-facing strings say "Stratagem" / "STRATAGEM". Stray "Claude" or "OpenClaude" references in user-facing text are bugs — fix on sight. Internal/legacy code paths (e.g. `.claude/`, `CLAUDE_*` env vars) are kept for backward compat and are NOT bugs.
- **No `chalk.dim` / `<Text dimColor>`** in render-hot paths — SGR-2 causes stray-char bleed in some terminals (Windows Terminal especially). Use `chalk.gray()` / `<Text color="gray">`.
- **Don't re-add model validation for Anthropic providers** in `sanitizeProfile()` (`src/utils/providerProfiles.ts`). The empty-model branch is load-bearing for Subscription default.
- **Don't reintroduce live telemetry.** Analytics is intentionally stubbed at build time.
- **Don't reintroduce the live-resizing ASCII header.** The persistent-header experiment was a perf disaster and is dead.

## Build & test baseline

- Build: `bun run build` → `dist/cli.mjs`. Must always pass.
- Smoke test: `stx7 --version`.
- Tests: `bun test <path>` (targeted). Full `bun test` may surface circular-import TDZ that the bundler hides — production binary is fine, but test runner can flag false-positives in lazy schema getters.
- Full typecheck (`tsc --noEmit`) surfaces upstream OpenClaude noise — don't chase issues outside code you're touching.

## Publish workflow (only when asked)

```
bun run build
npm version patch --no-git-tag-version
npm publish
git add -A; git commit; git push
```

If npm serves stale post-publish, `npm cache clean --force` then reinstall.

## Visual identity

BREACH chrome — acid-lime + cyan, dark olive-black backgrounds, full-rectangle borders with breach-edge titles (`─ USER ─`, `─ STRATAGEM ─`, `─ TRACE // COGNITION ─`). The fork should feel structurally distinct from upstream OpenClaude, not just reskinned. Aggressive redesign is welcome where it improves originality.

Auto-shrink bordered Box pattern: wrap in `flexDirection="row" alignItems="flex-start" width="100%"` parent. Used by `messages/AssistantTextMessage.tsx` and `messages/UserPromptMessage.tsx`.

## Collaboration style

- VME prefers direct action — act on obvious fixes without asking. Minimal hesitation.
- Commit substantial phases when asked, not by default.
- Useful concepts from XETHRYON (the user's OpenCode fork) can inspire but not dictate — no forced parity.

## File conventions

- Tests colocate as `*.test.ts(x)` next to source — no separate `tests/` dir.
- `changelog/` and `.context/` are gitignored (local-only working notes).
- Per-version notes live in `changelog/v0.3.XX.md`; release log in `XETH7_CONTEXT.md` §6.
- Instruction file priority: `STRATAGEM.md` (this file) → `AGENTS.md` → `CLAUDE.md`. First-match-wins at root.
