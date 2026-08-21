import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // typedRoutes rejects any href whose page does not exist yet. Most modules
  // are still being built, and the sidebar already links to all of them, so it
  // would fail every build until the last screen lands. Turn it back on once
  // the routes exist — it is genuinely useful for catching broken links.
  experimental: { typedRoutes: false },
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**.ldcottonmills.com' }],
  },
  env: {
    NEXT_PUBLIC_APP_NAME: 'LD ERP Solution',
    NEXT_PUBLIC_COMPANY_NAME: 'LD Cotton Mills',
  },
  async redirects() {
    return [{ source: '/', destination: '/dashboard', permanent: false }]
  },
}

export default nextConfig
