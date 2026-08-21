import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    template: '%s | LD ERP Solution',
    default: 'LD ERP Solution — AI-Powered Garment ERP',
  },
  description:
    'LD ERP Solution — Complete AI-powered ERP system for LD Cotton Mills. Manage Sales, Purchase, Production, Inventory, Accounts and HR in one platform.',
  keywords: ['ERP', 'Garment Manufacturing', 'LD Cotton Mills', 'VHAGAR', 'AI ERP'],
  authors: [{ name: 'LD Cotton Mills' }],
  creator: 'LD Cotton Mills',
  robots: 'noindex, nofollow', // private app
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.ico" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  )
}
