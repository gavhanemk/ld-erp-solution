import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Print',
  robots: 'noindex, nofollow',
}

/**
 * Print pages sit outside the app shell on purpose.
 *
 * They used to live inside the dashboard layout, which put the sidebar and top
 * bar on the page — and since only the toolbar was marked no-print, both would
 * have come out on the paper. Keeping them out entirely is safer than
 * remembering to hide them, and it gives a true preview: what is on screen is
 * what comes out of the printer.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`
        .print-surface {
          min-height: 100vh;
          /* A desk to lay the sheet on, so the page edges are visible. */
          background: #5a5a5f;
          padding: 16px 0;
        }
        /* Always light. The ERP has a dark theme, and the sheet must not
           inherit it — nor should this grey backing reach the paper. */
        @media print {
          .print-surface { background: #fff !important; padding: 0 !important; min-height: 0 !important; }
        }
      `}</style>
      <div className="print-surface">{children}</div>
    </>
  )
}
