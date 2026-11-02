// Shared parts of the docs pages: the title row, a sectioned page with an "On this page" contents list, and the
// MCP catalog tables. Light on purpose: only the REST page loads the API reference.
import { Code, Text, Title } from '@mantine/core'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { MCP_ACCESS_LABELS, type McpCatalogEntry } from '../../../../src/mcp-catalog'

export function DocsHeader({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <div className="va-title-row">
      <div>
        <Title order={1}>{title}</Title>
        <div className="va-sub">{sub}</div>
      </div>
    </div>
  )
}

export interface DocSection {
  id: string
  title: string
  description?: ReactNode
  children: ReactNode
}

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

/**
 * Sections in a column beside a sticky contents list that follows the section in view. Links are #id anchors:
 * clicking one scrolls there and puts the id in the URL, and a URL with a hash opens at that section. Below 960 px
 * the list becomes a row of chips above the sections.
 */
export function DocSections({
  sections,
  label = 'On this page',
}: {
  sections: DocSection[]
  label?: string
}) {
  const { hash } = useLocation()
  const [active, setActive] = useState(() => sections.find((s) => `#${s.id}` === hash)?.id ?? sections[0]?.id)
  // While a clicked link scrolls smoothly, the list stays on its section instead of flicking through the ones passed.
  const scrollingTo = useRef<string | null>(null)

  // The section in view is the first one whose top part is on screen below the header, or the last one once the
  // page is scrolled to the bottom (short last sections never reach the top).
  const ids = sections.map((s) => s.id).join(' ')
  useEffect(() => {
    const order = ids.split(' ')
    const visible = new Set<string>()
    const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
    const update = () => {
      if (scrollingTo.current) return
      const id = atBottom() ? order.at(-1) : order.find((i) => visible.has(i))
      if (id) setActive(id)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id)
          else visible.delete(e.target.id)
        }
        update()
      },
      { rootMargin: '-96px 0px -55% 0px' },
    )
    for (const id of order) {
      const el = document.getElementById(id)
      if (el) observer.observe(el)
    }
    const onScroll = () => {
      if (atBottom()) update()
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', onScroll)
    }
  }, [ids])

  // Deep links: open at the section in the hash, on load and when the hash changes.
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1))
    if (!id) return
    const el = document.getElementById(id)
    if (!el) return
    el.scrollIntoView({ block: 'start' })
    setActive(id)
  }, [hash])

  const go = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    const el = document.getElementById(id)
    if (!el) return
    e.preventDefault()
    scrollingTo.current = id
    const done = () => {
      if (scrollingTo.current === id) scrollingTo.current = null
      window.removeEventListener('scrollend', done)
    }
    window.addEventListener('scrollend', done)
    setTimeout(done, 1500)
    el.scrollIntoView({ behavior: scrollBehavior(), block: 'start' })
    // Replace, so the back button leaves the page instead of stepping through sections.
    window.history.replaceState(window.history.state, '', `#${id}`)
    setActive(id)
    el.focus({ preventScroll: true })
  }

  const links = (className: string) =>
    sections.map((s) => (
      <a
        key={s.id}
        href={`#${s.id}`}
        className={className}
        aria-current={active === s.id ? 'location' : undefined}
        data-active={active === s.id || undefined}
        onClick={(e) => {
          go(e, s.id)
        }}
      >
        {s.title}
      </a>
    ))

  return (
    <div className="va-docs-layout">
      <nav className="va-docs-toc" aria-label={label}>
        <div className="va-docs-toc-label">{label}</div>
        {links('va-docs-toc-link')}
      </nav>
      <nav className="va-docs-chips" aria-label={label}>
        {links('va-docs-chip')}
      </nav>
      <div className="va-docs-sections">
        {sections.map((s) => (
          <section
            key={s.id}
            id={s.id}
            className="va-doc-section"
            aria-labelledby={`${s.id}-title`}
            tabIndex={-1}
          >
            <Text component="h2" id={`${s.id}-title`} fw={500} size="lg" m={0}>
              {s.title}
            </Text>
            {s.description ? (
              <Text size="sm" c="var(--va-muted)" mt={4}>
                {s.description}
              </Text>
            ) : null}
            <div className="va-doc-section-body">{s.children}</div>
          </section>
        ))}
      </div>
    </div>
  )
}

/** A tool or prompt list from src/mcp-catalog.ts, with who gets each entry. */
export function CatalogTable({ entries, label }: { entries: readonly McpCatalogEntry[]; label: string }) {
  return (
    <div className="va-table-scroll">
      <table className="va-table" aria-label={label}>
        <thead>
          <tr>
            <th>Name</th>
            <th>What it does</th>
            <th>Who gets it</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.name}>
              <td>
                <Code>{e.name}</Code>
              </td>
              <td style={{ color: 'var(--va-muted)' }}>{e.summary}</td>
              <td style={{ color: 'var(--va-faint)', fontSize: 13 }}>{MCP_ACCESS_LABELS[e.access]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
