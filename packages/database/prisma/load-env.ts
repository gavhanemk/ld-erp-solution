import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Puts DATABASE_URL and friends into the environment before Prisma looks for
 * them.
 *
 * Prisma's CLI reads .env by itself, but a script run straight through tsx does
 * not — and whether it happens to work depends on which directory the command
 * was typed in. That produced a seed that ran fine from packages/database and
 * failed from the repo root with "Environment variable not found", which is a
 * confusing first hour for somebody new to the project.
 *
 * Anything already set in the real environment wins, so a deployment that
 * supplies its own DATABASE_URL is never overridden by a checked-out file.
 */
export function loadEnv(startDir = process.cwd()): void {
  let dir = startDir

  // Walk up to the repo root looking for the database package's .env.
  for (let i = 0; i < 6; i += 1) {
    for (const candidate of [join(dir, '.env'), join(dir, 'packages', 'database', '.env')]) {
      if (existsSync(candidate)) {
        apply(readFileSync(candidate, 'utf8'))
        return
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
}

function apply(contents: string): void {
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue

    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue

    // A value may be quoted, and a Postgres URL routinely holds a '#' in its
    // password — so a comment is only a comment when it starts the line.
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2')
  }
}
