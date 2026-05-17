#!/usr/bin/env node
// UserPromptSubmit hook — dependency-free shim.
//
// Real logic is in hooks/user-prompt-submit-impl.js, loaded via dynamic
// import ONLY after lib/hook-shim.js confirms the native deps are installed.
// A deps-less plugin copy stays dormant (and self-heals via a background
// npm install) instead of crashing at ESM load. See lib/hook-shim.js.

import { runHookShim } from '../lib/hook-shim.js';

runHookShim('user-prompt-submit', new URL('./user-prompt-submit-impl.js', import.meta.url).href);
