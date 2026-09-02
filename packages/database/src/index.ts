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
    // Prisma gives an interactive transaction five seconds, which assumes the
    // database is next to the application. Ours is not: it is a pooled Supabase
    // instance in Singapore, and a round trip from here costs a few hundred
    // milliseconds.
    //
    // Every document that moves stock has to do its numbering, its writing and
    // its stock movements inside one transaction — that is what stops a number
    // being allocated to a document that never saved. A goods receipt of one
    // line is around seventeen round trips, which is already over the five
    // seconds, and a requisition issued across several lines is worse. The
    // default does not fail under load; it fails on the first honest use.
    //
    // The ceiling is real: a transaction holds a connection and its stock lock
    // for as long as it runs. If receipts ever grow long enough to approach
    // this, the answer is fewer round trips per document, not a larger number
    // here.
    transactionOptions: { timeout: 20_000, maxWait: 10_000 },
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
export * from '@prisma/client';
