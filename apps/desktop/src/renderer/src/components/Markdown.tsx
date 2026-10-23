import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { fenceFile, tokenize, type Tokens } from '../lib/highlight'
import { parseMarkdown, type MdBlock, type MdInline } from '../lib/markdown'
import { reportError } from '../lib/store'

/**
 * An AI answer drawn from lib/markdown.ts's blocks. Every string goes through React (escaped),
 * so nothing the model writes becomes markup; links open in the browser through main, which
 * accepts only web and mail links. Fenced code is highlighted by the diff view's highlighter
 * once its grammar has loaded.
 */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <div className={`md selectable ${className ?? ''}`}>{blocks.map((b, i) => <Block key={i} b={b} />)}</div>
})

function Block({ b }: { b: MdBlock }): ReactNode {
  switch (b.t) {
    case 'p': return <p className="my-1.5 leading-relaxed"><Inline nodes={b.inline} /></p>
    case 'h': {
      const size = b.level <= 2 ? 'text-base' : 'text-sm'
      return <div role="heading" aria-level={b.level} className={`mt-3 mb-1 font-semibold ${size}`}><Inline nodes={b.inline} /></div>
    }
    case 'list': {
      const items = b.items.map((item, i) => <li key={i} className="my-0.5">{item.map((x, j) => <Block key={j} b={x} />)}</li>)
      return b.ordered
        ? <ol start={b.start} className="my-1.5 list-decimal pl-5 [&_p]:my-0">{items}</ol>
        : <ul className="my-1.5 list-disc pl-5 [&_p]:my-0">{items}</ul>
    }
    case 'code': return <CodeBlock lang={b.lang} text={b.text} />
    case 'quote': return <blockquote className="my-1.5 border-l-2 border-border pl-3 text-muted-foreground">{b.blocks.map((x, i) => <Block key={i} b={x} />)}</blockquote>
    case 'hr': return <hr className="my-3 border-border" />
  }
}

function Inline({ nodes }: { nodes: MdInline[] }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return <span key={i}>{n.text}</span>
      case 'code': return <code key={i} className="rounded bg-accent px-1 font-mono text-[0.92em]">{n.text}</code>
      case 'em': return <em key={i}><Inline nodes={n.children} /></em>
      case 'strong': return <strong key={i} className="font-semibold"><Inline nodes={n.children} /></strong>
      case 'link': return (
        <a key={i} href={n.href} title={n.href} className="text-primary hover:underline"
          onClick={(e) => {
            e.preventDefault()
            void api.openExternal(n.href).catch((err: unknown) => reportError('Could not open the link', err))
          }}>
          <Inline nodes={n.children} />
        </a>
      )
    }
  })
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [tokens, setTokens] = useState<Tokens | null>(null)
  useEffect(() => {
    setTokens(null)
    const file = fenceFile(lang)
    if (!file || text.length > 100_000) return
    let live = true
    const dark = document.documentElement.dataset.theme !== 'light'
    tokenize(text, file, dark).then((t) => live && setTokens(t), () => {})
    return () => { live = false }
  }, [lang, text])
  const lines = text.split('\n')
  return (
    <pre className="my-2 max-h-96 overflow-auto rounded border border-border bg-background p-2 font-mono text-xs leading-[1.45]" data-lang={lang || undefined}>
      {lines.map((l, i) => (
        <div key={i}>{tokens?.[i] ? tokens[i]!.map((t, k) => <span key={k} style={{ color: t.color }}>{t.content}</span>) : (l || ' ')}</div>
      ))}
    </pre>
  )
}
