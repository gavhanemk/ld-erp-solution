import { redirect } from 'next/navigation'

/**
 * The job cards are Production Floor's first tab now (12 Nov 2026): each one
 * with where its pieces are, and its "Job card" button opens the window this
 * list did (header, process forms, print). Those whose order's stages are not
 * loaded yet are listed above the board. The old address goes there.
 */
export default function JobCardsPage() {
  redirect('/production/floor')
}
