'use client'

import { useEffect, useState } from 'react'
import { api } from './api'

/**
 * Display preferences, shared by every screen.
 *
 * These are set once in Settings → Preferences and then read all over the app,
 * including from plain functions like formatDate that cannot use a React hook.
 * So they live in a module-level value with a subscription on top, rather than
 * in context.
 */

export interface AppSettings {
  rowsPerPage: number
  dateFormat: 'DD-MMM-YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD'
  qcInDailyProduction: boolean
}

/** Matches the defaults in the API's preference catalogue. */
const FALLBACK: AppSettings = {
  rowsPerPage: 25,
  dateFormat: 'DD-MMM-YYYY',
  qcInDailyProduction: true,
}

const STORAGE_KEY = 'app_settings'

let current: AppSettings = { ...FALLBACK }
let loaded = false

const listeners = new Set<(s: AppSettings) => void>()

/** The current settings. Safe to call from anywhere, including during render. */
export function appSettings(): AppSettings {
  return current
}

function apply(next: AppSettings) {
  current = next
  for (const listener of listeners) listener(next)
}

function normalise(raw: Record<string, unknown> | null | undefined): AppSettings {
  if (!raw) return { ...FALLBACK }

  const rows = Number(raw.rowsPerPage)
  const format = String(raw.dateFormat)

  return {
    rowsPerPage: Number.isFinite(rows) && rows > 0 ? rows : FALLBACK.rowsPerPage,
    dateFormat: (['DD-MMM-YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'] as const).includes(
      format as AppSettings['dateFormat'],
    )
      ? (format as AppSettings['dateFormat'])
      : FALLBACK.dateFormat,
    qcInDailyProduction:
      typeof raw.qcInDailyProduction === 'boolean'
        ? raw.qcInDailyProduction
        : FALLBACK.qcInDailyProduction,
  }
}

/**
 * Loads the settings from the API.
 *
 * The last known values are read from localStorage first, so a reload renders
 * with the right date format immediately instead of flickering from the
 * default to the real one once the request lands.
 */
export async function loadAppSettings(force = false): Promise<AppSettings> {
  if (loaded && !force) return current

  if (typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem(STORAGE_KEY)
      if (cached) apply(normalise(JSON.parse(cached)))
    } catch {
      // A corrupt cache is not worth reporting; the request below replaces it.
    }
  }

  try {
    const res = await api.get<{ success: boolean; data: Record<string, unknown> }>('/settings/app')
    const next = normalise(res.data)
    apply(next)
    loaded = true

    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // Storage can be full or blocked; the settings still work for this session.
      }
    }
  } catch {
    // Falling back to the defaults keeps every screen usable when the API is
    // down, which matters more than the exact number of rows per page.
  }

  return current
}

export function useAppSettings(): AppSettings {
  const [value, setValue] = useState<AppSettings>(current)

  useEffect(() => {
    listeners.add(setValue)
    void loadAppSettings()
    return () => {
      listeners.delete(setValue)
    }
  }, [])

  return value
}
