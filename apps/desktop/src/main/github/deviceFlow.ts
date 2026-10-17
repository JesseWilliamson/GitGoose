/**
 * The OAuth device flow (RFC 8628), as GitHub implements it. Plain Node: fetch and sleep are
 * passed in, so the tests drive it against a fake server without waiting real seconds.
 *
 *   1. POST /login/device/code             -> a user code to show, a device code to keep
 *   2. the user types the code at github.com/login/device and approves
 *   3. POST /login/oauth/access_token, every `interval` seconds, until it answers with a token
 *
 * No client secret anywhere: that is the point of this flow for a desktop app, whose binary
 * anyone can unpack.
 */

export interface GitHubEndpoints {
  /** https://github.com (the OAuth endpoints live on the web host) */
  web: string
  /** https://api.github.com */
  api: string
  /** The OAuth App's public client id. Empty when the build has none configured. */
  clientId: string
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

export type DeviceFlowErrorCode = 'not_configured' | 'access_denied' | 'expired_token' | 'cancelled' | 'bad_response' | 'network'

const MESSAGES: Record<DeviceFlowErrorCode, string> = {
  not_configured: 'GitHub sign-in is not configured in this build (no OAuth client id).',
  access_denied: 'Sign-in was cancelled on GitHub.',
  expired_token: 'The code expired before it was entered. Start again for a new one.',
  cancelled: 'Sign-in cancelled.',
  bad_response: 'GitHub answered something unexpected.',
  network: 'Could not reach GitHub.',
}

export class DeviceFlowError extends Error {
  constructor(readonly code: DeviceFlowErrorCode, detail?: string) {
    super(detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code])
    this.name = 'DeviceFlowError'
  }
}

export interface FlowDeps {
  fetch: typeof fetch
  /** Resolves after `ms`, or rejects when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DeviceFlowError('cancelled'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new DeviceFlowError('cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function post(deps: FlowDeps, url: string, form: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    })
  } catch (e) {
    if (signal?.aborted) throw new DeviceFlowError('cancelled')
    throw new DeviceFlowError('network', (e as Error).message)
  }
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    throw new DeviceFlowError('bad_response', `HTTP ${res.status}`)
  }
}

export async function requestDeviceCode(ep: GitHubEndpoints, scopes: readonly string[], deps: FlowDeps, signal?: AbortSignal): Promise<DeviceCode> {
  if (!ep.clientId) throw new DeviceFlowError('not_configured')
  const d = await post(deps, `${ep.web}/login/device/code`, { client_id: ep.clientId, scope: scopes.join(' ') }, signal)
  if (typeof d.device_code !== 'string' || typeof d.user_code !== 'string' || typeof d.verification_uri !== 'string') {
    throw new DeviceFlowError('bad_response', typeof d.error === 'string' ? d.error : undefined)
  }
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    expiresIn: typeof d.expires_in === 'number' ? d.expires_in : 900,
    interval: typeof d.interval === 'number' ? d.interval : 5,
  }
}

/** Poll until the user approves. Resolves with the token and the scopes actually granted. */
export async function pollForToken(ep: GitHubEndpoints, code: DeviceCode, deps: FlowDeps, signal?: AbortSignal): Promise<{ token: string; scopes: string[] }> {
  const sleep = deps.sleep ?? abortableSleep
  const now = deps.now ?? Date.now
  const deadline = now() + code.expiresIn * 1000
  let interval = code.interval
  for (;;) {
    await sleep(interval * 1000, signal)
    if (now() > deadline) throw new DeviceFlowError('expired_token')
    let d: Record<string, unknown>
    try {
      d = await post(deps, `${ep.web}/login/oauth/access_token`, {
        client_id: ep.clientId,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }, signal)
    } catch (e) {
      // A dropped connection while the user is still typing the code is not fatal: try again.
      if (e instanceof DeviceFlowError && e.code === 'network') continue
      throw e
    }
    if (typeof d.access_token === 'string') {
      const scopes = typeof d.scope === 'string' ? d.scope.split(/[\s,]+/).filter(Boolean) : []
      return { token: d.access_token, scopes }
    }
    switch (d.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        // RFC 8628: add 5 seconds; GitHub also sends the new interval, which wins when present.
        interval = typeof d.interval === 'number' ? d.interval : interval + 5
        continue
      case 'expired_token':
        throw new DeviceFlowError('expired_token')
      case 'access_denied':
        throw new DeviceFlowError('access_denied')
      default:
        throw new DeviceFlowError('bad_response', typeof d.error === 'string' ? d.error : undefined)
    }
  }
}
