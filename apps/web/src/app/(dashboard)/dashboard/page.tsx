import type { Metadata } from 'next'
import { HomeDashboard } from '@/components/home/HomeDashboard'

export const metadata: Metadata = {
  title: 'Dashboard',
}

export default function DashboardPage() {
  return <HomeDashboard />
}
