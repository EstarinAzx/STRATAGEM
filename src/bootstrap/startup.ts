/**
 * Startup lifecycle helpers extracted from main.tsx.
 *
 * Contains self-contained startup concerns:
 * - Config migrations
 * - Startup telemetry logging
 * - Settings loading from CLI flags
 * - Entrypoint detection
 */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { readFileSync } from 'fs'

import { isAnalyticsDisabled } from 'src/services/analytics/config.js'
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { errorMessage, isENOENT } from '../utils/errors.js'
import { getFsImplementation, safeResolvePath } from '../utils/fsOperations.js'
import { safeParseJSON } from '../utils/json.js'
import { logError } from '../utils/log.js'
import { generateTempFilePath } from '../utils/tempfile.js'
import { writeFileSync_DEPRECATED } from '../utils/slowOperations.js'
import { getGlobalConfig, isAutoUpdaterDisabled, saveGlobalConfig } from '../utils/config.js'
import { getIsGit, getWorktreeCount } from '../utils/git.js'
import { getGhAuthStatus } from '../utils/github/ghAuthStatus.js'
import { SandboxManager } from '../utils/sandbox/sandbox-adapter.js'
import { getInitialSettings, getManagedSettingsKeysForLogging, getSettingsForSource } from '../utils/settings/settings.js'
import { hasNodeOption } from '../utils/envUtils.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import { setAllowedSettingSources, setFlagSettingsPath } from './state.js'
import { parseSettingSourcesFlag } from '../utils/settings/constants.js'
import { profileCheckpoint } from '../utils/startupProfiler.js'
import { eagerParseCliFlag } from 'src/utils/cliArgs.js'
import { isRunningWithBun } from '../utils/bundledMode.js'
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from '../utils/model/model.js'
import { getContextWindowForModel } from '../utils/context.js'
import { logSkillsLoaded } from '../utils/telemetry/skillLoadedEvent.js'
import { logPluginLoadErrors, logPluginsEnabledForSession } from '../utils/telemetry/pluginTelemetry.js'
import { loadAllPluginsCacheOnly } from '../utils/plugins/pluginLoader.js'
import { getManagedPluginNames } from '../utils/plugins/managedPlugins.js'
import { getPluginSeedDirs } from '../utils/plugins/pluginDirectories.js'
import { getCwd } from 'src/utils/cwd.js'
import { getInitialMainLoopModel, getSdkBetas } from './state.js'

// Migrations
import { migrateAutoUpdatesToSettings } from '../migrations/migrateAutoUpdatesToSettings.js'
import { migrateBypassPermissionsAcceptedToSettings } from '../migrations/migrateBypassPermissionsAcceptedToSettings.js'
import { migrateEnableAllProjectMcpServersToSettings } from '../migrations/migrateEnableAllProjectMcpServersToSettings.js'
import { migrateFennecToOpus } from '../migrations/migrateFennecToOpus.js'
import { migrateLegacyOpusToCurrent } from '../migrations/migrateLegacyOpusToCurrent.js'
import { migrateOpusToOpus1m } from '../migrations/migrateOpusToOpus1m.js'
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from '../migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.js'
import { migrateSonnet1mToSonnet45 } from '../migrations/migrateSonnet1mToSonnet45.js'
import { migrateSonnet45ToSonnet46 } from '../migrations/migrateSonnet45ToSonnet46.js'
import { resetAutoModeOptInForDefaultOffer } from '../migrations/resetAutoModeOptInForDefaultOffer.js'
import { resetProToOpusDefault } from '../migrations/resetProToOpusDefault.js'
import { migrateChangelogFromConfig } from '../utils/releaseNotes.js'

// @[MODEL LAUNCH]: Consider any migrations you may need for model strings.
// See migrateSonnet1mToSonnet45.ts for an example.
// Bump this when adding a new sync migration so existing users re-run the set.
export const CURRENT_MIGRATION_VERSION = 11

export function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings()
    migrateBypassPermissionsAcceptedToSettings()
    migrateEnableAllProjectMcpServersToSettings()
    resetProToOpusDefault()
    migrateSonnet1mToSonnet45()
    migrateLegacyOpusToCurrent()
    migrateSonnet45ToSonnet46()
    migrateOpusToOpus1m()
    migrateReplBridgeEnabledToRemoteControlAtStartup()
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer()
    }
    if ("external" === 'ant') {
      migrateFennecToOpus()
    }
    saveGlobalConfig(prev =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION
        ? prev
        : {
            ...prev,
            migrationVersion: CURRENT_MIGRATION_VERSION,
          },
    )
  }
  // Async migration - fire and forget since it's non-blocking
  migrateChangelogFromConfig().catch(() => {
    // Silently ignore migration errors - will retry on next startup
  })
}

/**
 * Log managed settings keys to Statsig for analytics.
 * Called after init() completes to ensure settings are loaded
 * and environment variables are applied before model resolution.
 */
export function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings')
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings)
      logEvent('tengu_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(
          ',',
        ) as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  } catch {
    // Silently ignore errors - this is just for analytics
  }
}

// Check if running in debug/inspection mode
export function isBeingDebugged(): boolean {
  const isBun = isRunningWithBun()

  // Check for inspect flags in process arguments (including all variants)
  const hasInspectArg = process.execArgv.some(arg => {
    if (isBun) {
      return /--inspect(-brk)?/.test(arg)
    } else {
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg)
    }
  })

  const hasInspectEnv = isEnvTruthy(process.env.NODE_OPTIONS?.match(/--inspect(-brk)?/)?.[0])

  // Check for active inspector sessions (V8 inspector)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inspector = require('node:inspector')
    const hasInspectorUrl = !!inspector.url()
    return hasInspectorUrl || hasInspectArg || hasInspectEnv
  } catch {
    // Ignore error and fall back to argument detection
    return hasInspectArg || hasInspectEnv
  }
}

function getCertEnvVarTelemetry(): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  if (process.env.NODE_EXTRA_CA_CERTS) {
    result.has_node_extra_ca_certs = true
  }
  if (process.env.CLAUDE_CODE_CLIENT_CERT) {
    result.has_client_cert = true
  }
  if (hasNodeOption('--use-system-ca')) {
    result.has_use_system_ca = true
  }
  if (hasNodeOption('--use-openssl-ca')) {
    result.has_use_openssl_ca = true
  }
  return result
}

export async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) return
  const [isGit, worktreeCount, ghAuthStatus] = await Promise.all([
    getIsGit(),
    getWorktreeCount(),
    getGhAuthStatus(),
  ])
  logEvent('tengu_startup_telemetry', {
    is_git: isGit,
    worktree_count: worktreeCount,
    gh_auth_status:
      ghAuthStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sandbox_enabled: SandboxManager.isSandboxingEnabled(),
    are_unsandboxed_commands_allowed: SandboxManager.areUnsandboxedCommandsAllowed(),
    is_auto_bash_allowed_if_sandbox_enabled:
      SandboxManager.isAutoAllowBashIfSandboxedEnabled(),
    auto_updater_disabled: isAutoUpdaterDisabled(),
    prefers_reduced_motion: getInitialSettings().prefersReducedMotion ?? false,
    ...getCertEnvVarTelemetry(),
  })
}

/**
 * Per-session skill/plugin telemetry. Called from both the interactive path
 * and the headless -p path (before runHeadless) — both go through
 * main.tsx but branch before the interactive startup path, so it needs two
 * call sites here rather than one here + one in QueryEngine.
 */
export function logSessionTelemetry(): void {
  const model = parseUserSpecifiedModel(
    getInitialMainLoopModel() ?? getDefaultMainLoopModel(),
  )
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model, getSdkBetas()))
  void loadAllPluginsCacheOnly()
    .then(({ enabled, errors }) => {
      const managedNames = getManagedPluginNames()
      logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs())
      logPluginLoadErrors(errors, managedNames)
    })
    .catch(err => logError(err))
}

export function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim()
    const looksLikeJson = trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}')
    let settingsPath: string
    if (looksLikeJson) {
      const parsedJson = safeParseJSON(trimmedSettings)
      if (!parsedJson) {
        process.stderr.write(chalk.red('Error: Invalid JSON provided to --settings\n'))
        process.exit(1)
      }
      settingsPath = generateTempFilePath('claude-settings', '.json', {
        contentHash: trimmedSettings,
      })
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8')
    } else {
      const { resolvedPath: resolvedSettingsPath } = safeResolvePath(
        getFsImplementation(),
        settingsFile,
      )
      try {
        readFileSync(resolvedSettingsPath, 'utf8')
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(
            chalk.red(`Error: Settings file not found: ${resolvedSettingsPath}\n`),
          )
          process.exit(1)
        }
        throw e
      }
      settingsPath = resolvedSettingsPath
    }
    setFlagSettingsPath(settingsPath)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(chalk.red(`Error processing settings: ${errorMessage(error)}\n`))
    process.exit(1)
  }
}

export function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg)
    setAllowedSettingSources(sources)
    resetSettingsCache()
  } catch (error) {
    if (error instanceof Error) {
      logError(error)
    }
    process.stderr.write(
      chalk.red(`Error processing --setting-sources: ${errorMessage(error)}\n`),
    )
    process.exit(1)
  }
}

/**
 * Parse and load settings flags early, before init()
 * This ensures settings are filtered from the start of initialization
 */
export function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start')
  const settingsFile = eagerParseCliFlag('--settings')
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile)
  }

  const settingSourcesArg = eagerParseCliFlag('--setting-sources')
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg)
  }
  profileCheckpoint('eagerLoadSettings_end')
}

export function initializeEntrypoint(isNonInteractive: boolean): void {
  // Skip if already set (e.g., by SDK or other entrypoints)
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    return
  }
  const cliArgs = process.argv.slice(2)

  // Check for MCP serve command (handle flags before mcp serve, e.g., --debug mcp serve)
  const mcpIndex = cliArgs.indexOf('mcp')
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'mcp'
    return
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ACTION)) {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-code-github-action'
    return
  }

  // Set based on interactive status
  process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli'
}
