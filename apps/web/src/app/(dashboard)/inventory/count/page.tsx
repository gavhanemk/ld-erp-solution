'use client'

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { StockCountList } from '@/components/inventory/count/StockCountList'
import { StockCountScreen } from '@/components/inventory/count/StockCountScreen'

/**
 * Inventory → Stock → Stock Count: every count, and one count open for
 * scanning. The open count is in the address, so a phone that sleeps mid-count
 * comes back to the same count.
 */
function StockCountPage() {
  const router = useRouter()
  const id = useSearchParams().get('id')
  const open = (countId: string) => router.push(`/inventory/count?id=${countId}`)
  return id ? <StockCountScreen key={id} id={id} onBack={() => router.push('/inventory/count')} /> : <StockCountList onOpen={open} />
}

// useSearchParams needs a Suspense boundary or the build refuses the route.
export default function Page() {
  return (
    <Suspense fallback={null}>
      <StockCountPage />
    </Suspense>
  )
}
