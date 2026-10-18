import type { GitHubEndpoints } from './deviceFlow'

/**
 * The GitHub OAuth App this build signs in with. A client id is public (it is in every sign-in
 * URL), so it lives in the source. There is no client secret: the device flow does not use one.
 *
 * To set it up once: github.com → Settings → Developer settings → OAuth Apps → New OAuth App
 * (any homepage and callback URL), then tick "Enable Device Flow" and paste the Client ID here.
 * Until then, sign-in shows "not configured" (or set GITGOOSE_GITHUB_CLIENT_ID for a dev build).
 */
export const GITHUB_CLIENT_ID = ''

/** Tests point these at a local fake (tools/fixtures fakeGitHub); nothing else should. */
export function githubEndpoints(env: NodeJS.ProcessEnv = process.env): GitHubEndpoints {
  return {
    web: (env.GITGOOSE_GITHUB_URL ?? 'https://github.com').replace(/\/$/, ''),
    api: (env.GITGOOSE_GITHUB_API ?? env.GITGOOSE_GITHUB_URL ?? 'https://api.github.com').replace(/\/$/, ''),
    clientId: env.GITGOOSE_GITHUB_CLIENT_ID ?? GITHUB_CLIENT_ID,
  }
}
