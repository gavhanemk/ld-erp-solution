// Source runner for isolated local tools when tsx cannot run in a restricted Windows session.
const fs = require('node:fs')
const ts = require('typescript')
const path = require('node:path')
const Module = require('node:module')
const resolve = Module._resolveFilename
const aliases = {
  '@ld-erp/database': path.resolve(__dirname, '../packages/database/src/index.ts'),
  '@ld-erp/shared': path.resolve(__dirname, '../packages/shared/src/index.ts'),
}
Module._resolveFilename = function (name, ...args) {
  return resolve.call(this, aliases[name] || name, ...args)
}
require.extensions['.ts'] = (module, file) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: file,
    }).outputText,
    file
  )
