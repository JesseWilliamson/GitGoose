import { useEffect, useState } from 'react'
import { renderMermaid } from '../lib/mermaid'

/** The document's current theme, so a diagram is drawn again when the user switches it. */
function useTheme(): string {
  const root = document.documentElement
  const [theme, setTheme] = useState(root.dataset.theme ?? 'dark')
  useEffect(() => {
    const watch = new MutationObserver(() => setTheme(root.dataset.theme ?? 'dark'))
    watch.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => watch.disconnect()
  }, [root])
  return theme
}

/** A Mermaid diagram drawn in the app's colours. Invalid source shows the parser's message in its place. */
export function MermaidDiagram({ source }: { source: string }) {
  const theme = useTheme()
  const [out, setOut] = useState<{ svg: string } | { error: string } | null>(null)
  useEffect(() => {
    let live = true
    renderMermaid(source).then((svg) => live && setOut({ svg }), (e: unknown) => live && setOut({ error: e instanceof Error ? e.message : String(e) }))
    return () => { live = false }
  }, [source, theme])
  if (out && 'error' in out) {
    return (
      <div className="rounded-md border border-border bg-card p-2 text-xs" data-testid="mermaid-error">
        <div className="text-destructive">This diagram could not be drawn.</div>
        <pre className="selectable mt-1 font-mono text-2xs whitespace-pre-wrap text-muted-foreground">{out.error}</pre>
      </div>
    )
  }
  return (
    <div className="max-w-full overflow-x-auto rounded-md border border-border bg-card p-2" data-testid="mermaid" role="img" aria-label="Diagram"
      // Mermaid's own SVG, produced with securityLevel 'strict' (labels are encoded, no scripts or handlers).
      dangerouslySetInnerHTML={{ __html: out?.svg ?? '' }} />
  )
}
