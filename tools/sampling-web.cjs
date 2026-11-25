// One HTTP-owning process, so the local launcher can stop its own server reliably.
const http = require('node:http')
const path = require('node:path')
if (process.env.SAMPLING_ENABLED !== 'true') throw Error('Use the Sampling local launcher')
// Tailwind resolves its project config from cwd, even when Next receives `dir`.
const webRoot = path.resolve(__dirname, '../apps/web')
process.chdir(webRoot)
const next = require('next')
const app = next({
  dev: true,
  hostname: '127.0.0.1',
  port: 3302,
  dir: webRoot,
})
app
  .prepare()
  .then(() => {
    const handle = app.getRequestHandler()
    const server = http.createServer((req, res) => handle(req, res))
    server.listen(3302, '127.0.0.1', () =>
      console.log('Sampling web: http://localhost:3302/sampling')
    )
    server.on('error', (e) => {
      console.error(e)
      process.exit(1)
    })
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
