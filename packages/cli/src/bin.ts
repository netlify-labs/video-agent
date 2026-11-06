#!/usr/bin/env node
import { main, nodeIo } from './index.js'

process.exitCode = await main(process.argv.slice(2), nodeIo())
