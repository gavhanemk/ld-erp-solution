import { PrismaClient } from '@prisma/client'
import { seedCore } from './seed-core'
import { loadEnv } from './load-env'

// Before anything reaches Prisma. A script run through tsx does not read .env
// by itself, and which folder the command was typed in should not decide
// whether it can find the database.
loadEnv(__dirname)

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
