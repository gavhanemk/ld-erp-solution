import { api, type Single } from './api'

/** Types and calls for the Settings screens. */

export interface Company {
  id: string
  name: string
  legalName: string | null
  address: string | null
  city: string | null
  state: string | null
  pincode: string | null
  gstin: string | null
  pan: string | null
  phone: string | null
  email: string | null
  website: string | null
  currentFY: string | null
  fyStartMonth: number
}

export interface SettingsUser {
  id: string
  name: string
  email: string
  phone: string | null
  employeeCode: string | null
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED'
  roleId: string
  lastLoginAt: string | null
  createdAt: string
  role: { id: string; name: string }
}

export interface SettingsRole {
  id: string
  name: string
  description: string | null
  isSystem: boolean
  userCount: number
  /** The Admin role bypasses the matrix entirely, so its grants are not editable. */
  unrestricted: boolean
  permissions: string[]
}

export interface PermissionModule {
  module: string
  label: string
  actions: { action: string; label: string; key: string }[]
}

export interface NumberSeries {
  id: string
  docType: string
  label: string
  prefix: string
  separator: string
  financialYear: string
  lastNumber: number
  padding: number
  isActive: boolean
  nextNumber: string
}

export interface TaxRate {
  id: string
  name: string
  rate: number
  isDefault: boolean
  isActive: boolean
}

export interface TdsSection {
  id: string
  section: string
  label: string
  rate: number
  isDefault: boolean
  isActive: boolean
}

export interface PreferenceDefinition {
  key: string
  label: string
  help: string
  group: string
  type: 'boolean' | 'select' | 'number'
  default: boolean | string | number
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  affects: string
}

export interface ActivityEntry {
  id: string
  module: string
  moduleLabel: string
  action: string
  entityType: string
  entityId: string
  user: { id: string; name: string; email: string } | null
  ipAddress: string | null
  createdAt: string
  changed: string[]
}

export interface DocumentBranding {
  logoUrl: string | null
  signatureUrl: string | null
  bankName: string | null
  bankBranch: string | null
  bankAccount: string | null
  bankIFSC: string | null
  upiId: string | null
}

export interface DocumentTemplate {
  docType: string
  label: string
  title: string
  termsText: string | null
  declaration: string | null
  footerNote: string | null
  showHsn: boolean
  showAmountInWords: boolean
  showBankDetails: boolean
  showSignature: boolean
  copies: string[]
  isActive: boolean
  configured: boolean
}

export type AiProvider = 'openai' | 'gemini'

export interface AiSettings {
  provider: AiProvider
  providerLabel: string
  configured: boolean
  keyHint: string | null
  source: 'settings' | 'environment' | 'none'
  model: string
  enabled: boolean
  dailySummary: boolean
  models: { value: string; label: string; provider: AiProvider }[]
  /** Providers that already have a usable key somewhere. */
  available: AiProvider[]
  permissionScoped: boolean
}

export interface SystemStatus {
  company: string | null
  financialYear: string | null
  database: { connected: boolean; latencyMs: number | null; error?: string }
  counts: { activeUsers: number; roles: number; auditEntries: number }
  connections: { key: string; name: string; connected: boolean; detail: string }[]
  server: { environment: string; node: string; uptimeSeconds: number }
}

interface ListResponse<T> {
  success: boolean
  data: T[]
}

export const settingsApi = {
  company: {
    get: () => api.get<Single<Company>>('/settings/company'),
    update: (data: Partial<Company>) => api.patch<Single<Company>>('/settings/company', data),
  },

  users: {
    list: (q?: string) =>
      api.get<ListResponse<SettingsUser>>(`/settings/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    create: (data: Record<string, unknown>) => api.post<Single<SettingsUser>>('/settings/users', data),
    update: (id: string, data: Record<string, unknown>) =>
      api.patch<Single<SettingsUser>>(`/settings/users/${id}`, data),
    resetPassword: (id: string, password: string) =>
      api.post<{ success: boolean; message: string }>(`/settings/users/${id}/reset-password`, { password }),
    deactivate: (id: string) => api.delete<{ success: boolean; message: string }>(`/settings/users/${id}`),
  },

  roles: {
    list: () => api.get<ListResponse<SettingsRole>>('/settings/roles'),
    create: (data: Record<string, unknown>) => api.post<Single<SettingsRole>>('/settings/roles', data),
    update: (id: string, data: Record<string, unknown>) =>
      api.patch<Single<SettingsRole> & { message?: string }>(`/settings/roles/${id}`, data),
    remove: (id: string) => api.delete<{ success: boolean; message: string }>(`/settings/roles/${id}`),
  },

  permissions: () =>
    api.get<ListResponse<PermissionModule> & { actions: { action: string; label: string }[] }>(
      '/settings/permissions',
    ),

  numberSeries: {
    list: () => api.get<ListResponse<NumberSeries>>('/settings/number-series'),
    create: (data: Record<string, unknown>) => api.post<Single<NumberSeries>>('/settings/number-series', data),
    update: (id: string, data: Record<string, unknown>) =>
      api.patch<Single<NumberSeries> & { message?: string }>(`/settings/number-series/${id}`, data),
  },

  taxRates: {
    list: () => api.get<ListResponse<TaxRate>>('/settings/tax-rates'),
    create: (data: Record<string, unknown>) => api.post<Single<TaxRate>>('/settings/tax-rates', data),
    update: (id: string, data: Record<string, unknown>) =>
      api.patch<Single<TaxRate>>(`/settings/tax-rates/${id}`, data),
    remove: (id: string) => api.delete<{ success: boolean; message: string }>(`/settings/tax-rates/${id}`),
  },

  tdsSections: {
    list: () => api.get<ListResponse<TdsSection>>('/settings/tds-sections'),
    create: (data: Record<string, unknown>) => api.post<Single<TdsSection>>('/settings/tds-sections', data),
    update: (id: string, data: Record<string, unknown>) =>
      api.patch<Single<TdsSection>>(`/settings/tds-sections/${id}`, data),
    remove: (id: string) => api.delete<{ success: boolean; message: string }>(`/settings/tds-sections/${id}`),
  },

  preferences: {
    get: () =>
      api.get<{ success: boolean; data: Record<string, unknown>; definitions: PreferenceDefinition[] }>(
        '/settings/preferences',
      ),
    update: (patch: Record<string, unknown>) =>
      api.patch<{ success: boolean; data: Record<string, unknown> }>('/settings/preferences', patch),
  },

  activity: (params: { page?: number; module?: string; action?: string } = {}) => {
    const search = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v) search.set(k, String(v))
    const qs = search.toString()
    return api.get<
      ListResponse<ActivityEntry> & {
        pagination: { page: number; limit: number; total: number; pages: number }
      }
    >(`/settings/activity${qs ? `?${qs}` : ''}`)
  },

  system: () => api.get<Single<SystemStatus>>('/settings/system'),

  documents: {
    get: () =>
      api.get<Single<{ branding: DocumentBranding; documents: DocumentTemplate[] }>>(
        '/settings/documents',
      ),
    saveBranding: (patch: Record<string, unknown>) =>
      api.patch<{ success: boolean; message: string }>('/settings/documents/branding', patch),
    saveTemplate: (docType: string, patch: Record<string, unknown>) =>
      api.patch<Single<DocumentTemplate>>(`/settings/documents/${docType}`, patch),
  },

  ai: {
    get: () => api.get<Single<AiSettings>>('/settings/ai'),
    update: (patch: Record<string, unknown>) => api.patch<Single<AiSettings>>('/settings/ai', patch),
    /** Actually calls the model, rather than checking a string is present. */
    // Tests whatever is actually saved. Testing a key sitting unsaved in the
    // box would report on a configuration the server is not using.
    test: () =>
      api.post<{ success: boolean; message: string; model?: string }>('/settings/ai/test', {}),
  },

  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    api.post<{ success: boolean; message: string }>('/settings/change-password', {
      currentPassword,
      newPassword,
    }),
}
