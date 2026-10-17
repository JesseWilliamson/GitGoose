import { EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'

/**
 * A code editor for the merged result of a conflicted file. Loaded lazily (React.lazy) the first
 * time someone edits a conflict, so CodeMirror costs nothing at startup.
 *
 * Conflict marker lines are tinted, so leftovers are easy to spot before saving.
 */
const MARKER = /^(<{7}|={7}|>{7}|\|{7})/

const markerLine = Decoration.line({ class: 'cm-conflict-marker' })

const markers = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = build(view)
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view)
    }
  },
  { decorations: (v) => v.decorations },
)

function build(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos)
      if (MARKER.test(line.text)) b.add(line.from, line.from, markerLine)
      pos = line.to + 1
    }
  }
  return b.finish()
}

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--gs-code-size)', backgroundColor: 'var(--gs-bg)', color: 'var(--gs-fg)' },
  '.cm-scroller': { fontFamily: 'var(--gs-code-font)' },
  '.cm-gutters': { backgroundColor: 'var(--gs-panel)', color: 'var(--gs-faint)', borderRight: '1px solid var(--gs-line)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--gs-hover)' },
  '.cm-conflict-marker': { backgroundColor: 'var(--gs-del-bg)', color: 'var(--gs-del)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--gs-fg)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--gs-select) !important' },
})

export default function ResultEditor({ initial, onChange }: { initial: string; onChange: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const changed = useRef(onChange)
  changed.current = onChange

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          basicSetup,
          theme,
          markers,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) changed.current(u.state.doc.toString())
          }),
        ],
      }),
    })
    view.focus()
    return () => view.destroy()
    // The editor owns its text after mount; `initial` is only the starting point.
  }, [])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" data-testid="result-editor" />
}
