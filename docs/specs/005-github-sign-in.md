# 005: Sign in with GitHub

PLAN-2 §9a. Code: `apps/desktop/src/main/github/` (main process only), `packages/shared/src/github.ts`
(pure rules), `components/AccountsPanel.tsx`. Tests: `main/github/github.test.ts`,
`shared/src/github.test.ts`, `e2e/github.spec.ts`, all against `fakeGitHub` from `@gitgoose/fixtures`.

## Behaviour

- Settings → Accounts → **Sign in with GitHub** starts the OAuth device flow: a dialog shows the
  user code, **Copy code and open GitHub** copies it and opens the verification page (main opens
  it, and only if it is on GitHub's host). The dialog waits; on approval it closes with a toast.
- Errors: `access_denied` ("cancelled on GitHub"), `expired_token` (code expired), network,
  unexpected answers. Each shows in the dialog with **Try again**. `authorization_pending` and
  `slow_down` (interval from GitHub, else +5 s) are waited out. Cancel stops polling.
- First grant asks for `read:user` only. Turning on *Use your GitHub sign-in for HTTPS push and
  fetch* shows **Grant access**, a second device flow for `repo`.
- **Sign out** forgets the token on this computer. GitHub's revoke API needs the client secret,
  which a desktop app cannot keep, so the panel links to github.com's authorized-apps page.
- Without an OAuth client id (`main/github/config.ts`, or `GITGOOSE_GITHUB_CLIENT_ID`) the panel
  says sign-in is not set up.

## What the token is used for

- **Avatars** (source *GitHub*): for an author without a noreply address, find their latest
  commit on a github.com remote's tracking refs (`--remotes=<remote>`, so only pushed commits)
  and ask `GET /repos/:o/:r/commits/:sha` for the account's avatar. Cached 30 days per email by
  the existing avatar cache, whose key includes the sign-in state; the renderer adds `?v=gh` to
  avatar URLs so the browser's own image cache is bypassed after signing in.
- **HTTPS push/fetch** (setting on and `repo` granted): the askpass broker answers
  `Username/Password for 'https://github.com'` itself (exact host match). While active,
  `credential.https://github.com.helper` is set to empty through `GIT_CONFIG_COUNT/KEY/VALUE`,
  so the user's credential helpers neither supply nor store the token for github.com.

## Storage

The token is encrypted with Electron `safeStorage` into `github.json` in the profile (mode 600,
atomic write). If there is no real keychain (Linux `basic_text` backend), the token is kept in
memory only and the panel says it will be asked for again after a restart.

## Network

None until the user clicks Sign in. Startup only reads the local file (status for avatar URLs).
