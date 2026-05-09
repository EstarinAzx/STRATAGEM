/**
 * Antigravity multi-account rotation.
 *
 * Google's Antigravity OAuth pool multiplexes Gemini 3.x Pro / Flash
 * and Claude 4.6 through a single token. Quota is enforced per account
 * and per model family, so a single-account setup wedges on any quota
 * event until the user waits out the daily reset. This module:
 *
 *   1. Reads the account store maintained by services/oauth/antigravity.ts.
 *   2. Per model-family ('gemini-pro' | 'gemini-flash' | 'claude'),
 *      tracks which account is currently active and rotates on
 *      rate-limit or hard-failure events via HealthScoreTracker.
 *   3. Applies server-specified cooldowns (Google's RetryInfo.retryDelay)
 *      so we don't hammer a just-throttled account.
 *   4. Disables accounts that burn through N consecutive hard failures
 *      (likely the refresh token expired or the account was suspended).
 *
 * Ported from Tau (MIT). Domain-free HealthScoreTracker is colocated
 * here; if a second pool ever needs it (Anthropic multi-org, Codex
 * pool), extract it into shared/health_score.ts.
 */

import {
  type AntigravityAccount,
  type AntigravityStore,
  loadStore,
  saveStore,
} from '../oauth/antigravity.js'

const MAX_ACCOUNTS = 10

// ─── Model-family classification ─────────────────────────────────

export type AntigravityFamily = 'gemini-pro' | 'gemini-flash' | 'claude'

export function familyForAntigravityModel(model: string): AntigravityFamily {
  const m = model.toLowerCase()
  if (m.includes('claude')) return 'claude'
  if (/gemini-\d+(\.\d+)?-pro/.test(m)) return 'gemini-pro'
  return 'gemini-flash'
}

// ─── HealthScoreTracker (domain-free) ────────────────────────────

export interface HealthSnapshot {
  id: string
  score: number
  recentSuccesses: number
  recentFailures: number
  /** Wall-clock ms until this credential is usable again. */
  cooldownRemaining: number
  disabled: boolean
  lastUsedAt: number
}

export interface TrackerOptions {
  /** EMA alpha for successes. 0.3 = last call weighs 30%. */
  successAlpha?: number
  /** EMA alpha for failures. Higher = faster decay on failure. */
  failureAlpha?: number
  /** Default cooldown applied on rate-limit when server doesn't specify. */
  defaultRateLimitMs?: number
  /** Consecutive hard failures before auto-disable. 0 to never disable. */
  hardFailureDisableAfter?: number
}

interface Entry {
  id: string
  score: number
  lastUsedAt: number
  cooldownUntil: number
  consecutiveHardFailures: number
  disabled: boolean
  recentSuccesses: number
  recentFailures: number
}

export class HealthScoreTracker {
  private entries = new Map<string, Entry>()
  private opts: Required<TrackerOptions>

  constructor(opts: TrackerOptions = {}) {
    this.opts = {
      successAlpha: opts.successAlpha ?? 0.3,
      failureAlpha: opts.failureAlpha ?? 0.5,
      defaultRateLimitMs: opts.defaultRateLimitMs ?? 60_000,
      hardFailureDisableAfter: opts.hardFailureDisableAfter ?? 5,
    }
  }

  register(id: string): void {
    if (!this.entries.has(id)) {
      this.entries.set(id, {
        id,
        score: 0.5,
        lastUsedAt: 0,
        cooldownUntil: 0,
        consecutiveHardFailures: 0,
        disabled: false,
        recentSuccesses: 0,
        recentFailures: 0,
      })
    }
  }

  unregister(id: string): void {
    this.entries.delete(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  recordSuccess(id: string): void {
    const e = this.ensure(id)
    e.score = mixEMA(e.score, 1, this.opts.successAlpha)
    e.consecutiveHardFailures = 0
    e.recentSuccesses++
    e.lastUsedAt = Date.now()
  }

  recordRateLimit(id: string, cooldownMs?: number): void {
    const e = this.ensure(id)
    const wait =
      cooldownMs && cooldownMs > 0 ? cooldownMs : this.opts.defaultRateLimitMs
    e.cooldownUntil = Math.max(e.cooldownUntil, Date.now() + wait)
    e.score = mixEMA(e.score, 0.3, 0.15)
    e.lastUsedAt = Date.now()
  }

  recordFailure(id: string): void {
    const e = this.ensure(id)
    e.score = mixEMA(e.score, 0, this.opts.failureAlpha)
    e.consecutiveHardFailures++
    e.recentFailures++
    e.lastUsedAt = Date.now()
    if (
      this.opts.hardFailureDisableAfter > 0 &&
      e.consecutiveHardFailures >= this.opts.hardFailureDisableAfter
    ) {
      e.disabled = true
    }
  }

  reenable(id: string): void {
    const e = this.ensure(id)
    e.disabled = false
    e.consecutiveHardFailures = 0
    e.cooldownUntil = 0
  }

  disable(id: string): void {
    const e = this.ensure(id)
    e.disabled = true
  }

  pickBest(ids: string[]): string | null {
    const now = Date.now()
    let best: { id: string; score: number; lastUsedAt: number } | null = null
    for (const id of ids) {
      const e = this.entries.get(id)
      if (!e) {
        if (!best || 0.5 > best.score) {
          best = { id, score: 0.5, lastUsedAt: 0 }
        }
        continue
      }
      if (e.disabled) continue
      if (e.cooldownUntil > now) continue
      if (
        !best ||
        e.score > best.score ||
        (e.score === best.score && e.lastUsedAt < best.lastUsedAt)
      ) {
        best = { id, score: e.score, lastUsedAt: e.lastUsedAt }
      }
    }
    return best ? best.id : null
  }

  earliestRecovery(ids: string[]): { id: string; at: number } | null {
    let soonest: { id: string; at: number } | null = null
    for (const id of ids) {
      const e = this.entries.get(id)
      if (!e || e.disabled) continue
      if (e.cooldownUntil <= 0) return { id, at: 0 }
      if (!soonest || e.cooldownUntil < soonest.at) {
        soonest = { id, at: e.cooldownUntil }
      }
    }
    return soonest
  }

  snapshot(id: string): HealthSnapshot | null {
    const e = this.entries.get(id)
    if (!e) return null
    const now = Date.now()
    return {
      id: e.id,
      score: e.score,
      recentSuccesses: e.recentSuccesses,
      recentFailures: e.recentFailures,
      cooldownRemaining: Math.max(0, e.cooldownUntil - now),
      disabled: e.disabled,
      lastUsedAt: e.lastUsedAt,
    }
  }

  snapshotAll(): HealthSnapshot[] {
    const now = Date.now()
    const out: HealthSnapshot[] = []
    this.entries.forEach(e => {
      out.push({
        id: e.id,
        score: e.score,
        recentSuccesses: e.recentSuccesses,
        recentFailures: e.recentFailures,
        cooldownRemaining: Math.max(0, e.cooldownUntil - now),
        disabled: e.disabled,
        lastUsedAt: e.lastUsedAt,
      })
    })
    return out
  }

  private ensure(id: string): Entry {
    this.register(id)
    return this.entries.get(id)!
  }
}

function mixEMA(prev: number, target: number, alpha: number): number {
  const v = prev * (1 - alpha) + target * alpha
  return Math.max(0, Math.min(1, v))
}

// ─── Rotation manager ────────────────────────────────────────────

function accountId(a: AntigravityAccount): string {
  return a.email
}

function clampIndex(i: number | undefined, len: number): number {
  if (len === 0) return 0
  if (i == null) return 0
  if (i < 0) return 0
  if (i >= len) return len - 1
  return i
}

export class AntigravityRotation {
  private store: AntigravityStore
  private tracker = new HealthScoreTracker({
    successAlpha: 0.3,
    failureAlpha: 0.5,
    defaultRateLimitMs: 60_000,
    hardFailureDisableAfter: 5,
  })

  constructor() {
    this.store = loadStore()
    for (const account of this.store.accounts) {
      this.tracker.register(accountId(account))
      if (!account.enabled) this.tracker.disable(accountId(account))
    }
  }

  /** Rebuild from disk. Useful after the OAuth flow added an account. */
  refresh(): void {
    this.store = loadStore()
    for (const account of this.store.accounts) {
      if (!this.tracker.has(accountId(account))) {
        this.tracker.register(accountId(account))
      }
      if (!account.enabled) this.tracker.disable(accountId(account))
    }
  }

  // ── Account management ───────────────────────────────────────────

  list(): AntigravityAccount[] {
    return this.store.accounts.slice()
  }

  add(account: AntigravityAccount): { ok: boolean; reason?: string } {
    if (this.store.accounts.length >= MAX_ACCOUNTS) {
      return {
        ok: false,
        reason: `max ${MAX_ACCOUNTS} accounts reached`,
      }
    }
    const existingIdx = this.store.accounts.findIndex(
      a => a.email === account.email,
    )
    if (existingIdx >= 0) {
      this.store.accounts[existingIdx] = {
        ...this.store.accounts[existingIdx]!,
        ...account,
        enabled: true,
      }
    } else {
      this.store.accounts.push(account)
    }
    this.tracker.register(accountId(account))
    this.tracker.reenable(accountId(account))
    saveStore(this.store)
    return { ok: true }
  }

  remove(email: string): boolean {
    const idx = this.store.accounts.findIndex(a => a.email === email)
    if (idx < 0) return false
    const removed = this.store.accounts.splice(idx, 1)[0]!
    this.tracker.unregister(accountId(removed))
    this.store.activeIndex = clampIndex(
      this.store.activeIndex,
      this.store.accounts.length,
    )
    for (const k of Object.keys(this.store.activeIndexByFamily)) {
      this.store.activeIndexByFamily[k] = clampIndex(
        this.store.activeIndexByFamily[k],
        this.store.accounts.length,
      )
    }
    saveStore(this.store)
    return true
  }

  // ── Selection ────────────────────────────────────────────────────

  /**
   * Pick the best account for a given model family. Strategy:
   *   1. Consider only enabled accounts not in cooldown.
   *   2. Prefer the per-family active account if it's still healthy.
   *   3. Otherwise fall back to highest-score available.
   *   4. Returns null if every account is disabled or cooling.
   */
  pickForFamily(family: AntigravityFamily): AntigravityAccount | null {
    const eligibleIds = this.store.accounts
      .filter(a => a.enabled)
      .map(accountId)

    const preferredIdx =
      this.store.activeIndexByFamily[family] ?? this.store.activeIndex
    const preferred = this.store.accounts[preferredIdx]
    if (preferred && preferred.enabled) {
      const snap = this.tracker.snapshot(accountId(preferred))
      if (snap && !snap.disabled && snap.cooldownRemaining <= 0) {
        return preferred
      }
    }

    const pickId = this.tracker.pickBest(eligibleIds)
    if (!pickId) return null
    const picked =
      this.store.accounts.find(a => accountId(a) === pickId) ?? null
    if (picked) {
      this.store.activeIndexByFamily[family] =
        this.store.accounts.indexOf(picked)
      saveStore(this.store)
    }
    return picked
  }

  hasAccounts(): boolean {
    return this.store.accounts.length > 0
  }

  hasAvailableAccount(): boolean {
    return (
      this.pickForFamily('gemini-pro') != null ||
      this.pickForFamily('gemini-flash') != null ||
      this.pickForFamily('claude') != null
    )
  }

  pickForModel(model: string): AntigravityAccount | null {
    return this.pickForFamily(familyForAntigravityModel(model))
  }

  /** Look up the next time any eligible account comes out of cooldown. */
  nextRecoveryAt(): number | null {
    const ids = this.store.accounts.filter(a => a.enabled).map(accountId)
    const rec = this.tracker.earliestRecovery(ids)
    return rec ? rec.at : null
  }

  // ── Feedback ─────────────────────────────────────────────────────

  recordSuccess(account: AntigravityAccount): void {
    this.tracker.recordSuccess(accountId(account))
    account.lastUsed = Date.now()
    saveStore(this.store)
  }

  /**
   * Record a rate-limit hit for a specific family. The cooldown applies
   * at the account level (account is ineligible for any family until
   * it expires); we also stamp the family-specific reset time on the
   * account for UI / diagnostics.
   */
  recordRateLimit(
    account: AntigravityAccount,
    family: AntigravityFamily,
    cooldownMs?: number,
  ): void {
    this.tracker.recordRateLimit(accountId(account), cooldownMs)
    account.rateLimitResetTimes[family] = cooldownMs
      ? Date.now() + cooldownMs
      : null
    saveStore(this.store)
  }

  recordHardFailure(account: AntigravityAccount): void {
    this.tracker.recordFailure(accountId(account))
    const snap = this.tracker.snapshot(accountId(account))
    if (snap?.disabled) {
      account.enabled = false
    }
    saveStore(this.store)
  }

  reenable(email: string): boolean {
    const a = this.store.accounts.find(x => x.email === email)
    if (!a) return false
    a.enabled = true
    this.tracker.reenable(accountId(a))
    saveStore(this.store)
    return true
  }

  // ── Diagnostics ──────────────────────────────────────────────────

  health(): HealthSnapshot[] {
    return this.tracker.snapshotAll()
  }

  /**
   * Read-only view of the currently-selected account per family. Unlike
   * `pickForFamily`, this never mutates the store or runs the picker —
   * safe to call from UI render loops.
   */
  peekActivePerFamily(): Partial<Record<AntigravityFamily, string>> {
    const out: Partial<Record<AntigravityFamily, string>> = {}
    for (const family of ['gemini-pro', 'gemini-flash', 'claude'] as const) {
      const idx =
        this.store.activeIndexByFamily[family] ?? this.store.activeIndex
      const a = this.store.accounts[idx]
      if (a) out[family] = a.email
    }
    return out
  }
}

// ─── Singleton ───────────────────────────────────────────────────

let _singleton: AntigravityRotation | null = null

/** Process-wide singleton — lazy so tests can avoid touching disk. */
export function getAntigravityRotation(): AntigravityRotation {
  if (!_singleton) _singleton = new AntigravityRotation()
  return _singleton
}

/** Test helper: reset the singleton so a fresh instance loads from disk. */
export function _resetAntigravityRotationForTest(): void {
  _singleton = null
}
