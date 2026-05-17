#!/usr/bin/env node
// SessionEnd hook — dependency-free shim; loads impl once deps are present.

import { runHookShim } from '../lib/hook-shim.js';

runHookShim('session-end', new URL('./session-end-impl.js', import.meta.url).href);
