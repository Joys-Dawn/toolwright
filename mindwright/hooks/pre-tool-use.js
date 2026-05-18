#!/usr/bin/env node
// PreToolUse hook — dependency-free shim; loads impl once deps are present.

import { runHookShim } from '../lib/hook-shim.js';

runHookShim('pre-tool-use', new URL('./pre-tool-use-impl.js', import.meta.url).href);
