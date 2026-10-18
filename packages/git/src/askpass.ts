import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Credential prompts without a terminal.
 *
 * When git (or ssh) needs a username, password or passphrase and has no terminal, it runs the
 * program named by GIT_ASKPASS / SSH_ASKPASS with the prompt as its argument and reads the answer
 * from that program's stdout. We point those variables at a tiny script. The script connects
 * back to this server over a local socket (a Unix socket, or a named pipe on Windows), sends the
 * prompt, waits for the answer the user types into our dialog, and prints it.
 *
 * The script runs our own binary as plain Node (ELECTRON_RUN_AS_NODE=1), so it works in the
 * packaged app with no Node installed. GitHub Desktop uses the same design.
 */

export type PromptHandler = (message: string, secret: boolean) => Promise<string | null>

const CLIENT_JS = `
const net = require('net')
const sock = net.connect(process.env.GITSQUID_ASKPASS_HANDLE)
let data = ''
sock.on('connect', () => sock.write(JSON.stringify({ prompt: process.argv.slice(2).join(' ') }) + '\\n'))
sock.on('data', (b) => (data += b))
sock.on('end', () => {
  try {
    const r = JSON.parse(data)
    if (r.answer == null) process.exit(1)
    process.stdout.write(r.answer + '\\n')
    process.exit(0)
  } catch { process.exit(1) }
})
sock.on('error', () => process.exit(1))
`

export function isSecretPrompt(prompt: string): boolean {
  return /password|passphrase|token|pin\b|secret/i.test(prompt)
}

export class AskpassServer {
  private server: Server | null = null
  private dir: string
  readonly handle: string
  env: Record<string, string> = {}

  /**
   * @param nodePath binary that can run a .js file: process.execPath works in both Node and
   *   Electron (Electron needs ELECTRON_RUN_AS_NODE=1, which we set).
   */
  constructor(private onPrompt: PromptHandler, private nodePath: string = process.execPath) {
    const id = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    this.dir = join(tmpdir(), `gitsquid-askpass-${id}`)
    this.handle = process.platform === 'win32' ? `\\\\.\\pipe\\gitsquid-askpass-${id}` : join(this.dir, 's')
  }

  async start(): Promise<Record<string, string>> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const clientJs = join(this.dir, 'askpass.js')
    writeFileSync(clientJs, CLIENT_JS)
    let script: string
    if (process.platform === 'win32') {
      script = join(this.dir, 'askpass.cmd')
      writeFileSync(script, `@echo off\r\n"%GITSQUID_ASKPASS_NODE%" "%GITSQUID_ASKPASS_JS%" %*\r\n`)
    } else {
      script = join(this.dir, 'askpass.sh')
      writeFileSync(script, `#!/bin/sh\nexec "$GITSQUID_ASKPASS_NODE" "$GITSQUID_ASKPASS_JS" "$@"\n`)
      chmodSync(script, 0o700)
    }

    // One line each way: the prompt as JSON ending in a newline (JSON escapes any inside it),
    // then the answer, and we close. Not a half-close (the client ending its side, then reading):
    // Windows named pipes do not reliably carry the answer back after that.
    this.server = createServer((sock) => {
      let data = ''
      let answered = false
      sock.on('data', async (b) => {
        data += b
        const nl = data.indexOf('\n')
        if (nl < 0 || answered) return
        answered = true
        let answer: string | null = null
        try {
          const { prompt } = JSON.parse(data.slice(0, nl)) as { prompt: string }
          answer = await this.onPrompt(prompt, isSecretPrompt(prompt))
        } catch {
          answer = null
        }
        sock.end(JSON.stringify({ answer }))
      })
      sock.on('error', () => {})
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.handle, () => resolve())
    })

    this.env = {
      GIT_ASKPASS: script,
      SSH_ASKPASS: script,
      // OpenSSH 8.4+: use SSH_ASKPASS even when a terminal or no DISPLAY is present.
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: process.env.DISPLAY || ':0',
      GITSQUID_ASKPASS_HANDLE: this.handle,
      GITSQUID_ASKPASS_NODE: this.nodePath,
      GITSQUID_ASKPASS_JS: clientJs,
      ELECTRON_RUN_AS_NODE: '1',
    }
    return this.env
  }

  stop(): void {
    this.server?.close()
    this.server = null
    rmSync(this.dir, { recursive: true, force: true })
  }
}
