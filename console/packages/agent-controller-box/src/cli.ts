#!/usr/bin/env node
import { main } from './main';

process.exitCode = await main(process.argv.slice(2));
