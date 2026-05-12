import * as React from 'react'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import {
  applyAutonomyModeToPermissionContext,
  autonomyModeDescription,
  autonomyModeTitle,
  normalizeAutonomyMode,
  type AutonomyMode,
} from '../../utils/autonomy.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

const HELP =
  'Usage: /autonomy [off|plan|smart|aggressive|status]\n\nModes:\n- off: normal approvals\n- plan: read-only plan mode (no edits or shell side effects)\n- smart: classifier-driven autonomy\n- aggressive: bypass-style execution with no permission prompts'

function ShowCurrentAutonomy({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const autonomyMode = useAppState(s => s.settings.autonomyMode ?? 'off')
  React.useEffect(() => {
    onDone(
      `Autonomy ${autonomyModeTitle(normalizeAutonomyMode(autonomyMode))}: ${autonomyModeDescription(normalizeAutonomyMode(autonomyMode))}`,
    )
  }, [autonomyMode, onDone])
  return null
}

function ApplyAutonomyAndClose({
  autonomyMode,
  onDone,
}: {
  autonomyMode: AutonomyMode
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const setAppState = useSetAppState()
  React.useEffect(() => {
    const result = updateSettingsForSource('userSettings', {
      autonomyMode,
    })
    if (result.error) {
      onDone(`Failed to set autonomy mode: ${result.error.message}`)
      return
    }
    setAppState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        autonomyMode,
      },
      toolPermissionContext: applyAutonomyModeToPermissionContext(
        prev.toolPermissionContext,
        autonomyMode,
      ),
    }))
    onDone(
      `Autonomy ${autonomyModeTitle(autonomyMode)}: ${autonomyModeDescription(autonomyMode)}`,
    )
  }, [autonomyMode, onDone, setAppState])
  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  const normalized = (args?.trim().toLowerCase() ?? '')
  if (!normalized || normalized === 'status' || normalized === 'current') {
    return <ShowCurrentAutonomy onDone={onDone} />
  }
  if (normalized === 'help' || normalized === '-h' || normalized === '--help') {
    onDone(HELP)
    return null
  }
  if (
    normalized !== 'off' &&
    normalized !== 'plan' &&
    normalized !== 'smart' &&
    normalized !== 'aggressive'
  ) {
    onDone(`Invalid autonomy mode: ${args}.\n\n${HELP}`)
    return null
  }
  return (
    <ApplyAutonomyAndClose
      autonomyMode={normalized}
      onDone={onDone}
    />
  )
}
