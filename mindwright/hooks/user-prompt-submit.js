#!/usr/bin/env node
// UserPromptSubmit hook — dependency-free shim; loads impl once deps are present.

import { runHookShim } from '../lib/hook-shim.js';

runHookShim('user-prompt-submit', new URL('./user-prompt-submit-impl.js', import.meta.url).href);
