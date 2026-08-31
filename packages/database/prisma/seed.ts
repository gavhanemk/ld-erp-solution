import { PrismaClient } from '@prisma/client'
import { seedCore } from './seed-core'

/**
 * The seed a real install runs: company, roles, permissions, units, tax rates
 * and number series. Nothing invented.
 *
 * For a database full of make-believe customers and orders to show people,
 * run `pnpm seed:demo` instead — it wipes first, so never point it at a
 * database anyone is actually working in.
 */
const prisma = new PrismaClient()

seedCore(prisma)
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
