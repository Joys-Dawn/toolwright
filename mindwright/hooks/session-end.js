#!/usr/bin/env node
// SessionEnd hook — dependency-free shim.
//
// Real logic is in hooks/session-end-impl.js; it statically imports native-dep
// modules (store.js → better-sqlite3) and is loaded via dynamic import ONLY
// after lib/hook-shim.js confirms deps are installed. A deps-less plugin copy
// stays dormant here (and self-heals via a background npm install) instead of
// crashing at ESM load. See lib/hook-shim.js for the full rationale.

import { runHookShim } from '../lib/hook-shim.js';

runHookShim('session-end', new URL('./session-end-impl.js', import.meta.url).href);
