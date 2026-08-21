import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  experimental: { typedRoutes: true },
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
