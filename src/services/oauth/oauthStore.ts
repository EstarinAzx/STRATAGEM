/**
 * Generic single-file OAuth blob store.
 *
 * Each Tau-style OAuth provider (Cline, KiloCode, Copilot, Kiro, Cursor)
 * stores one token blob keyed by provider name in a single JSON file:
 *
 *   <stratagemConfigDir>/oauth-tokens.json
 *
 * The blob is the same shape Tau uses (accessToken / refreshToken /
 * expiresAt / meta), kept domain-free so the provider modules only worry
 * about their flow specifics. Atomic write via temp + rename; 0600 perms
 * on POSIX. Antigravity is intentionally NOT in this store — its
 * multi-account file (`antigravity-accounts.json`) predates this and has
 * a different shape.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'

import { resolveClaudeConfigHomeDir } from '../../utils/envUtils.js'

export interface StoredOAuthBlob {
  accessToken: string
  refreshToken?: string
  /** Epoch ms. Absent for tokens with no known expiry. */
  expiresAt?: number
  /** Provider-specific extras (orgId, profileArn, planSku, …). */
  meta?: Record<string, unknown>
}

interface StoreFile {
  version: 1
  /** Map of provider key → blob. Undefined slots = no credentials. */
  tokens: Record<string, StoredOAuthBlob>
}

function storagePath(): string {
  return join(resolveClaudeConfigHomeDir(), 'oauth-tokens.json')
}

function loadFile(): StoreFile {
  const file = storagePath()
  if (!existsSync(file)) {
    return { version: 1, tokens: {} }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreFile>
    return {
      version: 1,
      tokens: parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {},
    }
  } catch {
    return { version: 1, tokens: {} }
  }
}

function saveFile(data: StoreFile): void {
  const dir = resolveClaudeConfigHomeDir()
  const file = storagePath()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  }
  try {
    chmodSync(file, 0o600)
  } catch {
    /* not supported on Windows */
  }
}

export function saveOAuth(
  providerKey: string,
  tokens: {
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    meta?: Record<string, unknown>
  },
): void {
  const data = loadFile()
  data.tokens[providerKey] = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
    meta: tokens.meta,
  }
  saveFile(data)
}

export function loadOAuth(providerKey: string): StoredOAuthBlob | null {
  const data = loadFile()
  return data.tokens[providerKey] ?? null
}

export function deleteOAuth(providerKey: string): void {
  const data = loadFile()
  if (providerKey in data.tokens) {
    delete data.tokens[providerKey]
    saveFile(data)
  }
}

export function listOAuthKeys(): string[] {
  return Object.keys(loadFile().tokens)
}

/**
 * Path of the token store for diagnostics. Surfaces in /doctor or /whoami
 * if someone wants to inspect the file directly.
 */
export function getOAuthStorePath(): string {
  return storagePath()
}
