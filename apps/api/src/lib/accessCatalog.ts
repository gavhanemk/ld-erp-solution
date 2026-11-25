/**
 * Every screen of the ERP that a role can be allowed into, module by module.
 *
 * The one list the access system works from. Settings → People draws its
 * matrix from it, the menu hides what a role may not open by it, and the
 * server decides from it which screen a request belongs to.
 *
 * A screen's key is `module.screen` — `purchase.orders`. A permission is that
 * key and an action: `purchase.orders:create`. A grant on the module itself,
 * `purchase:create`, still means every screen in it, which is how every role
 * was set up before screens existed, so nobody's access changed on the day
 * this arrived.
 *
 *   hrefs  the pages of the screen, for the menu and for opening it by address
 *   api    where its requests go; the longest match wins, so a screen under
 *          another's address (/api/purchase/orders-dashboard under
 *          /api/purchase/orders) is still told apart
 *
 * A screen lists only the actions that mean something on it: a report has
 * nothing to add or approve, so it offers View and Export and no more.
 */

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'post', 'export'] as const
export type Action = (typeof ACTIONS)[number]

export const ACTION_LABELS: Record<Action, string> = {
  view: 'View',
  create: 'Add',
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
  post: 'Post',
  export: 'Export',
}

/** The role nothing can restrict: every screen, every action, now and later. */
export const SUPER_ROLE = 'Super Admin'
/** The roles that may approve their own requisitions and other such exceptions. */
export const ADMIN_ROLES = [SUPER_ROLE, 'Admin']

export interface Screen {
  key: string
  label: string
  actions: readonly Action[]
  hrefs: string[]
  api: string[]
  /** A line under the name in the matrix, where the name alone could mislead. */
  hint?: string
}

export interface AccessModule {
  key: string
  label: string
  screens: Screen[]
}

const DOC: readonly Action[] = ['view', 'create', 'edit', 'delete', 'approve', 'export']
const MASTER: readonly Action[] = ['view', 'create', 'edit', 'delete', 'export']
const READ: readonly Action[] = ['view', 'export']
const LOOK: readonly Action[] = ['view']

const s = (key: string, label: string, actions: readonly Action[], hrefs: string[], api: string[] = [], hint?: string): Screen => ({
  key,
  label,
  actions,
  hrefs,
  api,
  hint,
})

export const ACCESS_CATALOG: AccessModule[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    screens: [s('dashboard', 'Home dashboard', LOOK, ['/dashboard'], ['/api/dashboard'])],
  },
  {
    key: 'masters',
    label: 'Master data',
    screens: [
      s('masters.items', 'Items & Products', MASTER, ['/masters/items'], ['/api/masters/items', '/api/masters/qty-places']),
      s('masters.item-categories', 'Item Categories', MASTER, ['/masters/item-categories'], ['/api/masters/item-categories']),
      s('masters.hsn', 'HSN / SAC Codes', MASTER, ['/masters/hsn-codes'], ['/api/masters/hsn-codes']),
      s('masters.units', 'Units of Measure', MASTER, ['/masters/units'], ['/api/masters/uoms']),
      s('masters.expense-heads', 'Expense Heads', MASTER, ['/masters/expense-heads']),
      s('masters.styles', 'Styles & SKU', MASTER, ['/masters/styles'], ['/api/masters/styles', '/api/masters/style-orders', '/api/masters/style-tracking']),
      s('masters.brands', 'Brands', MASTER, ['/masters/brands'], ['/api/masters/brands']),
      s('masters.bom', 'Bill of Materials', DOC, ['/masters/bom'], ['/api/masters/bom']),
      s('masters.size-runs', 'Size Runs', MASTER, ['/masters/size-runs'], ['/api/masters/size-groups', '/api/masters/sizes']),
      s('masters.customers', 'Customers', MASTER, ['/masters/customers'], ['/api/masters/customers']),
      s('masters.suppliers', 'Suppliers', MASTER, ['/masters/suppliers'], ['/api/masters/suppliers']),
      s('masters.brokers', 'Agents & Brokers', MASTER, ['/masters/brokers'], ['/api/masters/brokers']),
      s('masters.departments', 'Departments', MASTER, ['/masters/departments'], ['/api/masters/departments']),
      s(
        'masters.routing',
        'Routing Masters',
        MASTER,
        ['/masters/processes', '/masters/workstations', '/masters/contractors'],
        ['/api/masters/operations', '/api/masters/workstations', '/api/masters/contractors', '/api/masters/machines'],
        'Processes, workstations and contractors',
      ),
      s('masters.routings', 'Routings', MASTER, ['/masters/routings'], ['/api/masters/routings'], 'Listed under Production in the menu'),
      s('masters.charges', 'Extra Charges', MASTER, ['/masters/charges'], ['/api/masters/charge-types']),
      s('masters.dropdowns', 'Dropdown Lists', MASTER, ['/masters/dropdown-lists'], ['/api/masters/dropdown-values']),
      s('masters.warehouses', 'Warehouses', MASTER, ['/masters/warehouses'], ['/api/masters/warehouses']),
      s('masters.bank-accounts', 'Bank Accounts', MASTER, ['/masters/bank-accounts'], ['/api/masters/bank-accounts']),
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    screens: [
      s('sales.dashboard', 'Sales Dashboard', LOOK, ['/sales/dashboard'], ['/api/sales/dashboard']),
      s('sales.quotations', 'Quotations', DOC, ['/sales/quotations'], ['/api/sales/quotations']),
      s('sales.orders', 'Sales Orders', DOC, ['/sales/orders'], ['/api/sales/orders', '/api/sales/order-attachments']),
      s('sales.challans', 'Delivery Challan', DOC, ['/sales/challan'], ['/api/sales/challans']),
      s('sales.invoices', 'Invoices', DOC, ['/sales/invoices'], ['/api/sales/invoices']),
      s('sales.payments', 'Payments Received', DOC, ['/sales/payments'], ['/api/sales/receipts']),
      s('sales.returns', 'Returns & Credit Notes', DOC, ['/sales/returns'], ['/api/sales/credit-notes']),
    ],
  },
  {
    key: 'purchase',
    label: 'Purchase',
    screens: [
      s('purchase.dashboard', 'Purchase Dashboard', LOOK, ['/purchase/dashboard'], ['/api/purchase/orders-dashboard']),
      s('purchase.enquiries', 'Purchase Enquiries', DOC, ['/purchase/enquiries'], ['/api/purchase/enquiries']),
      s(
        'purchase.orders',
        'Purchase Orders',
        DOC,
        ['/purchase/orders', '/purchase/service-orders'],
        ['/api/purchase/orders', '/api/purchase/attachments', '/api/purchase/order-defaults', '/api/purchase/indent-items'],
        'Goods and service purchase orders',
      ),
      s('purchase.grn', 'Goods Receipt (GRN)', DOC, ['/purchase/grn'], ['/api/purchase/grn', '/api/purchase/grn-attachments', '/api/purchase/qc']),
      s('purchase.rejected', 'Rejected Goods', DOC, ['/purchase/rejected'], ['/api/purchase/returnable']),
      s('purchase.bills', 'Purchase Bills', DOC, ['/purchase/bills'], ['/api/purchase/bills', '/api/purchase/from-grn']),
      s('purchase.returns', 'Purchase Returns', DOC, ['/purchase/returns'], ['/api/purchase/returns']),
      s('purchase.payments', 'Supplier Payments', DOC, ['/purchase/payments'], ['/api/purchase/payments', '/api/purchase/payment-attachments']),
      s('purchase.notes', 'Debit & Credit Notes', DOC, ['/purchase/debit-notes', '/purchase/credit-notes'], ['/api/purchase/notes']),
      s('purchase.expenses', 'Expenses', DOC, ['/purchase/expenses'], ['/api/purchase/expenses']),
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    screens: [
      s('inventory.dashboard', 'Inventory Dashboard', LOOK, ['/inventory/dashboard'], ['/api/inventory/dashboard']),
      s('inventory.stock', 'Stock', READ, ['/inventory/stock'], ['/api/inventory/stock', '/api/inventory/reorder', '/api/inventory/valuation']),
      s('inventory.documents', 'Stock Documents', DOC, ['/inventory/documents'], ['/api/inventory/transfers', '/api/inventory/adjustments'], 'Transfers and adjustments'),
      s('inventory.count', 'Stock Count', DOC, ['/inventory/count'], ['/api/stock-counts', '/api/inventory/count-sheet']),
      s('inventory.opening', 'Opening Stock', DOC, ['/inventory/opening-stock'], ['/api/inventory/opening-stock', '/api/inventory/opening']),
      s('inventory.process-stock', 'Process Stock', DOC, ['/inventory/process-stock'], ['/api/inventory/process-stock']),
      s('inventory.ledger', 'Inward & Outward', READ, ['/inventory/ledger'], ['/api/inventory/ledger']),
      s(
        'inventory.requisitions',
        'Material Requisitions',
        DOC,
        ['/inventory/requisitions'],
        ['/api/inventory/requisitions', '/api/inventory/requisition-mos', '/api/inventory/indents', '/api/inventory/reservations', '/api/inventory/held'],
      ),
      s('inventory.stickers', 'Stickers & Scan', DOC, ['/inventory/packages', '/inventory/scan'], ['/api/packages', '/api/retail']),
      s(
        'inventory.finished-goods',
        'Finished Goods',
        DOC,
        ['/inventory/finished-goods', '/inventory/garment-tags', '/inventory/garment-moves', '/inventory/cartons'],
        ['/api/finished-goods', '/api/garments', '/api/fg-cartons'],
        'Finished goods in, garment tags, garment in / out, cartons',
      ),
      s('inventory.trace', 'Track & Trace', LOOK, ['/inventory/trace'], ['/api/trace']),
      s('inventory.job-work', 'Job Work', DOC, ['/inventory/job-work'], ['/api/inventory/job-work', '/api/inventory/floor-returns']),
      s(
        'inventory.customer-material',
        'Customer Material',
        DOC,
        ['/inventory/customer-material'],
        ['/api/inventory/customer-grn', '/api/inventory/customer-return', '/api/inventory/statements'],
      ),
    ],
  },
  {
    key: 'production',
    label: 'Production',
    screens: [
      s('production.orders', 'Manufacturing Orders', DOC, ['/production/orders'], ['/api/production/orders', '/api/production/plan', '/api/production/plannable']),
      s(
        'production.floor',
        'Production Floor',
        DOC,
        ['/production/floor', '/production/job-cards', '/production/transfers', '/production/stages'],
        [
          '/api/production/transfers',
          '/api/production/job-cards',
          '/api/production/cutting',
          '/api/production/stage-tabs',
          '/api/production/stage-sheets',
          '/api/production/stage-report',
          '/api/production/size-changes',
          '/api/production/board',
          '/api/production/entries',
          '/api/production/qc',
          '/api/production/events',
        ],
        'Job cards, process transfers, cutting and the stages',
      ),
      s('production.job-work', 'Job Work Orders', DOC, [], ['/api/production/job-work-orders', '/api/production/job-work-returns']),
    ],
  },
  {
    key: 'accounts',
    label: 'Accounts',
    screens: [
      s('accounts.dashboard', 'Accounts Dashboard', LOOK, ['/accounts/dashboard'], ['/api/accounts/dashboard', '/api/accounts/summary']),
      s('accounts.vouchers', 'Day Book', ['view', 'create', 'edit', 'delete', 'approve', 'post', 'export'], ['/accounts/vouchers'], ['/api/accounts/vouchers', '/api/accounts/posting'], 'Vouchers'),
      s('accounts.ledger', 'Ledger', READ, ['/accounts/ledger'], ['/api/accounts/ledgers']),
      s('accounts.bank', 'Cash & Bank', READ, ['/accounts/bank'], ['/api/accounts/cash-bank']),
      s('accounts.bank-reco', 'Bank Reconciliation', ['view', 'edit', 'export'], ['/accounts/bank-reco'], ['/api/accounts/bank-reco']),
      s('accounts.trial-balance', 'Trial Balance', READ, ['/accounts/trial-balance'], ['/api/accounts/trial-balance']),
      s('accounts.profit-loss', 'Profit & Loss', READ, ['/accounts/profit-loss'], ['/api/accounts/profit-loss']),
      s('accounts.balance-sheet', 'Balance Sheet', READ, ['/accounts/balance-sheet'], ['/api/accounts/balance-sheet']),
      s(
        'accounts.chart',
        'Chart of Accounts',
        MASTER,
        ['/accounts/chart'],
        ['/api/accounts/groups', '/api/accounts/cost-centres', '/api/accounts/opening', '/api/accounts/stock-value', '/api/accounts/settings'],
        'Groups, ledgers to start from, opening balances, stock value',
      ),
      s('accounts.outstanding', 'Outstanding', READ, ['/accounts/outstanding'], ['/api/accounts/outstanding']),
      s('accounts.gst', 'GST Returns', READ, ['/accounts/gst'], ['/api/accounts/gst']),
      s('accounts.tds', 'TDS', READ, ['/accounts/tds'], ['/api/accounts/tds']),
    ],
  },
  {
    key: 'hr',
    label: 'HR & Payroll',
    screens: [
      s('hr.employees', 'Employees', MASTER, ['/hr/employees']),
      s('hr.attendance', 'Attendance', DOC, ['/hr/attendance']),
      s('hr.payroll', 'Payroll', DOC, ['/hr/payroll']),
    ],
  },
  {
    key: 'vhagar',
    label: 'VHAGAR brand',
    screens: [
      s('vhagar.catalog', 'Product Catalog', MASTER, ['/vhagar/catalog']),
      s('vhagar.production', 'Production Orders', DOC, ['/vhagar/production']),
      s('vhagar.sales', 'Sales', DOC, ['/vhagar/sales']),
      s('vhagar.pnl', 'Brand P&L', READ, ['/vhagar/pnl']),
    ],
  },
  {
    key: 'maintenance',
    label: 'Maintenance',
    screens: [s('maintenance', 'Maintenance', DOC, ['/maintenance'])],
  },
  {
    key: 'ai',
    label: 'AI assistant',
    screens: [
      s(
        'ai',
        'AI Assistant',
        ['view', 'create', 'edit', 'delete', 'approve', 'export'],
        ['/ai'],
        ['/api/ai'],
        'Add, Edit and Delete let it change records when asked; Approve lets it approve documents',
      ),
    ],
  },
  {
    key: 'settings',
    label: 'Settings',
    screens: [
      s(
        'settings',
        'Company, documents and preferences',
        ['view', 'create', 'edit', 'delete'],
        ['/settings/company', '/settings/documents', '/settings/preferences', '/settings/assistant', '/settings/recycle-bin', '/settings/system'],
        [],
      ),
    ],
  },
  {
    key: 'admin',
    label: 'Users & roles',
    screens: [s('admin', 'People and roles', ['view', 'create', 'edit', 'delete'], ['/settings/people'])],
  },
]

/** Every screen, by key. */
export const SCREENS = new Map(ACCESS_CATALOG.flatMap((m) => m.screens.map((sc) => [sc.key, { ...sc, module: m.key }] as const)))

/** The module a key belongs to: `purchase.orders` → `purchase`, `ai` → `ai`. */
export const moduleOf = (key: string) => key.split('.')[0]

/** Every API prefix, longest first, so the most specific screen wins. */
const API_PREFIXES = [...SCREENS.values()]
  .flatMap((sc) => sc.api.map((prefix) => ({ prefix, key: sc.key })))
  .sort((a, b) => b.prefix.length - a.prefix.length)

/** The screen a request belongs to, from its address; null when none claims it. */
export function screenForPath(path: string): string | null {
  for (const p of API_PREFIXES) {
    if (path === p.prefix || path.startsWith(p.prefix + '/')) return p.key
  }
  return null
}

/** Every permission the catalogue knows, as "key:action". */
export const CATALOG_PERMISSIONS = [...SCREENS.values()].flatMap((sc) => sc.actions.map((a) => ({ module: sc.key, action: a })))
