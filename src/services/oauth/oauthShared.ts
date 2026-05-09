/**
 * Shared OAuth primitives for the Tau-style brand providers.
 *
 * - PKCE (S256)
 * - Local callback HTTP server with port-fallback
 * - JWT exp helpers
 * - Browser open
 *
 * Antigravity has its own copy of these because its callback path / port
 * is fixed (51121) and it predates this module. Don't unify the two
 * unless the Antigravity flow gets restructured.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createHash, randomBytes } from 'crypto'

export interface PKCEPair {
  verifier: string
  challenge: string
}

export function generatePKCE(): PKCEPair {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Decode a JWT's `exp` claim and convert to seconds-from-now. Returns
 * undefined for non-JWTs or tokens without a numeric exp. Used by
 * Cursor (whose accessToken is a JWT) to seed an expires_in value.
 */
export function getJwtExpirySeconds(token: string): number | undefined {
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
    ) as { exp?: number }
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      return undefined
    }
    const seconds = Math.floor(payload.exp - Date.now() / 1000)
    return seconds > 0 ? seconds : undefined
  } catch {
    return undefined
  }
}

const SUCCESS_PAGE = `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0b0f0a;color:#c8ff5c">
<div style="background:#111;padding:48px;border-radius:8px;border:1px solid #1f3d0a;text-align:center">
<h1 style="margin:0 0 8px">STRATAGEM uplink</h1>
<p style="opacity:.7">Authentication complete. You can close this tab.</p>
</div>
<script>setTimeout(()=>window.close(),1500)</script>
</body></html>`

export interface CallbackServerHandle {
  /** Actual port the server bound to (may differ from preferred if it was taken). */
  port: number
  /** Resolves with the search params once the browser hits the redirect. */
  params: Promise<URLSearchParams>
}

/**
 * Bind a local HTTP server to capture an OAuth redirect. Falls back to
 * an ephemeral port if the preferred port is taken. The server closes
 * itself after the first matching hit, or after 5 minutes of idleness.
 */
export function startCallbackServer(
  preferredPort: number,
  acceptedPaths: string[] = ['/callback', '/'],
): Promise<CallbackServerHandle> {
  return new Promise((resolveBind, rejectBind) => {
    let paramsResolve!: (p: URLSearchParams) => void
    let paramsReject!: (e: Error) => void
    const paramsPromise = new Promise<URLSearchParams>((res, rej) => {
      paramsResolve = res
      paramsReject = rej
    })

    const timeout = setTimeout(
      () => paramsReject(new Error('OAuth callback timed out (5 min)')),
      5 * 60 * 1000,
    )

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (acceptedPaths.includes(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(SUCCESS_PAGE)
        clearTimeout(timeout)
        server.close()
        paramsResolve(url.searchParams)
        return
      }
      res.writeHead(404).end()
    })

    let triedFallback = false
    const tryListen = (port: number) => {
      server.removeAllListeners('error')
      server.removeAllListeners('listening')
      server.once('listening', () => {
        const addr = server.address()
        const actualPort =
          addr && typeof addr === 'object' ? addr.port : port
        resolveBind({ port: actualPort, params: paramsPromise })
      })
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (
          (err.code === 'EACCES' || err.code === 'EADDRINUSE') &&
          !triedFallback
        ) {
          triedFallback = true
          tryListen(0)
          return
        }
        clearTimeout(timeout)
        rejectBind(err)
      })
      server.listen(port, '127.0.0.1')
    }
    tryListen(preferredPort)
  })
}
