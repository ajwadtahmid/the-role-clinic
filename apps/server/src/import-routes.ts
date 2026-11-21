import type { Hono } from 'hono'
import type Database from 'better-sqlite3'
import { applyImport, guessMapping, planImport, readTables, recentImports, undoImport, fields, type DateOrder, type ImportFormat, type Mapping } from './import.js'

interface Body { format?: unknown; content?: unknown; sheet?: unknown; mapping?: unknown; statusMap?: unknown; dateOrder?: unknown; includeDuplicates?: unknown }

// Reads the request into a plan. Preview and apply share this, so what is shown is exactly what would be imported.
async function planFrom(sqlite: Database.Database, body: Body) {
  if (!['csv', 'xlsx', 'paste'].includes(body.format as string) || typeof body.content !== 'string' || !body.content) throw new Error('Choose a file or paste some cells first.')
  const tables = await readTables(body.format as ImportFormat, body.content)
  const table = tables.find((item) => item.name === body.sheet) ?? tables[0]
  const [headers, ...dataRows] = table.rows, rowNumbers = table.numbers.slice(1)
  if (!dataRows.length) throw new Error('The first row is read as headings, and there are no rows under it.')
  let mapping: Mapping = guessMapping(headers)
  if (body.mapping && typeof body.mapping === 'object') {
    mapping = {}
    for (const field of fields) { const index = (body.mapping as Record<string, unknown>)[field]; if (Number.isInteger(index) && (index as number) >= 0 && (index as number) < headers.length) mapping[field] = index as number }
  }
  const statusMap = body.statusMap && typeof body.statusMap === 'object' ? Object.fromEntries(Object.entries(body.statusMap as Record<string, unknown>).filter(([, value]) => typeof value === 'string')) as Record<string, string> : undefined
  const dateOrder: DateOrder = body.dateOrder === 'dmy' ? 'dmy' : 'mdy'
  const plan = planImport(sqlite, dataRows, { mapping, rowNumbers, statusMap, dateOrder })
  return { plan, tables, table, headers, mapping, dateOrder }
}

export function registerImportRoutes(app: Hono, sqlite: Database.Database) {
  // Nothing is saved here: it reads the file, matches the columns and reports what each row would become.
  app.post('/api/import/preview', async (context) => {
    try {
      const { plan, tables, table, headers, mapping, dateOrder } = await planFrom(sqlite, await context.req.json().catch(() => ({})) as Body)
      const missing = (['company', 'title'] as const).filter((field) => mapping[field] === undefined)
      return context.json({ sheets: tables.map((item) => item.name), sheet: table.name, headers, mapping, dateOrder, missing, counts: plan.counts, statusWords: plan.statusWords, ambiguousDates: plan.ambiguousDates, rows: plan.rows.slice(0, 100), recent: recentImports(sqlite) })
    } catch (error) { return context.json({ error: (error as Error).message }, 400) }
  })
  app.post('/api/import/apply', async (context) => {
    try {
      const body = await context.req.json().catch(() => ({})) as Body
      const { plan, mapping } = await planFrom(sqlite, body)
      if (mapping.company === undefined || mapping.title === undefined) return context.json({ error: 'Match the Company and Role columns first.' }, 400)
      return context.json(applyImport(sqlite, plan, body.includeDuplicates === true), 201)
    } catch (error) { return context.json({ error: (error as Error).message }, 400) }
  })
  app.get('/api/imports', (context) => context.json({ imports: recentImports(sqlite) }))
  app.post('/api/import/:batch/undo', (context) => {
    try { return context.json(undoImport(sqlite, context.req.param('batch'))) } catch (error) { return context.json({ error: (error as Error).message }, 409) }
  })
}
