import { expect, test } from 'bun:test'
import {
  applyAutonomyModeToPermissionContext,
  autonomyModeToPermissionMode,
  getNextAutonomyMode,
} from './autonomy.ts'
import type { ToolPermissionContext } from '../Tool.js'

function context(overrides: Partial<ToolPermissionContext> = {}): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    isAutoModeAvailable: true,
    ...overrides,
  }
}

test('getNextAutonomyMode cycles off -> plan -> smart -> aggressive -> off', () => {
  expect(getNextAutonomyMode('off')).toBe('plan')
  expect(getNextAutonomyMode('plan')).toBe('smart')
  expect(getNextAutonomyMode('smart')).toBe('aggressive')
  expect(getNextAutonomyMode('aggressive')).toBe('off')
})

test('autonomyModeToPermissionMode maps plan to plan', () => {
  expect(autonomyModeToPermissionMode('plan', context())).toBe('plan')
})

test('autonomyModeToPermissionMode maps aggressive to bypass permissions', () => {
  expect(autonomyModeToPermissionMode('aggressive', context())).toBe(
    'bypassPermissions',
  )
})

test('applyAutonomyModeToPermissionContext enables bypass availability for aggressive mode', () => {
  const result = applyAutonomyModeToPermissionContext(context(), 'aggressive')

  expect(result.mode).toBe('bypassPermissions')
  expect(result.isBypassPermissionsModeAvailable).toBe(true)
})
