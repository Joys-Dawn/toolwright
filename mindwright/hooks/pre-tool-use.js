#!/usr/bin/env node
// PreToolUse hook — dependency-free shim.
//
// Real logic is in hooks/pre-tool-use-impl.js, loaded via dynamic import
// ONLY after lib/hook-shim.js confirms the native deps are installed. A
// deps-less plugin copy stays dormant (and self-heals via a background
// npm install) instead of crashing at ESM load. See lib/hook-shim.js.

import { runHookShim } from '../lib/hook-shim.js';

runHookShim('pre-tool-use', new URL('./pre-tool-use-impl.js', import.meta.url).href);
