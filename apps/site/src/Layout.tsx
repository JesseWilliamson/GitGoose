import { StrictMode, useEffect, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

export type Page = 'home' | 'how' | 'graphs'

/**
 * Every page is its own HTML file (a static site, no router), so links are relative and depend
 * on how deep the page sits: `./` from index.html, `../` from graphs/index.html.
 */
const pages: { id: Page; label: string; href: string }[] = [
  { id: 'home', label: 'GitGoose', href: '' },
  { id: 'how', label: 'How it works', href: 'how-it-works/' },
  { id: 'graphs', label: 'Drawing git graphs', href: 'graphs/' },
]
export const GITHUB = 'https://github.com/JesseWilliamson/GitGoose'

function Goose() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden>
      <rect x="3" y="3" width="26" height="26" rx="7" fill="var(--brand)" />
      <path d="M11 9v14M21 15c0-4-6-3-10-6" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      <circle cx="11" cy="9" r="2.6" fill="#fff" />
      <circle cx="11" cy="23" r="2.6" fill="#fff" />
      <circle cx="21" cy="15" r="2.6" fill="#fff" />
    </svg>
  )
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light')
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('gitgoose-theme', theme) } catch { /* storage blocked */ }
  }, [theme])
  return (
    <button className="theme-btn" type="button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle dark mode">
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  )
}

export function Shell({ page, root, children }: { page: Page; root: './' | '../'; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="logo" href={root}><Goose /> GitGoose</a>
          <nav>
            {pages.slice(1).map((p) => (
              <a key={p.id} href={root + p.href} aria-current={page === p.id ? 'page' : undefined}>{p.label}</a>
            ))}
            <a href={GITHUB} target="_blank" rel="noreferrer">GitHub</a>
          </nav>
          <ThemeToggle />
        </div>
      </header>
      <main>{children}</main>
      <footer className="foot">
        <span>GitGoose · a fast git client · built in the open</span>
        <span>Diagrams drawn with <a href="https://github.com/JesseWilliamson/DiagramBuilder" target="_blank" rel="noreferrer">dsviz</a></span>
      </footer>
    </>
  )
}

/** Mount a page. Each entry file calls this once. */
export function mount(node: ReactNode) {
  createRoot(document.getElementById('root')!).render(<StrictMode>{node}</StrictMode>)
}

/** A section with an id the table of contents can jump to. */
export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="doc-section" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  )
}

export function Toc({ items }: { items: readonly (readonly [string, string])[] }) {
  return (
    <nav className="doc-toc" aria-label="On this page">
      {items.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}
    </nav>
  )
}

/** A diagram with its title, a caption that says what the controls did, and the controls. */
export function Figure({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <figure className="figure">
      <p className="figure-title">{title}{hint && <small>{hint}</small>}</p>
      {children}
    </figure>
  )
}

export const Code = ({ children }: { children: string }) => <pre className="code"><code>{children.trim()}</code></pre>
