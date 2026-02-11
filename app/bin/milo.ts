#!/usr/bin/env node

import { program } from '../cli';

// Default to 'start' when no command is given
const args = process.argv.length <= 2 ? [...process.argv, 'start'] : process.argv;
program.parse(args);
