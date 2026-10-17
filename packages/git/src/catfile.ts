import type { ChildProcess } from 'node:child_process'
import type { GitRunner } from './runner'

interface Pending {
  resolve: (b: Buffer | null) => void
  reject: (e: Error) => void
}

/**
 * A long-lived `git cat-file --batch` process.
 *
 * Spawning git costs a few milliseconds per call; reading 50 blobs for a conflict view or a
 * diff would spend most of its time starting processes. Here one process stays open: we write
 * object names to its stdin, one per line, and it answers in order on stdout:
 *
 *   <sha> <type> <size>\n<size bytes of content>\n
 *   <name> missing\n
 *
 * Because answers come back in request order, a FIFO queue of promises is enough to match them.
 * Output is binary, so we buffer bytes and parse lengths ourselves instead of splitting on lines.
 */
export class CatFile {
  private child: ChildProcess | null = null
  private queue: Pending[] = []
  private buf: Buffer = Buffer.alloc(0)

  constructor(private runner: GitRunner) {}

  private ensure(): ChildProcess {
    if (this.child) return this.child
    const child = this.runner.spawn(['cat-file', '--batch'], { readOnly: true })
    child.stdout!.on('data', (b: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, b]) : b
      this.drain()
    })
    const fail = (e: Error) => {
      for (const p of this.queue.splice(0)) p.reject(e)
      this.child = null
      this.buf = Buffer.alloc(0)
    }
    child.on('error', fail)
    child.on('close', () => fail(new Error('git cat-file exited')))
    this.child = child
    return child
  }

  private drain(): void {
    while (this.queue.length) {
      const nl = this.buf.indexOf(0x0a)
      if (nl < 0) return
      const header = this.buf.subarray(0, nl).toString('utf8')
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        this.buf = this.buf.subarray(nl + 1)
        this.queue.shift()!.resolve(null)
        continue
      }
      const size = Number(header.split(' ')[2])
      // Wait until the whole object plus its trailing newline has arrived.
      if (this.buf.length < nl + 1 + size + 1) return
      const content = Buffer.from(this.buf.subarray(nl + 1, nl + 1 + size))
      this.buf = this.buf.subarray(nl + 1 + size + 1)
      this.queue.shift()!.resolve(content)
    }
  }

  /** Read an object by any revision expression: a sha, "HEAD:path", ":2:path" (merge stage 2)... */
  read(rev: string): Promise<Buffer | null> {
    if (rev.includes('\n')) return Promise.resolve(null)
    const child = this.ensure()
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      child.stdin!.write(rev + '\n')
    })
  }

  async readText(rev: string): Promise<string | null> {
    const b = await this.read(rev)
    return b ? b.toString('utf8') : null
  }

  dispose(): void {
    this.child?.stdin?.end()
    this.child?.kill()
    this.child = null
  }
}
