'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowRight, Clock, CornerDownLeft, FileText, Keyboard, Loader2, MousePointerClick, Plus, Search } from 'lucide-react'
import { api, can } from '@/lib/api'
import { keyLabel, topDialog, useDialogFocus } from '@/lib/keys'
import { useEscape } from '@/lib/useEscape'
import { navItems } from '@/components/layout/Sidebar'
import { INVENTORY_SECTIONS } from '@/components/layout/inventorySections'
import { press, queueAfterMove } from './KeyboardLayer'

/*
 * Ctrl+K: open any screen, start any document, find any record, or press a
 * button on the screen behind — by typing a few letters of it. Only what the
 * person may use is offered; the server checks again whatever is chosen.
 */

interface Entry {
  id: string
  group: 'Recent' | 'Records' | 'Create' | 'On this screen' | 'Go to' | 'Help' | 'Best matches'
  label: string
  hint?: string
  /** Other words that find it: "PO", "MR", "GRN". */
  words?: string
  icon: 'page' | 'new' | 'record' | 'button' | 'help' | 'recent'
  run: () => void
}

interface Hit {
  kind: string
  number: string
  title: string
  sub?: string | null
  /** The list it is on, and what to find there. */
  path: string
  term: string
}

/** The permission a screen needs, by where it is. Screens not listed are open to all. */
function moduleOf(href: string): string | null {
  if (href.startsWith('/masters/routings')) return 'production'
  const top = href.split('/')[1]
  return ['sales', 'purchase', 'inventory', 'production', 'masters', 'accounts', 'hr'].includes(top) ? top : null
}

/** Short names people type for documents. */
const WORDS: Record<string, string> = {
  '/sales/quotations': 'quote quotation estimate',
  '/sales/orders': 'so sales order',
  '/sales/challan': 'dc delivery challan dispatch',
  '/sales/invoices': 'invoice bill tax invoice',
  '/sales/payments': 'receipt payment received collection',
  '/sales/returns': 'sales return credit note',
  '/purchase/enquiries': 'enquiry inquiry rfq pi proforma',
  '/purchase/orders': 'po purchase order',
  '/purchase/grn': 'grn goods receipt inward receive',
  '/purchase/bills': 'pb purchase bill supplier invoice verification',
  '/purchase/returns': 'purchase return return challan',
  '/purchase/payments': 'supplier payment pay',
  '/purchase/expenses': 'expense cash spend',
  '/purchase/rejected': 'qc rejected rejection',
  '/inventory/requisitions': 'mr material requisition indent issue',
  '/inventory/stock': 'stock balance on hand',
  '/inventory/documents': 'stock in stock out adjustment transfer opening',
  '/inventory/count': 'stock count physical verification',
  '/inventory/ledger': 'inward outward ledger movement',
  '/inventory/packages': 'sticker packet barcode label',
  '/inventory/scan': 'scan barcode sticker',
  '/inventory/job-work': 'jw job work vendor challan outward',
  '/inventory/customer-material': 'customer grn customer material cgrn',
  '/inventory/trace': 'track trace garment',
  '/production/orders': 'mo manufacturing order production order',
  '/production/job-cards': 'job card jc',
  '/production/transfers': 'process transfer handover',
  '/production/stages': 'cutting stitching qc stages floor bundle',
  '/masters/routings': 'routing route',
  '/masters/items': 'item fabric trim product',
  '/masters/styles': 'style design sku',
  '/masters/customers': 'customer buyer party',
  '/masters/suppliers': 'supplier vendor party',
  '/dashboard': 'home approvals pending',
}

/** Starting a document: pressed on its list, with the list's own New button. */
const CREATE: Array<{ label: string; path: string; module: string; words?: string }> = [
  { label: 'New quotation', path: '/sales/quotations', module: 'sales' },
  { label: 'New sales order', path: '/sales/orders', module: 'sales', words: 'so create' },
  { label: 'New delivery challan', path: '/sales/challan', module: 'sales', words: 'dc dispatch' },
  { label: 'New sales invoice', path: '/sales/invoices', module: 'sales', words: 'bill' },
  { label: 'Record a payment received', path: '/sales/payments', module: 'sales', words: 'receipt' },
  { label: 'New purchase enquiry', path: '/purchase/enquiries', module: 'purchase', words: 'rfq' },
  { label: 'New purchase order', path: '/purchase/orders', module: 'purchase', words: 'po create' },
  { label: 'Receive goods (new GRN)', path: '/purchase/grn', module: 'purchase', words: 'grn inward' },
  { label: 'New purchase bill', path: '/purchase/bills', module: 'purchase', words: 'pb' },
  { label: 'New expense', path: '/purchase/expenses', module: 'purchase' },
  { label: 'New material requisition', path: '/inventory/requisitions', module: 'inventory', words: 'mr indent' },
  { label: 'New stock document', path: '/inventory/documents', module: 'inventory', words: 'stock in out adjustment transfer' },
  { label: 'New stock count', path: '/inventory/count', module: 'inventory', words: 'physical' },
  { label: 'Send for job work', path: '/inventory/job-work', module: 'inventory', words: 'jw challan' },
  { label: 'Receive customer material', path: '/inventory/customer-material', module: 'inventory', words: 'cgrn' },
  { label: 'New manufacturing order', path: '/production/orders', module: 'production', words: 'mo' },
  { label: 'New process transfer', path: '/production/transfers', module: 'production', words: 'handover' },
  { label: 'New item', path: '/masters/items', module: 'masters', words: 'fabric trim' },
  { label: 'New style', path: '/masters/styles', module: 'masters', words: 'design' },
  { label: 'New customer', path: '/masters/customers', module: 'masters', words: 'buyer' },
  { label: 'New supplier', path: '/masters/suppliers', module: 'masters', words: 'vendor' },
]

const SETTINGS = [
  { label: 'Company', href: '/settings/company' },
  { label: 'People & roles', href: '/settings/people' },
  { label: 'Preferences', href: '/settings/preferences' },
  { label: 'Documents & numbering', href: '/settings/documents' },
  { label: 'Recycle bin', href: '/settings/recycle-bin' },
]

/** Every screen in the menu, with where it sits: "Purchase › Purchase Orders". */
function screens(): Array<{ label: string; href: string }> {
  const out: Array<{ label: string; href: string }> = []
  for (const item of navItems) {
    if (item.planned) continue
    if (item.href) out.push({ label: item.label, href: item.href })
    for (const c of item.children ?? []) {
      if (c.planned) continue
      if (item.label === 'Inventory') continue
      out.push({ label: `${item.label} › ${c.label}`, href: c.href })
    }
  }
  for (const s of INVENTORY_SECTIONS) for (const t of s.tabs) out.push({ label: `Inventory › ${t.label}`, href: t.href })
  for (const s of SETTINGS) out.push({ label: `Settings › ${s.label}`, href: s.href })
  return out.filter((s) => {
    const m = moduleOf(s.href)
    return !m || can(m, 'view')
  })
}

const RECENT = 'ld:recent-screens'

/** Called on every move between screens; the last eight make "Recent". */
export function rememberVisit(path: string) {
  try {
    const list: string[] = JSON.parse(localStorage.getItem(RECENT) ?? '[]')
    localStorage.setItem(RECENT, JSON.stringify([path, ...list.filter((p) => p !== path)].slice(0, 8)))
  } catch {
    /* no storage: no Recent list */
  }
}
function recentPaths(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]')
  } catch {
    return []
  }
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')

/** Letters in order, with gaps: "pord" finds "purchase order". */
function inOrder(w: string, t: string) {
  let i = 0
  for (const ch of t) if (ch === w[i]) i++
  return i === w.length
}

/** How well the typed words fit: every word must fit somewhere; a word's start counts most. */
function score(query: string, text: string): number {
  const t = fold(text)
  let s = 0
  for (const w of fold(query).split(/\s+/).filter(Boolean)) {
    const at = t.indexOf(w)
    if (at === 0) s += 30
    else if (at > 0) s += /[\s›·\-/(]/.test(t[at - 1]) ? 20 : 8
    else if (w.length > 1 && inOrder(w, t)) s += 2
    else return 0
  }
  return s
}

/** Buttons on the screen behind, by their words — never the ones that delete. */
function screenButtons(): Array<{ label: string; button: HTMLButtonElement }> {
  const root = topDialog() ?? document.querySelector('main')
  if (!root) return []
  const seen = new Set<string>()
  const out: Array<{ label: string; button: HTMLButtonElement }> = []
  for (const b of root.querySelectorAll<HTMLButtonElement>('button')) {
    if (b.disabled || b.getClientRects().length === 0 || b.closest('[aria-hidden="true"], [inert], tbody, [data-row], [data-grid-row]')) continue
    const label = (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim()
    if (label.length < 2 || label.length > 48) continue
    if (/delete|remove|discard|void|erase|clear all|log ?out|sign out/i.test(label) || b.className.includes('btn-danger')) continue
    if (seen.has(label.toLowerCase())) continue
    seen.add(label.toLowerCase())
    out.push({ label, button: b })
  }
  return out.slice(0, 40)
}

/**
 * Letters typed in the instant between Ctrl+K and the palette's box being on
 * the screen: held by the keyboard layer and handed over here, so a quick
 * "Ctrl+K MR-0141" does not lose its "MR-".
 */
export const earlyKeys: { text: string | null } = { text: null }

const ICON = { page: ArrowRight, new: Plus, record: FileText, button: MousePointerClick, help: Keyboard, recent: Clock }

export function CommandPalette({ onClose, onHelp }: { onClose: () => void; onHelp: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [hits, setHits] = useState<Hit[]>([])
  const [searching, setSearching] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Read once, before this window is on top: the screen it was opened over.
  const [buttons] = useState(screenButtons)
  const pages = useMemo(screens, [])

  useDialogFocus(boxRef)
  useEscape(onClose)
  useEffect(() => {
    const held = earlyKeys.text
    earlyKeys.text = null
    if (held) setQ((q) => held + q)
  }, [])

  const go = (path: string) => {
    onClose()
    if (path !== pathname) router.push(path)
  }

  // Records, from the server, once typing settles.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    let live = true
    const t = setTimeout(() => {
      api
        .get<{ data: Hit[] }>(`/search?q=${encodeURIComponent(term)}`)
        .then((r) => live && setHits(r.data ?? []))
        .catch(() => live && setHits([]))
        .finally(() => live && setSearching(false))
    }, 220)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q])

  const entries = useMemo<Entry[]>(() => {
    const term = q.trim()
    const page = (p: { label: string; href: string }, group: Entry['group'], icon: Entry['icon'] = 'page'): Entry => ({
      id: `${group}:${p.href}`,
      group,
      label: p.label,
      hint: p.href,
      words: WORDS[p.href],
      icon,
      run: () => go(p.href),
    })
    const create: Entry[] = CREATE.filter((c) => can(c.module, 'create')).map((c) => ({
      id: `new:${c.path}`,
      group: 'Create',
      label: c.label,
      words: `${c.words ?? ''} create add new`,
      icon: 'new',
      run: () => {
        queueAfterMove({ path: c.path, do: 'new' })
        go(c.path)
      },
    }))
    const onScreen: Entry[] = buttons.map((b, i) => ({
      id: `btn:${i}`,
      group: 'On this screen',
      label: b.label,
      icon: 'button',
      run: () => {
        onClose()
        setTimeout(() => b.button.isConnected && !b.button.disabled && press(b.button), 30)
      },
    }))
    const help: Entry = { id: 'help', group: 'Help', label: 'Keyboard shortcuts', hint: keyLabel('alt+/'), words: 'help keys hotkeys', icon: 'help', run: onHelp }

    if (!term) {
      const recent = recentPaths()
        .filter((p) => p !== pathname)
        .map((p) => pages.find((s) => s.href === p))
        .filter((p): p is { label: string; href: string } => !!p)
        .slice(0, 5)
        .map((p) => page(p, 'Recent', 'recent'))
      return [...recent, ...onScreen.slice(0, 6), ...create.slice(0, 6), help]
    }

    // Screens, documents to start and buttons, ranked together: "purch ord"
    // is the list first, "new po" the new one. A tie goes to the screen.
    const first: Record<string, number> = { 'Go to': 3, Create: 2, 'On this screen': 1, Help: 0 }
    const what: Record<string, string> = { Create: 'New', 'On this screen': 'On this screen', Help: '' }
    const ranked = (list: Entry[]) =>
      list
        .map((e) => ({ e, s: Math.max(score(term, e.label), score(term, `${e.label} ${e.words ?? ''}`) - 1) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || first[b.e.group] - first[a.e.group])
        .map((x) => ({ ...x.e, group: 'Best matches' as const, hint: x.e.hint ?? what[x.e.group] }))
    const records: Entry[] = hits.map((h, i) => ({
      id: `rec:${i}:${h.number}`,
      group: 'Records',
      label: `${h.number} · ${h.title}`,
      hint: h.sub ? `${h.kind} · ${h.sub}` : h.kind,
      icon: 'record',
      run: () => {
        // A list to find it in; a path that opens it already (a packet's scan) needs nothing more.
        if (!h.path.includes('?')) queueAfterMove({ path: h.path, do: 'find', term: h.term })
        go(h.path)
      },
    }))
    return [...records, ...ranked([...pages.map((p) => page(p, 'Go to')), ...create, ...onScreen, help]).slice(0, 14)]
    // `go`, `onClose` and `onHelp` are the same for as long as the window is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, hits, pages, buttons, pathname])

  useEffect(() => setActive(0), [q, hits])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (entries.length ? (a + 1) % entries.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (entries.length ? (a - 1 + entries.length) % entries.length : 0))
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setActive((a) => Math.min(entries.length - 1, a + 8))
    } else if (e.key === 'PageUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 8))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      entries[active]?.run()
    }
  }

  let lastGroup = ''
  return (
    <div className="fixed inset-0 z-[1050] flex items-start justify-center bg-black/50 p-3 pt-[12vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={boxRef} role="dialog" aria-modal="true" aria-label="Find a screen, a record or an action" className="bg-card border-border flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-border flex items-center gap-2 border-b px-3">
          <Search size={16} className="text-muted-foreground shrink-0" aria-hidden />
          <input
            id="palette-input"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Type a screen, a document number, a customer…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={entries[active] ? `palette-${active}` : undefined}
            className="text-foreground placeholder:text-muted-foreground h-12 w-full bg-transparent text-sm outline-none"
          />
          {searching && <Loader2 size={15} className="text-muted-foreground shrink-0 animate-spin" aria-label="Searching" />}
        </div>
        <div ref={listRef} id="palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
          {entries.length === 0 && !searching && <p className="text-muted-foreground px-4 py-6 text-center text-sm">Nothing matches “{q.trim()}”.</p>}
          {entries.map((e, i) => {
            const header = e.group !== lastGroup ? e.group : null
            lastGroup = e.group
            const Icon = ICON[e.icon]
            return (
              <div key={e.id}>
                {header && <p className="text-muted-foreground px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider">{header}</p>}
                <div
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => e.run()}
                  className={`mx-1.5 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm ${i === active ? 'bg-primary/15 text-foreground' : 'text-foreground/90'}`}
                >
                  <Icon size={15} className={i === active ? 'text-primary shrink-0' : 'text-muted-foreground shrink-0'} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{e.label}</span>
                  {e.hint && <span className="text-muted-foreground max-w-[45%] shrink-0 truncate text-xs">{e.hint}</span>}
                  {i === active && <CornerDownLeft size={13} className="text-muted-foreground shrink-0" aria-hidden />}
                </div>
              </div>
            )
          })}
        </div>
        <div className="border-border text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-[11px]">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move
          </span>
          <span>
            <kbd className="kbd">Enter</kbd> open
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> close
          </span>
          <span className="ml-auto">
            <kbd className="kbd">{keyLabel('alt+/')}</kbd> all shortcuts
          </span>
        </div>
      </div>
    </div>
  )
}
