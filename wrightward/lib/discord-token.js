// Resolves the Discord bot token from environment variables.
//
// Two acceptable sources:
//   - DISCORD_BOT_TOKEN (set via .mcp.json env from ${user_config.discord_bot_token})
//   - CLAUDE_PLUGIN_OPTION_DISCORD_BOT_TOKEN (auto-exported by Claude Code for
//     plugin userConfig values per the plugins reference; kept as a fallback
//     in case substitution fails)
//
// Returns null when neither is set or both are empty. Consumers decide whether
// that means "discord not configured" or "bridge cannot start".

'use strict';

function resolveBotToken(env) {
  const e = env || process.env;
  const primary = e.DISCORD_BOT_TOKEN;
  if (typeof primary === 'string' && primary.length > 0) return primary;
  const fallback = e.CLAUDE_PLUGIN_OPTION_DISCORD_BOT_TOKEN;
  if (typeof fallback === 'string' && fallback.length > 0) return fallback;
  return null;
}

module.exports = { resolveBotToken };
