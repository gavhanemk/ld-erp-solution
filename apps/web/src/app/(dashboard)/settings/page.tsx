'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { canOpen, loadAccess } from '@/lib/access'
import { LoadingRow } from '@/components/settings/ui'

/**
 * /settings has no content of its own: it opens the first section this role
 * may see — Company for most, People for someone allowed only users and roles.
 */
const SECTIONS = ['/settings/company', '/settings/people', '/settings/documents', '/settings/preferences', '/settings/system']

export default function SettingsIndexPage() {
  const router = useRouter()
  useEffect(() => {
    void loadAccess().then(() => router.replace(SECTIONS.find((s) => canOpen(s)) ?? '/settings/company'))
  }, [router])
  return <LoadingRow label="Opening settings…" />
}
