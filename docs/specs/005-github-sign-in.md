# 005: GitHub without signing in

Sign in with GitHub (the OAuth device flow, the token in the keychain, HTTPS push with it, the
Accounts settings) was removed on 2026-10-22. GitGoose holds no GitHub token and sends no
Authorization header. What remains asks GitHub as anyone may, for public data:

- **Pull request list** (sidebar, Workspace → Pull Requests): an unauthenticated
  `GET /repos/:o/:r/pulls`, only when the list is opened or refreshed. Works for public
  repositories; for a private one GitHub answers 404, and the error says so.
- **Create pull request…**: pushes the branch first if GitHub lacks its latest commits (through the
  pre-push checks), then opens GitHub's compare page in the browser, filled in:
  `https://github.com/:o/:r/compare/:base...:branch?expand=1&title=…&body=…`. Main builds the URL
  from the repository's GitHub remote and opens only pages on GitHub's host.
- **Checking out a pull request** fetches `refs/pull/N/head` with git, as before.
- **Avatars** (setting *GitHub*, the default; *Initials* never uses the network): a noreply
  address maps straight to `avatars.githubusercontent.com/u/<id>`; any other author's newest
  pushed commit (on a GitHub remote's tracking refs of an open repository) is looked up with the
  public `GET /repos/:o/:r/commits/:sha`, whose `author.avatar_url` is the picture. Pictures are
  cached on disk for 30 days, GitHub's "no such account" for 24 hours. A miss is a 404 from the
  `gitgoose-avatar:` scheme, and the page keeps the initials.

Code: `apps/desktop/src/main/github/` (api.ts, avatarLookup.ts, remote.ts, service.ts),
`apps/desktop/src/main/avatars.ts`. Tests: `main/github/github.test.ts`, `main/avatars.test.ts`,
`e2e/pulls.spec.ts`, `e2e/avatars.spec.ts`, against `fakeGitHub` from `@gitgoose/fixtures`.

## Rate limit

Without a token GitHub allows 60 API requests an hour per IP address. On a 403 or 429 the app
reads `retry-after`, or `x-ratelimit-reset` when `x-ratelimit-remaining` is 0 (else waits a
minute), and asks GitHub nothing until then; a success with nothing remaining pauses too. Avatar
lookups that could not be made are served as misses but not written to disk, so they are tried
again after the pause. The pull request list shows the time the limit resets.
