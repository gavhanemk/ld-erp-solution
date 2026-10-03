import type { EnquiryRecord } from '@/components/purchase/enquiryTypes'

/*
 * The enquiry, handed from its screen to the order page it links to.
 *
 * Loading one enquiry takes the server a few seconds (it pulls a dozen related
 * tables), and the enquiry screen has just done exactly that. Passing its copy
 * across opens the order form at once instead of making the buyer wait for the
 * same rows again. It is only trusted for a couple of minutes, and the server
 * checks the quote, supplier and enquiry status again when the order is saved.
 */

const KEY = 'ld-erp:order-from-enquiry'
const FRESH_FOR_MS = 2 * 60_000

export function handEnquiryToOrder(enquiry: EnquiryRecord): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ at: Date.now(), enquiry }))
  } catch {
    // Storage full or blocked: the order page simply fetches it instead.
  }
}

/**
 * The handed-over enquiry, if it is the one wanted and still fresh.
 *
 * Left in place rather than removed on reading: React runs a page's first
 * effect twice in development, and the second run must find it too. The next
 * hand-over replaces it, and it goes stale on its own.
 */
export function takeHandedEnquiry(enquiryId: string): EnquiryRecord | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const { at, enquiry } = JSON.parse(raw) as { at: number; enquiry: EnquiryRecord }
    if (enquiry?.id !== enquiryId || Date.now() - at > FRESH_FOR_MS) return null
    return enquiry
  } catch {
    return null
  }
}
