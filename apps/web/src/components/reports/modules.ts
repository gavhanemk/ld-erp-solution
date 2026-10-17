/** A report module as people say it, for the reports list and a report's way back to it. */
export const MODULE_WORDS: Record<string, string> = {
  purchase: 'Purchase',
  sales: 'Sales',
  inventory: 'Inventory',
  production: 'Production',
  accounts: 'Accounts',
  hr: 'HR & Payroll',
}

/** The reports list opened on one module. */
export const moduleReportsHref = (module: string) => `/reports?module=${encodeURIComponent(module)}`
