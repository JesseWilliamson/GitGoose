/** Where GitHub is: the web host (pull request pages) and the REST API. */
export interface GitHubEndpoints {
  /** https://github.com */
  web: string
  /** https://api.github.com */
  api: string
}

/** Tests point these at a local fake (tools/fixtures fakeGitHub); nothing else should. */
export function githubEndpoints(env: NodeJS.ProcessEnv = process.env): GitHubEndpoints {
  return {
    web: (env.GITGOOSE_GITHUB_URL ?? 'https://github.com').replace(/\/$/, ''),
    api: (env.GITGOOSE_GITHUB_API ?? env.GITGOOSE_GITHUB_URL ?? 'https://api.github.com').replace(/\/$/, ''),
  }
}
