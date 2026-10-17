import type { DeviceCodeInfo } from '@gitsquid/shared'
import { hasScope } from '@gitsquid/shared'
import { CircleAlert, Copy, ExternalLink, LogOut, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, toUiError } from '../lib/api'
import { loadGitHub, toast, useSetting, useStore } from '../lib/store'
import { Button, Modal, Spinner } from './ui'

/**
 * Settings → Accounts: GitHub sign-in (OAuth device flow, run by the main process).
 * Signing in asks for your profile only; repository access is a second, separate grant, asked
 * for when you turn on HTTPS push and fetch.
 */
export function AccountsPanel() {
  const status = useStore((s) => s.github)
  const https = useSetting('githubHttps')
  const [signIn, setSignIn] = useState<'basic' | 'repo' | null>(null)
  useEffect(() => {
    void loadGitHub()
  }, [])

  if (!status) return <div className="py-2"><Spinner /></div>
  const account = status.account
  return (
    <div className="mb-3 rounded-md border border-line p-3 text-[13px]" data-testid="github-account">
      <div className="flex items-center gap-3">
        <UserRound size={28} className="shrink-0 rounded-full bg-hover p-1 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">GitHub</div>
          {account ? (
            <div className="text-muted" data-testid="github-login">
              Signed in as <span className="text-fg">{account.login}</span>{account.name ? ` (${account.name})` : ''}
              {' · '}{hasScope(account, 'repo') ? 'profile and repositories' : 'profile only'}
            </div>
          ) : (
            <div className="text-muted">Avatars for every author, and HTTPS push and fetch if you want it.</div>
          )}
        </div>
        {!status.configured ? null : account ? (
          <Button size="sm" onClick={() => void api.githubSignOut()} data-testid="github-sign-out"><LogOut size={12} /> Sign out</Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => setSignIn('basic')} data-testid="github-sign-in">Sign in with GitHub</Button>
        )}
      </div>
      {!status.configured && (
        <p className="mt-2 text-xs text-muted">
          GitHub sign-in is not set up in this build: it needs an OAuth App client id (see src/main/github/config.ts).
        </p>
      )}
      {account && !status.persisted && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-warn">
          <CircleAlert size={13} className="mt-px shrink-0" />
          No system keychain was found, so the sign-in is kept in memory and you will be asked again after a restart.
        </p>
      )}
      {account && https && !hasScope(account, 'repo') && (
        <div className="mt-2 flex items-center gap-2 rounded bg-hover px-2 py-1.5 text-xs">
          <span className="flex-1">HTTPS push and fetch needs access to your repositories, which this sign-in does not have yet.</span>
          <Button size="sm" variant="primary" onClick={() => setSignIn('repo')} data-testid="github-grant-repo">Grant access</Button>
        </div>
      )}
      {status.configured && (
        <p className="mt-2 text-xs text-faint">
          Signing out forgets the sign-in on this computer. To remove GitSquid's access on GitHub too,{' '}
          <button className="text-accent hover:underline" onClick={() => void api.githubOpenPage('applications')}>manage it on github.com</button>.
        </p>
      )}
      {signIn && <SignInDialog access={signIn} onClose={() => setSignIn(null)} />}
    </div>
  )
}

type Phase = { k: 'starting' } | { k: 'code'; info: DeviceCodeInfo; copied: boolean } | { k: 'error'; message: string }

function SignInDialog({ access, onClose }: { access: 'basic' | 'repo'; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ k: 'starting' })
  const closed = useRef(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    closed.current = false
    setPhase({ k: 'starting' })
    void (async () => {
      try {
        const info = await api.githubSignIn(access)
        if (closed.current) return
        setPhase({ k: 'code', info, copied: false })
        const account = await api.githubWaitForSignIn()
        if (closed.current) return
        toast({ kind: 'success', title: `Signed in to GitHub as ${account.login}` })
        onClose()
      } catch (e) {
        if (!closed.current) setPhase({ k: 'error', message: toUiError(e).message })
      }
    })()
    return () => {
      closed.current = true
    }
    // onClose is stable enough: the dialog unmounts when it is called.
  }, [access, attempt])

  const cancel = () => {
    closed.current = true
    void api.githubCancelSignIn()
    onClose()
  }
  const copyAndOpen = async (info: DeviceCodeInfo) => {
    try {
      await navigator.clipboard.writeText(info.userCode)
    } catch {
      // The code is on screen anyway.
    }
    setPhase({ k: 'code', info, copied: true })
    void api.githubOpenPage('verification')
  }

  return (
    <Modal open onClose={cancel} title={access === 'repo' ? 'Give GitSquid access to your repositories' : 'Sign in with GitHub'} width={420}>
      <div className="text-[13px]" data-testid="github-dialog">
        {phase.k === 'starting' && <div className="flex items-center gap-2 text-muted"><Spinner /> Asking GitHub for a code…</div>}
        {phase.k === 'code' && (
          <>
            <p className="text-muted">Enter this code on GitHub to approve GitSquid:</p>
            <div className="my-3 text-center font-mono text-[28px] font-semibold tracking-[0.2em] select-all" data-testid="github-user-code">
              {phase.info.userCode}
            </div>
            <Button variant="primary" className="w-full" onClick={() => void copyAndOpen(phase.info)} data-testid="github-open">
              <Copy size={13} /> Copy code and open GitHub <ExternalLink size={12} />
            </Button>
            <div className="mt-3 flex items-center gap-2 text-xs text-muted">
              <Spinner /> {phase.copied ? 'Code copied. ' : ''}Waiting for you to approve on GitHub…
            </div>
            <p className="mt-2 text-xs text-faint">
              {access === 'repo'
                ? 'GitHub will ask to grant read and write access to your repositories (scope "repo"), used only to answer git\'s password prompt for github.com.'
                : 'GitHub will ask for read access to your profile (scope "read:user"). Nothing else.'}
            </p>
          </>
        )}
        {phase.k === 'error' && (
          <div className="flex items-start gap-2 text-del" data-testid="github-error">
            <CircleAlert size={15} className="mt-px shrink-0" /> <span>{phase.message}</span>
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          {phase.k === 'error' && <Button onClick={() => setAttempt((a) => a + 1)}>Try again</Button>}
          <Button onClick={cancel} data-testid="github-cancel">{phase.k === 'error' ? 'Close' : 'Cancel'}</Button>
        </div>
      </div>
    </Modal>
  )
}
