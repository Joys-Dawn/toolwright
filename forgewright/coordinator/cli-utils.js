'use strict';

// NOTE: Each toolwright plugin implements its own CLI primitives independently.
// This is intentional — plugins are designed to be installed and distributed
// separately, so they must not share runtime code. Duplication is acceptable.

/**
 * Parses CLI flags and positional arguments from argv.
 * Flags are --key or --key value pairs. Positional args are everything else.
 * @param {string[]} argv
 * @returns {{ flags: Record<string, string|true>, positional: string[] }}
 */
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(item);
    }
  }
  return { flags, positional };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true) {
    throw new Error(`Missing required flag: --${name}`);
  }
  return value;
}

module.exports = { parseFlags, requireFlag };
