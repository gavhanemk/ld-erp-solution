/*
 * Builds the API for the server, one file at a time.
 *
 * `tsc` reads every type the code touches before it writes a line, and the
 * Prisma client's generated types are enormous: the whole program needs about
 * 950 MB of memory to compile, and the build machine on Render's free plan has
 * 512 MB. The build died there once the Sales module's tables were added.
 *
 * TypeScript's own transpileModule turns each file into JavaScript on its own,
 * without loading any types, so it needs a few tens of megabytes. The output
 * is the same JavaScript `tsc` writes, to the same place
 * (dist/apps/api/src/index.js), with the same compiler settings read from
 * tsconfig.json. Type errors are not looked for here; `pnpm --filter api
 * type-check` does that, and is run before a change is merged.
 */
const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const apiDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(apiDir, '../..')

const configFile = ts.readConfigFile(path.join(apiDir, 'tsconfig.json'), ts.sys.readFile)
if (configFile.error) fail([configFile.error])
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, apiDir)
if (parsed.errors.length) fail(parsed.errors)
const options = parsed.options
const outDir = options.outDir

// The app's own files, and the workspace packages it is compiled with — as
// tsc does, with the repository as the common root.
const packageFiles = Object.values(options.paths ?? {})
  .flat()
  .map((p) => path.dirname(path.resolve(apiDir, p)))
  .flatMap((dir) => ts.sys.readDirectory(dir, ['.ts'], ['**/*.d.ts']))
const files = [...new Set([...parsed.fileNames, ...packageFiles].map((f) => path.resolve(f)))].filter((f) => !f.endsWith('.d.ts'))

const slash = (p) => p.split(path.sep).join('/')
let written = 0
const problems = []
for (const file of files) {
  const rel = path.relative(repoRoot, file)
  const outJs = path.join(outDir, rel.replace(/\.ts$/, '.js'))
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: options,
    fileName: path.basename(file),
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) {
    problems.push(...errors.map((d) => ({ ...d, file: d.file ?? ts.createSourceFile(file, '', ts.ScriptTarget.Latest) })))
    continue
  }
  fs.mkdirSync(path.dirname(outJs), { recursive: true })
  fs.writeFileSync(outJs, result.outputText)
  if (result.sourceMapText) {
    // Point the map back at the source the way tsc does: relative to the .js.
    const map = JSON.parse(result.sourceMapText)
    map.file = path.basename(outJs)
    map.sources = [slash(path.relative(path.dirname(outJs), file))]
    fs.writeFileSync(`${outJs}.map`, JSON.stringify(map))
  }
  written++
}
if (problems.length) fail(problems)
console.log(`Built ${written} files into ${slash(path.relative(apiDir, outDir))}/ without type-checking (run type-check for that).`)

function fail(diagnostics) {
  const host = { getCanonicalFileName: (f) => f, getCurrentDirectory: () => apiDir, getNewLine: () => '\n' }
  console.error(ts.formatDiagnostics(diagnostics, host))
  process.exit(1)
}
