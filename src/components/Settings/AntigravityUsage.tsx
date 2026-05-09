/**
 * /usage view for the Antigravity provider.
 *
 * Antigravity does not expose a public quota endpoint — Google's Code
 * Assist proxy only signals exhaustion via 429 responses with a
 * RetryInfo.retryDelay. The rotation tracker observes those events and
 * stores per-family cooldowns on each account; this view surfaces that
 * locally-tracked state.
 *
 * Sources of truth:
 *   - AntigravityRotation (in-memory health tracker — score, cooldowns,
 *     recent successes/failures).
 *   - AntigravityStore on disk (per-family `rateLimitResetTimes`,
 *     `enabled` flag, `lastUsed`, the active-per-family index).
 */

import * as React from 'react'
import { useEffect, useState } from 'react'

import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  type AntigravityFamily,
  type HealthSnapshot,
  getAntigravityRotation,
} from '../../services/api/antigravityRotation.js'
import { type AntigravityAccount } from '../../services/oauth/antigravity.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'

const FAMILY_LABELS: Record<AntigravityFamily, string> = {
  'gemini-pro': 'Gemini Pro',
  'gemini-flash': 'Gemini Flash',
  claude: 'Claude (via Antigravity)',
}

const FAMILIES: AntigravityFamily[] = ['gemini-pro', 'gemini-flash', 'claude']

type Snapshot = {
  accounts: AntigravityAccount[]
  health: Map<string, HealthSnapshot>
  activePerFamily: Partial<Record<AntigravityFamily, string>>
}

function loadSnapshot(): Snapshot {
  const rotation = getAntigravityRotation()
  rotation.refresh()
  const accounts = rotation.list()
  const healthList = rotation.health()
  const health = new Map<string, HealthSnapshot>()
  for (const h of healthList) health.set(h.id, h)
  return {
    accounts,
    health,
    activePerFamily: rotation.peekActivePerFamily(),
  }
}

function formatRelativeMs(ms: number): string {
  if (ms <= 0) return 'now'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

function formatLastUsed(ts: number): string {
  if (!ts) return 'never'
  const ago = Date.now() - ts
  if (ago < 0) return 'just now'
  return `${formatRelativeMs(ago)} ago`
}

type StatusBadge = {
  label: string
  color: 'success' | 'warning' | 'error' | 'gray'
}

function statusFor(
  account: AntigravityAccount,
  snap: HealthSnapshot | undefined,
): StatusBadge {
  if (!account.enabled || snap?.disabled) {
    return { label: 'disabled', color: 'error' }
  }
  if (snap && snap.cooldownRemaining > 0) {
    return {
      label: `cooling ${formatRelativeMs(snap.cooldownRemaining)}`,
      color: 'warning',
    }
  }
  return { label: 'healthy', color: 'success' }
}

type FamilyState =
  | { kind: 'available' }
  | { kind: 'rate-limited'; resetMs: number }

function familyState(
  account: AntigravityAccount,
  family: AntigravityFamily,
): FamilyState {
  // Legacy stores split 'gemini' before pro/flash existed. Fall back so
  // accounts written by an older version still surface their reset time.
  const direct = account.rateLimitResetTimes[family]
  const legacy =
    family !== 'claude' ? account.rateLimitResetTimes['gemini'] : null
  const resetAt = direct ?? legacy
  if (resetAt && resetAt > Date.now()) {
    return { kind: 'rate-limited', resetMs: resetAt - Date.now() }
  }
  return { kind: 'available' }
}

function AccountCard({
  account,
  snap,
  isActiveFor,
  maxWidth,
}: {
  account: AntigravityAccount
  snap: HealthSnapshot | undefined
  isActiveFor: AntigravityFamily[]
  maxWidth: number
}): React.ReactNode {
  const status = statusFor(account, snap)
  const score = snap ? Math.round(snap.score * 100) : 50
  const successes = snap?.recentSuccesses ?? 0
  const failures = snap?.recentFailures ?? 0
  const labelWidth = Math.min(24, Math.max(14, Math.floor(maxWidth / 4)))

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{account.email}</Text>
        <Text color="gray"> · </Text>
        <Text color={status.color}>{status.label}</Text>
        {isActiveFor.length > 0 ? (
          <>
            <Text color="gray"> · active for </Text>
            <Text color="gray">{isActiveFor.join(', ')}</Text>
          </>
        ) : null}
      </Text>
      <Text color="gray">
        score {score}% · last used {formatLastUsed(account.lastUsed)} · {successes} ok / {failures} err
      </Text>
      {FAMILIES.map(family => {
        const fs = familyState(account, family)
        const label = FAMILY_LABELS[family].padEnd(labelWidth)
        return (
          <Text key={family}>
            <Text color="gray">  {label}</Text>
            {fs.kind === 'available' ? (
              <Text color="success">available</Text>
            ) : (
              <Text color="warning">
                rate-limited · resets in {formatRelativeMs(fs.resetMs)}
              </Text>
            )}
          </Text>
        )
      })}
    </Box>
  )
}

export function AntigravityUsage(): React.ReactNode {
  const { columns } = useTerminalSize()
  const maxWidth = Math.min(Math.max(columns - 2, 30), 80)
  const [snapshot, setSnapshot] = useState<Snapshot>(() => loadSnapshot())

  // Refresh on a 1s tick so the cooldown countdowns visibly tick down.
  useEffect(() => {
    const id = setInterval(() => setSnapshot(loadSnapshot()), 1000)
    return () => clearInterval(id)
  }, [])

  useKeybinding(
    'settings:retry',
    () => setSnapshot(loadSnapshot()),
    { context: 'Settings', isActive: true },
  )

  if (snapshot.accounts.length === 0) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="gray">
          No Antigravity accounts linked. Use /provider to add one.
        </Text>
        <Text color="gray">
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="Esc"
            description="cancel"
          />
        </Text>
      </Box>
    )
  }

  // Build "active for" list per account.
  const activePerAccount = new Map<string, AntigravityFamily[]>()
  for (const family of FAMILIES) {
    const email = snapshot.activePerFamily[family]
    if (!email) continue
    const list = activePerAccount.get(email) ?? []
    list.push(family)
    activePerAccount.set(email, list)
  }

  return (
    <Box flexDirection="column" gap={1} width="100%">
      <Text>
        <Text bold>Antigravity quota</Text>
        <Text color="gray"> · {snapshot.accounts.length} account{snapshot.accounts.length === 1 ? '' : 's'}</Text>
      </Text>

      {snapshot.accounts.map(account => (
        <AccountCard
          key={account.email}
          account={account}
          snap={snapshot.health.get(account.email)}
          isActiveFor={activePerAccount.get(account.email) ?? []}
          maxWidth={maxWidth}
        />
      ))}

      <Text color="gray">
        Quotas tracked locally from observed 429s — Google does not publish
        a quota API for Antigravity endpoints. Counts reset when this CLI
        session ends.
      </Text>

      <Text color="gray">
        <ConfigurableShortcutHint
          action="settings:retry"
          context="Settings"
          fallback="r"
          description="refresh"
        />
        {' · '}
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          fallback="Esc"
          description="cancel"
        />
      </Text>
    </Box>
  )
}
