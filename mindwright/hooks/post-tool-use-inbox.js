#!/usr/bin/env node
// PostToolUse(inbox) hook — dependency-free shim; loads impl once deps are present.

import { runHookShim } from '../lib/hook-shim.js';

runHookShim('post-tool-use-inbox', new URL('./post-tool-use-inbox-impl.js', import.meta.url).href);
