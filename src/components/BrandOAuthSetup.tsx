/**
 * Generic OAuth setup screen for the Tau Tier 2 brand providers:
 * Copilot, KiloCode, Cline, Cursor, Kiro.
 *
 * Each preset's flow is slightly different (device-code vs auth-code vs
 * browser-poll), but the user-facing states are the same: starting →
 * awaiting-browser → done|error. The provider-specific pieces (display
 * code, verification URL, token wiring) are dispatched on `preset`.
 *
 * The component returns the access token via `onConfigured` once the flow
 * completes; the caller is responsible for saving a provider profile with
 * that token in the apiKey slot. For Copilot the access token is the
 * Copilot internal token (refreshable); for the others it's whatever each
 * brand's "/auth/token" endpoint returns.
 */

import * as React from 'react'

import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import {
  initiateCopilotOAuth,
  completeCopilotOAuth,
} from '../services/oauth/copilot.js'
import {
  initiateKiloCodeOAuth,
  completeKiloCodeOAuth,
} from '../services/oauth/kilocode.js'
import { startClineOAuth } from '../services/oauth/cline.js'
import { startCursorOAuth } from '../services/oauth/cursor.js'
import {
  initiateKiroOAuth,
  completeKiroOAuth,
} from '../services/oauth/kiro.js'
import { openBrowser } from '../utils/browser.js'
import { Select } from './CustomSelect/index.js'

export type BrandPreset = 'copilot' | 'kilocode' | 'cline' | 'cursor' | 'kiro'

interface BrandConfig {
  label: string
  blurb: string
  /** Set when the lane is not yet wired — UI shows a "auth only" warning before login. */
  laneNotWired?: boolean
}

const BRAND_CONFIG: Record<BrandPreset, BrandConfig> = {
  copilot: {
    label: 'GitHub Copilot',
    blurb:
      'Sign in via GitHub device-code; Stratagem exchanges the GitHub token for a Copilot internal token (~30 min TTL, auto-refreshed).',
  },
  kilocode: {
    label: 'KiloCode',
    blurb:
      'Sign in via KiloCode device-auth (api.kilo.ai). Tokens are long-lived; re-login is required if revoked.',
  },
  cline: {
    label: 'Cline',
    blurb:
      'Sign in via Cline browser auth (api.cline.bot). Tau notes: Kimi K2.6 routes here at low cost.',
  },
  cursor: {
    label: 'Cursor',
    blurb:
      'Sign in via cursor.com browser login. Tunnels into your existing Cursor IDE subscription.',
    laneNotWired: true,
  },
  kiro: {
    label: 'Kiro',
    blurb:
      'Sign in via AWS SSO Builder ID device-code. Largest free-credit pool of the five per Tau notes.',
    laneNotWired: true,
  },
}

type SetupState =
  | { state: 'intro' }
  | { state: 'starting' }
  | {
      state: 'awaiting'
      authUrl?: string
      userCode?: string
      verificationUri?: string
    }
  | { state: 'error'; message: string }
  | { state: 'done'; accessToken: string }

interface Props {
  preset: BrandPreset
  onBack: () => void
  onConfigured: (accessToken: string) => void | Promise<void>
}

export function BrandOAuthSetup({
  preset,
  onBack,
  onConfigured,
}: Props): React.ReactNode {
  const config = BRAND_CONFIG[preset]
  const [status, setStatus] = React.useState<SetupState>({ state: 'intro' })

  useKeybinding('confirm:no', () => {
    if (status.state === 'intro' || status.state === 'error') onBack()
  })

  const onConfiguredRef = React.useRef(onConfigured)
  React.useEffect(() => {
    onConfiguredRef.current = onConfigured
  }, [onConfigured])

  const startFlow = React.useCallback(() => {
    setStatus({ state: 'starting' })
    void (async () => {
      try {
        const accessToken = await runOAuthFlow(preset, setStatus)
        setStatus({ state: 'done', accessToken })
        await onConfiguredRef.current(accessToken)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        setStatus({ state: 'error', message })
      }
    })()
  }, [preset])

  if (status.state === 'intro') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {config.label} uplink
        </Text>
        <Text dimColor>{config.blurb}</Text>
        {config.laneNotWired ? (
          <Text color="warning">
            Note: model calls aren't yet wired for {config.label} (proprietary
            wire format). OAuth login works, but requests will error until the
            lane lands. You can still link the account.
          </Text>
        ) : null}
        <Select
          options={[
            {
              value: 'cancel',
              label: 'Cancel',
              description: 'Return to provider presets',
            },
            {
              value: 'go',
              label: `Sign in to ${config.label}`,
              description: 'Open browser and complete OAuth',
            },
          ]}
          onChange={(value: string) => {
            if (value === 'go') startFlow()
            else onBack()
          }}
          onCancel={onBack}
          visibleOptionCount={2}
        />
      </Box>
    )
  }

  if (status.state === 'error') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error" bold>
          {config.label} OAuth failed
        </Text>
        <Text>{status.message}</Text>
        <Text dimColor>Press Esc to go back.</Text>
        <Select
          options={[
            { value: 'back', label: 'Back', description: 'Return' },
          ]}
          onChange={onBack}
          onCancel={onBack}
          visibleOptionCount={1}
        />
      </Box>
    )
  }

  if (status.state === 'done') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {config.label} uplink linked
        </Text>
        <Text dimColor>Finishing setup...</Text>
      </Box>
    )
  }

  // starting / awaiting
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="remember" bold>
        {config.label} OAuth
      </Text>
      {status.state === 'starting' ? (
        <Text dimColor>Starting authorization flow…</Text>
      ) : (
        <>
          {status.userCode ? (
            <Box flexDirection="column">
              <Text>
                Enter this code in the browser if prompted:{' '}
                <Text bold color="warning">
                  {status.userCode}
                </Text>
              </Text>
              {status.verificationUri ? (
                <Text dimColor>URL: {status.verificationUri}</Text>
              ) : null}
            </Box>
          ) : (
            <Text dimColor>
              Browser opened. Finish the sign-in there and this setup will
              complete automatically.
            </Text>
          )}
          {status.authUrl && !status.userCode ? (
            <Text dimColor>{status.authUrl}</Text>
          ) : null}
        </>
      )}
      <Text dimColor>Esc cancels only before sign-in completes.</Text>
    </Box>
  )
}

async function runOAuthFlow(
  preset: BrandPreset,
  setStatus: (s: SetupState) => void,
): Promise<string> {
  switch (preset) {
    case 'copilot': {
      const handles = await initiateCopilotOAuth()
      setStatus({
        state: 'awaiting',
        userCode: handles.userCode,
        verificationUri: handles.verificationUri,
      })
      await openBrowser(handles.verificationUri)
      const tokens = await completeCopilotOAuth(handles)
      return tokens.accessToken
    }
    case 'kilocode': {
      const handles = await initiateKiloCodeOAuth()
      setStatus({
        state: 'awaiting',
        verificationUri: handles.verificationUrl,
      })
      await openBrowser(handles.verificationUrl)
      const tokens = await completeKiloCodeOAuth(handles)
      return tokens.accessToken
    }
    case 'cline': {
      setStatus({ state: 'awaiting' })
      const result = await startClineOAuth()
      return result.accessToken
    }
    case 'cursor': {
      setStatus({ state: 'awaiting' })
      const result = await startCursorOAuth()
      return result.accessToken
    }
    case 'kiro': {
      const handles = await initiateKiroOAuth()
      setStatus({
        state: 'awaiting',
        userCode: handles.userCode,
        verificationUri:
          handles.verificationUriComplete || handles.verificationUri,
      })
      await openBrowser(handles.verificationUriComplete || handles.verificationUri)
      const tokens = await completeKiroOAuth(handles)
      return tokens.accessToken
    }
  }
}
