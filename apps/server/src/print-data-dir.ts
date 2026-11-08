import { resolve } from 'node:path'
import { getDataDirectory } from './data-dir.js'

// Prints the data folder this computer's app uses, so a search tool can find it without knowing the OS.
console.log(resolve(getDataDirectory()))
