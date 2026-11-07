import { startServer } from './server.js'
try { await startServer() }
catch (error) { console.error(`The Role Clinic could not start: ${(error as Error).message}`); process.exitCode = 1 }
