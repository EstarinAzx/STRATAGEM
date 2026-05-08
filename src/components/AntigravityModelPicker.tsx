/**
 * Standalone antigravity-only model picker for /model.
 *
 * The default ModelPicker shows the full Anthropic model catalog. When
 * the active profile is antigravity, that catalog is misleading — most
 * Anthropic model ids aren't served by Antigravity, and picking one
 * results in "model X is not available on your antigravity deployment"
 * after the fact. This picker shows only the 5 valid Antigravity ids.
 */

import chalk from 'chalk'
import * as React from 'react'

import {
  ANTIGRAVITY_MODEL_OPTIONS,
  isAntigravityModelId,
} from '../providers/antigravityModels.js'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { getActiveProviderProfile, updateProviderProfile } from '../providers/providerProfiles.js'

interface Props {
  onDone: (
    message: string,
    options?: { display?: 'system' | 'user' },
  ) => void
}

export function AntigravityModelPicker({ onDone }: Props): React.ReactNode {
  const mainLoopModel = useAppState(s => s.mainLoopModel)
  const setAppState = useSetAppState()

  const handleSelect = React.useCallback(
    (model: string) => {
      // Persist the picked model on the active antigravity profile so
      // the choice survives restart. Then update appState so the next
      // request uses it immediately without re-running /provider.
      const active = getActiveProviderProfile()
      if (active?.provider === 'antigravity') {
        updateProviderProfile(active.id, {
          provider: 'antigravity',
          name: active.name,
          baseUrl: active.baseUrl,
          model,
          apiKey: '',
        })
      }
      setAppState(prev => ({
        ...prev,
        mainLoopModel: model,
        mainLoopModelForSession: null,
      }))
      // Also pin ANTHROPIC_MODEL so any code path that reads env wins.
      process.env.ANTHROPIC_MODEL = model

      const label =
        ANTIGRAVITY_MODEL_OPTIONS.find(m => m.id === model)?.label ?? model
      onDone(`Set Antigravity model to ${chalk.bold(label)}`, {
        display: 'system',
      })
    },
    [onDone, setAppState],
  )

  const handleCancel = React.useCallback(() => {
    const label =
      ANTIGRAVITY_MODEL_OPTIONS.find(m => m.id === mainLoopModel)?.label ??
      mainLoopModel
    onDone(`Kept Antigravity model as ${chalk.bold(label)}`, {
      display: 'system',
    })
  }, [mainLoopModel, onDone])

  // If the current model isn't a known antigravity id, surface that as a
  // hint at the top — it's the failure mode that brought users here.
  const currentIsValid = isAntigravityModelId(mainLoopModel ?? '')

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="remember" bold>
        Antigravity model
      </Text>
      <Text dimColor>
        The active uplink is Antigravity (Google OAuth). Only models in
        Antigravity's catalog work — Anthropic / OpenAI ids are rejected
        by the Code Assist proxy.
      </Text>
      {!currentIsValid && (
        <Text color="warning">
          Current model "{mainLoopModel}" is not in Antigravity's catalog.
          Pick one below to fix.
        </Text>
      )}
      <Select
        options={ANTIGRAVITY_MODEL_OPTIONS.map(m => ({
          value: m.id,
          label: m.label,
          description: m.description,
        }))}
        onChange={handleSelect}
        onCancel={handleCancel}
        visibleOptionCount={ANTIGRAVITY_MODEL_OPTIONS.length}
      />
    </Box>
  )
}
