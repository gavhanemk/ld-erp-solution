'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  BarChart3,
  LayoutDashboard, ShoppingCart, Package, Warehouse, Factory,
  BookOpen, Users, Wrench, Bot, Settings, ChevronLeft, ChevronRight,
  LogOut, Bell, Zap, ChevronDown, ChevronRight as ChevronRightIcon,
  Tag, Layers
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { api, currentUser, tokens } from '@/lib/api'
import { useAppSettings } from '@/lib/appSettings'

/**
 * "Mahesh Gavhane" -> "MG"; a single name gives its first two letters.
 *
 * `\s+`, not `s+`. It was splitting on the letter "s", so "Mahesh Gavhane"
 * became ["Mahe", "h Gavhane"] and the avatar read "MH" — wrong for any name
 * containing an s, right for every name that does not, which is why it
 * survived.
 */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

interface NavChild {
  label: string
  href: string
  /**
   * Screens that do not exist yet are shown greyed and do not navigate.
   * Letting them link produced a 404 on 28 of 38 menu items, which reads as a
   * broken system rather than an unfinished one.
   */
  planned?: boolean
}

interface NavItem {
  label: string
  href?: string
  icon: React.ElementType
  badge?: string | number
  badgeColor?: string
  planned?: boolean
  children?: NavChild[]
}

const navItems: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Reports', href: '/reports', icon: BarChart3 },
  {
    label: 'Masters', icon: Layers,
    children: [
      { label: 'Items & Products', href: '/masters/items' },
      { label: 'Item Categories', href: '/masters/item-categories' },
      { label: 'Expense Heads', href: '/masters/expense-heads' },
      { label: 'Styles & SKU', href: '/masters/styles' },
      { label: 'Bill of Materials', href: '/masters/bom' },
      { label: 'Size Runs', href: '/masters/size-runs' },
      { label: 'Customers', href: '/masters/customers' },
      { label: 'Suppliers', href: '/masters/suppliers' },
      { label: 'Agents & Brokers', href: '/masters/brokers' },
      { label: 'Departments', href: '/masters/departments' },
      { label: 'Workstations', href: '/masters/workstations' },
      { label: 'Extra Charges', href: '/masters/charges' },
      { label: 'Warehouses', href: '/masters/warehouses' },
      { label: 'Bank Accounts', href: '/masters/bank-accounts' },
    ],
  },
  {
    label: 'Sales', icon: ShoppingCart,
    children: [
      { label: 'Sales Orders', href: '/sales/orders' },
      { label: 'Delivery Challan', href: '/sales/challan', planned: true },
      { label: 'Invoices', href: '/sales/invoices', planned: true },
      { label: 'Payments Received', href: '/sales/payments', planned: true },
    ],
  },
  {
    label: 'Purchase', icon: Package,
    children: [
      /* Ahead of the documents: where the day starts — what is late, what is
         due, what is waiting to be sent or billed — before opening any list. */
      { label: 'Dashboard', href: '/purchase/dashboard' },
      /* Then the enquiry, because it comes first: the buyer sends an enquiry, the
         supplier answers with a proforma invoice, and the order is raised
         against its number. Optional — plenty of orders are placed at a rate
         already known — which is why it reads as a step and not a gate. */
      { label: 'Purchase Enquiries', href: '/purchase/enquiries' },
      { label: 'Purchase Orders', href: '/purchase/orders' },
      { label: 'Goods Receipt (GRN)', href: '/purchase/grn' },
      { label: 'Purchase Bills', href: '/purchase/bills' },
      /* After the bill, because a return is always raised against one — and
         before the notes, because the challan comes first and writes the
         note. The menu reads in the order the paper does. */
      { label: 'Purchase Returns', href: '/purchase/returns' },
      { label: 'Supplier Payments', href: '/purchase/payments' },
      /* Two entries for three kinds of document, on purpose. Ours and the
         supplier's debit notes both live under Debit Notes — they are both
         debit notes, and the row says whose it is and which way the money
         goes. A menu that split them made you know the answer before you
         could look it up. */
      { label: 'Debit Notes', href: '/purchase/debit-notes' },
      { label: 'Credit Notes', href: '/purchase/credit-notes' },
    ],
  },
  {
    label: 'Inventory', icon: Warehouse,
    children: [
      { label: 'Dashboard', href: '/inventory/dashboard' },
      { label: 'Stock', href: '/inventory/stock' },
      { label: 'Material Requisitions', href: '/inventory/requisitions' },
      { label: 'Stock Documents', href: '/inventory/documents' },
      { label: 'Customer Material', href: '/inventory/customer-material' },
      { label: 'Job Work', href: '/inventory/job-work' },
      { label: 'Stock Ledger', href: '/inventory/ledger' },
    ],
  },
  {
    label: 'Production', icon: Factory,
    children: [
      { label: 'Manufacturing Orders', href: '/production/orders' },
      { label: 'Routings', href: '/masters/routings' },
      { label: 'Cutting', href: '/production/cutting', planned: true },
      { label: 'Stitching', href: '/production/stitching', planned: true },
      { label: 'Quality Control', href: '/production/qc', planned: true },
      { label: 'Packing', href: '/production/packing', planned: true },
    ],
  },
  {
    label: 'Accounts', icon: BookOpen,
    children: [
      { label: 'Dashboard', href: '/accounts/dashboard', planned: true },
      { label: 'Vouchers', href: '/accounts/vouchers', planned: true },
      { label: 'Outstanding', href: '/accounts/outstanding', planned: true },
      { label: 'GST Reports', href: '/accounts/gst', planned: true },
      { label: 'Bank & Cash', href: '/accounts/bank', planned: true },
    ],
  },
  {
    label: 'HR & Payroll', icon: Users,
    children: [
      { label: 'Employees', href: '/hr/employees', planned: true },
      { label: 'Attendance', href: '/hr/attendance', planned: true },
      { label: 'Payroll', href: '/hr/payroll', planned: true },
    ],
  },
  {
    label: 'VHAGAR Brand', icon: Tag,
    children: [
      { label: 'Product Catalog', href: '/vhagar/catalog', planned: true },
      { label: 'Production Orders', href: '/vhagar/production', planned: true },
      { label: 'Sales', href: '/vhagar/sales', planned: true },
      { label: 'Brand P&L', href: '/vhagar/pnl', planned: true },
    ],
  },
  { label: 'Maintenance', href: '/maintenance', icon: Wrench, planned: true },
  { label: 'AI Assistant', href: '/ai', icon: Bot, badge: 'AI', badgeColor: 'teal' },
  { label: 'Settings', href: '/settings', icon: Settings },
]

interface SidebarProps {
  collapsed: boolean
  onCollapse: (v: boolean) => void
  /**
   * Whether the drawer is showing, on the screens where this is a drawer.
   *
   * Below `lg` the sidebar is 260px of a screen that may only be 390px wide,
   * so it slides in over the page instead of sitting beside it. Above `lg` it
   * is always there and this is ignored.
   */
  mobileOpen: boolean
  onMobileClose: () => void
}

/**
 * A menu group's label, as an id.
 *
 * Only needs to be stable and unique within the sidebar, which a lowercased
 * label with its spaces and punctuation knocked out is — "HR & Payroll"
 * becomes "hr-payroll".
 */
const slug = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export function Sidebar({ collapsed, onCollapse, mobileOpen, onMobileClose }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  // Every group starts shut; the user opens the one they want.
  const [openMenus, setOpenMenus] = useState<string[]>([])
  const [user, setUser] = useState<{ name?: string; role?: string } | null>(null)
  const { qcInDailyProduction } = useAppSettings()

  // A mill that records output without a per-day QC entry should not be looking
  // at a menu item it never uses. Settings → Preferences controls this.
  const items = useMemo(() => {
    if (qcInDailyProduction) return navItems

    return navItems.map((item) =>
      item.label === 'Production' && item.children
        ? { ...item, children: item.children.filter((c) => c.href !== '/production/qc') }
        : item,
    )
  }, [qcInDailyProduction])

  // localStorage is browser-only, so the signed-in user arrives after mount.
  useEffect(() => {
    setUser(currentUser())
  }, [])

  const signOut = async () => {
    try {
      await api.post('/auth/logout', {})
    } catch {
      // Signing out must work even when the server cannot be reached: the
      // tokens live in this browser and clearing them is what actually matters.
    }
    tokens.clear()
    router.push('/login')
  }

  const toggleMenu = (label: string) => {
    setOpenMenus((prev) =>
      prev.includes(label) ? prev.filter((m) => m !== label) : [...prev, label]
    )
  }

  /*
   * Following a link closes the drawer.
   *
   * On a phone the drawer covers the page, so without this you tap a menu
   * item, the page behind you changes, and you are still looking at the menu
   * — which reads as the tap not having worked.
   */
  useEffect(() => {
    onMobileClose()
    // Only when the route changes. Including the callback would close the
    // drawer on every render of the layout above it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/')

  const isGroupActive = (item: NavItem) =>
    item.children?.some((c) => isActive(c.href)) ?? false

  return (
    <aside
      className={cn(
        'h-screen flex flex-col fixed left-0 top-0 z-40 transition-all duration-300',
        'border-r border-[hsl(var(--sidebar-border))]',
        collapsed ? 'w-[68px]' : 'w-[260px]',
        /* Below lg this is a drawer: off the left edge until it is asked for,
           and always in place from lg up. 260px of a 390px screen left 130px
           for the screen itself, which is not a layout, it is a sliver. */
        'lg:translate-x-0',
        mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
      )}
      style={{ background: 'hsl(var(--sidebar-bg))' }}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-[hsl(var(--sidebar-border))] shrink-0">
        <div className="w-9 h-9 rounded-xl bg-teal-500/10 border border-teal-500/20 flex items-center justify-center shrink-0">
          <span className="text-sm font-black gradient-text-teal">LD</span>
        </div>
        {!collapsed && (
          <div className="overflow-hidden">
            <p className="text-sm font-bold text-foreground leading-tight whitespace-nowrap">LD ERP Solution</p>
            <p className="text-xs text-muted-foreground whitespace-nowrap">LD Cotton Mills</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto no-scrollbar py-3 px-2">
        <div className="space-y-0.5">
          {items.map((item) => {
            const Icon = item.icon

            if (item.children) {
              const isOpen = openMenus.includes(item.label)
              const groupActive = isGroupActive(item)

              return (
                <div key={item.label}>
                  {/* `aria-expanded` says whether the group is open, and
                    `aria-controls` says what it opens. Neither was here, so
                    the chevron was the only indication and it is drawn, not
                    announced — a screen reader could not tell an open Purchase
                    menu from a closed one, and nor could anything else driving
                    the page. Collapsed to icons the button does not expand
                    anything, so it claims nothing. */}
                  <button
                    onClick={() => !collapsed && toggleMenu(item.label)}
                    aria-expanded={collapsed ? undefined : isOpen}
                    aria-controls={collapsed ? undefined : `nav-group-${slug(item.label)}`}
                    className={cn(
                      'nav-item group w-full',
                      groupActive && 'text-teal-400'
                    )}
                  >
                    <Icon
                      size={18}
                      className={cn(
                        'shrink-0 transition-colors',
                        groupActive ? 'text-teal-400' : 'text-slate-500 group-hover:text-slate-300'
                      )}
                    />
                    {!collapsed && (
                      <>
                        <span className="flex-1 text-left">{item.label}</span>
                        <ChevronDown
                          size={14}
                          className={cn('transition-transform duration-200', isOpen && 'rotate-180')}
                        />
                      </>
                    )}
                  </button>

                  {!collapsed && isOpen && (
                    <div
                      id={`nav-group-${slug(item.label)}`}
                      className="ml-4 mt-0.5 pl-4 border-l border-border/50 space-y-0.5 animate-fade-in"
                    >
                      {item.children.map((child) =>
                        child.planned ? (
                          <div
                            key={child.href}
                            title="Not built yet"
                            aria-disabled="true"
                            className="flex items-center gap-2 px-2 py-2 rounded-lg text-xs font-medium text-slate-600 cursor-default select-none"
                          >
                            <ChevronRightIcon size={12} className="shrink-0 opacity-40" />
                            <span className="flex-1">{child.label}</span>
                            <span className="text-[9px] uppercase tracking-wider text-slate-600 border border-slate-700 rounded px-1 py-px">
                              soon
                            </span>
                          </div>
                        ) : (
                          <Link
                            key={child.href}
                            href={child.href}
                            className={cn(
                              'flex items-center gap-2 px-2 py-2 rounded-lg text-xs font-medium transition-colors',
                              isActive(child.href)
                                ? 'text-teal-400 bg-teal-500/10'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
                            )}
                          >
                            <ChevronRightIcon size={12} className="shrink-0" />
                            {child.label}
                          </Link>
                        ),
                      )}
                    </div>
                  )}
                </div>
              )
            }

            if (item.planned) {
              return (
                <div
                  key={item.label}
                  title="Not built yet"
                  aria-disabled="true"
                  className="nav-item text-slate-600 cursor-default select-none"
                >
                  <Icon size={18} className="shrink-0 opacity-40" />
                  {!collapsed && (
                    <>
                      <span className="flex-1">{item.label}</span>
                      <span className="text-[9px] uppercase tracking-wider border border-slate-700 rounded px-1 py-px">
                        soon
                      </span>
                    </>
                  )}
                </div>
              )
            }

            return (
              <Link
                key={item.label}
                href={item.href!}
                className={cn('nav-item group', isActive(item.href!) && 'active')}
              >
                <Icon
                  size={18}
                  className={cn(
                    'shrink-0',
                    isActive(item.href!) ? 'text-teal-400' : 'text-slate-500 group-hover:text-slate-300'
                  )}
                />
                {!collapsed && (
                  <>
                    <span className="flex-1">{item.label}</span>
                    {item.badge && (
                      <span
                        className={cn(
                          'text-[10px] font-bold px-1.5 py-0.5 rounded-full',
                          item.badgeColor === 'teal'
                            ? 'bg-teal-500/20 text-teal-400'
                            : 'bg-amber-500/20 text-amber-400'
                        )}
                      >
                        {item.badge}
                      </span>
                    )}
                  </>
                )}
              </Link>
            )
          })}
        </div>
      </nav>

      {/* AI Quick Access */}
      {!collapsed && (
        <div className="px-3 py-2">
          <Link
            href="/ai"
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-teal-500/8 border border-teal-500/15 hover:bg-teal-500/15 transition-all group"
          >
            <div className="w-6 h-6 rounded-lg bg-teal-500/20 flex items-center justify-center">
              <Zap size={12} className="text-teal-400 group-hover:animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-teal-300">Ask AI</p>
              <p className="text-[10px] text-teal-500/70 truncate">Powered by Gemini</p>
            </div>
          </Link>
        </div>
      )}

      {/* Bottom: User + Collapse */}
      <div className="border-t border-[hsl(var(--sidebar-border))] p-3 space-y-1 shrink-0">
        {!collapsed && (
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors">
            <div className="w-8 h-8 rounded-full bg-teal-500/20 border border-teal-500/20 flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-teal-400">
                {user?.name ? initialsOf(user.name) : '—'}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-foreground truncate">
                {user?.name ?? 'Signed in'}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">{user?.role ?? ''}</p>
            </div>
            <button
              onClick={() => void signOut()}
              title="Sign out"
              aria-label="Sign out"
              className="p-1 rounded text-muted-foreground hover:text-red-400 transition-colors"
            >
              <LogOut size={14} />
            </button>
          </div>
        )}

        {/* Hidden where this is a drawer: a drawer is open or shut, and a
            68px-wide drawer over a 390px screen is neither. */}
        <button
          onClick={() => onCollapse(!collapsed)}
          className="btn-ghost hidden w-full justify-center py-2 text-muted-foreground lg:flex"
        >
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
          {!collapsed && <span className="text-xs">Collapse</span>}
        </button>
      </div>
    </aside>
  )
}
