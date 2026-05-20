#!/usr/bin/env node
// PreCompact hook — dependency-free shim; loads impl once deps are present.

import { runHookShim } from '../lib/hook-shim.js';

runHookShim('pre-compact', new URL('./pre-compact-impl.js', import.meta.url).href);
