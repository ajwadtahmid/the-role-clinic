import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { createDatabase } from './db.js'
import { getDataDirectory } from './data-dir.js'

const port = Number.parseInt(process.env.PORT ?? '3000', 10)
const webPort = Number.parseInt(process.env.WEB_PORT ?? '5173', 10)
const dataDirectory = getDataDirectory()
const { sqlite, db } = createDatabase(dataDirectory)
const app = createApp({ dataDirectory, sqlite, db, port, webPort })
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
  console.log(`The Role Clinic API listening at http://127.0.0.1:${info.port}`)
  console.log(`Local data directory: ${dataDirectory}`)
})

function shutdown() {
  server.close(() => {
    sqlite.close()
    process.exit(0)
  })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
