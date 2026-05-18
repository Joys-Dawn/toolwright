#!/usr/bin/env node
// Stop hook — dependency-free shim; loads stop-impl.js once deps are present.

import { runHookShim } from '../lib/hook-shim.js';

runHookShim('stop', new URL('./stop-impl.js', import.meta.url).href);
