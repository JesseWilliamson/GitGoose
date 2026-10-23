export type MermaidCheck = { ok: true } | { ok: false; message: string }

// Mermaid is large and only diagrams need it: load it on first use, like the syntax grammars.
let loaded: Promise<typeof import('mermaid').default> | null = null
function loadMermaid() {
  return (loaded ??= import('mermaid').then((m) => m.default))
}

/**
 * Is this Mermaid source something we can draw? The parser's own message is the error, so it can
 * be shown (or sent back to the model) as it is. Never throws. Parsing needs a DOM (Mermaid
 * sanitizes labels with DOMPurify), which is why this runs in the renderer and not in main.
 */
export async function validateMermaid(src: string): Promise<MermaidCheck> {
  try {
    const mermaid = await loadMermaid()
    await mermaid.parse(src)
    return { ok: true }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/** Mermaid's theme variables from the app's colour tokens, so a diagram looks like the panel it sits in. */
function themeVariables(): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: v('--gs-panel'), mainBkg: v('--gs-raised'), primaryColor: v('--gs-raised'), primaryTextColor: v('--gs-fg'), primaryBorderColor: v('--gs-line'),
    secondaryColor: v('--gs-hover'), tertiaryColor: v('--gs-panel'), lineColor: v('--gs-muted'), textColor: v('--gs-fg'),
    noteBkgColor: v('--gs-hover'), noteTextColor: v('--gs-fg'), noteBorderColor: v('--gs-line'),
    actorBkg: v('--gs-raised'), actorBorder: v('--gs-line'), actorTextColor: v('--gs-fg'), actorLineColor: v('--gs-faint'), signalColor: v('--gs-fg'), signalTextColor: v('--gs-fg'),
    labelBoxBkgColor: v('--gs-raised'), labelBoxBorderColor: v('--gs-line'), labelTextColor: v('--gs-fg'), loopTextColor: v('--gs-fg'), activationBkgColor: v('--gs-hover'), activationBorderColor: v('--gs-line'),
    git0: v('--lane-0'), git1: v('--lane-1'), git2: v('--lane-2'), git3: v('--lane-3'), git4: v('--lane-4'), git5: v('--lane-5'), git6: v('--lane-6'), git7: v('--lane-7'),
  }
}

let nextId = 0

/**
 * Draw Mermaid source as SVG. `securityLevel: 'strict'` encodes HTML in labels and turns off click
 * handlers, so nothing the model writes runs. The theme is read from the document's tokens at each call.
 */
export async function renderMermaid(src: string): Promise<string> {
  const mermaid = await loadMermaid()
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: { ...themeVariables(), darkMode: document.documentElement.dataset.theme !== 'light' },
    fontFamily: 'inherit',
  })
  // A fresh id per render: Mermaid leaves a temporary element with it in the document.
  const { svg } = await mermaid.render(`gs-mermaid-${++nextId}`, src)
  return svg
}
