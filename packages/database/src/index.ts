import { PrismaClient } from '@prisma/client';

// A single PrismaClient per process. Each `new PrismaClient()` opens its own
// connection pool, so route files must import this instead of constructing one.
// The globalThis cache keeps dev hot-reload from leaking a pool per reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
export * from '@prisma/client';
