/**
 * Turn a user-configured command line ("code --goto {file}:{line}") into argv, filling in
 * placeholders. Splits on spaces outside quotes, so paths in the template can be quoted; values
 * substituted for placeholders are never split, so a file path with spaces stays one argument.
 * If the template has no {file}, the file is appended (most editors take it as the last argument).
 */
export function commandArgv(template: string, vars: Record<string, string>, appendIfMissing?: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of template.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
    } else cur += ch
  }
  if (started || cur) out.push(cur)
  let used = false
  const filled = out.map((arg) => arg.replace(/\{(\w+)\}/g, (m, name: string) => {
    if (!(name in vars)) return m
    if (name === appendIfMissing) used = true
    return vars[name]!
  }))
  if (appendIfMissing && !used && vars[appendIfMissing] !== undefined) filled.push(vars[appendIfMissing]!)
  return filled
}
