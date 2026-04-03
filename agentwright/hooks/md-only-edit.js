#!/usr/bin/env node

// Hook: blocks Edit/Write calls targeting non-.md files.
// Scoped to the update-docs agent via its frontmatter hooks field.

const fs = require("fs");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const filePath = input.tool_input?.file_path || "";

if (!filePath.endsWith(".md")) {
  process.stderr.write(`update-docs agent can only edit .md files (attempted: ${filePath})`);
  process.exit(2);
}
