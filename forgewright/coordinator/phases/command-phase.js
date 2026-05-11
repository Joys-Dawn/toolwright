'use strict';

const fs = require('fs');
const path = require('path');
const { artifactsDir, workflowDir } = require('../paths');
const { validateCommandResult } = require('../wrightward-contract');
const { parseProduces, consumesStems } = require('../artifacts');

const TYPE = 'command';
const TEST_CMD_PLACEHOLDER = '${TEST_CMD}';
const ARTIFACTS_PLACEHOLDER = '${ARTIFACTS}';
// ${ARTIFACT.<stem>} — resolves to a project-relative path for the registered
// artifact named <stem>. Stem characters mirror parseProduces' allowed map keys
// (alnum + . _ -); the leading-dot/trailing-dot edge cases of artifact stems
// (e.g. ".hidden") are accepted here because parseProduces lets them through.
const ARTIFACT_PLACEHOLDER_PATTERN = /\$\{ARTIFACT\.([A-Za-z0-9._-]+)\}/g;


function loadConfiguredTestCommand(workflow) {
  if (workflow && workflow.tests && typeof workflow.tests.command === 'string' && workflow.tests.command.length > 0) {
    return workflow.tests.command;
  }
  return null;
}

function appendCustomInstruction(lines, customInstruction) {
  if (!customInstruction) return lines;
  return [
    ...lines,
    ``,
    `Phase-specific instruction (overlay on the above — interpret the command's output and report accordingly):`,
    `  ${customInstruction}`,
    ``,
    `If the phase-specific instruction implies a structured decision (accept/reject/escalate, metric comparisons, etc.), put the decision and any relevant numbers into the mcpResult \`summary\` field as a short JSON blob or a clear sentence. Downstream phases and end-of-workflow re-audit can read it from \`phase.lastMcpResult\`.`,
  ];
}

function appendConsumesInstruction(lines, consumedArtifacts) {
  if (!consumedArtifacts || consumedArtifacts.length === 0) return lines;
  const list = consumedArtifacts.map(c => `  - \${ARTIFACT.${c.stem}} → ${c.path}`).join('\n');
  return [
    ...lines,
    ``,
    `This phase consumes ${consumedArtifacts.length} upstream artifact${consumedArtifacts.length === 1 ? '' : 's'} (already validated to exist on disk). The command above has \${ARTIFACT.<stem>} placeholders already substituted to project-relative paths:`,
    list,
  ];
}

function appendProducesInstruction(lines, parsedProduces, resolvedPaths) {
  if (!parsedProduces) return lines;
  if (parsedProduces.kind === 'multi') {
    const list = resolvedPaths.map(p => `  - ${p.stem} → ${p.path}`).join('\n');
    return [
      ...lines,
      ``,
      `This phase produces ${resolvedPaths.length} artifacts. The script must write each file to the path shown — forgewright auto-registers them on advance (no --artifact-path needed):`,
      list,
    ];
  }
  // Single produces.
  const entry = parsedProduces.entries[0];
  if (entry.hasExtension && resolvedPaths.length === 1) {
    return [
      ...lines,
      ``,
      `This phase produces the "${entry.stem}" artifact. The script must write it to "${resolvedPaths[0].path}" — forgewright auto-registers it on advance, no --artifact-path needed.`,
    ];
  }
  return [
    ...lines,
    ``,
    `This phase produces the "${entry.stem}" artifact. Pick a path under \${ARTIFACTS} (already resolved above), write the file there, and register it on advance:`,
    `  workflow-advance ... --artifact-path <path-you-wrote>`,
  ];
}

/**
 * Resolves a registered artifact stem to a project-relative path. Throws with
 * a phase-scoped message when the stem isn't registered or the recorded file
 * is missing on disk — those are upstream contract breaks (producing phase
 * crashed, file deleted, name drift) and must surface loudly, not be silently
 * substituted with an invalid path.
 */
function resolveArtifactByStem(cwd, workflow, stem, phaseIndex) {
  const rel = workflow && workflow.artifacts ? workflow.artifacts[stem] : null;
  if (!rel) {
    throw new Error(
      `Command phase ${phaseIndex}: artifact "${stem}" was never recorded by an upstream phase.`
    );
  }
  const wfDir = workflowDir(cwd, workflow.workflowId);
  const abs = path.isAbsolute(rel) ? rel : path.join(wfDir, rel);
  if (!fs.existsSync(abs)) {
    throw new Error(
      `Command phase ${phaseIndex}: artifact "${stem}" recorded at ${rel} but the file is missing on disk.`
    );
  }
  return path.relative(cwd, abs).split(path.sep).join('/');
}

function resolveConsumedArtifacts(cwd, workflow, phase) {
  // consumesStems normalizes "plan", "plan.md", and ["plan", "metrics.json"]
  // all to the stem array the artifact registry expects. The throw path is
  // tagged with the phase index so config / descriptor-build errors are easy
  // to trace back to a specific workflow position.
  let stems;
  try {
    stems = consumesStems(phase.consumes);
  } catch (err) {
    throw new Error(`Command phase ${phase.index}: ${err.message}`);
  }
  return stems.map(stem => ({ stem, path: resolveArtifactByStem(cwd, workflow, stem, phase.index) }));
}

/**
 * Substitutes ${ARTIFACTS} (the workflow's artifacts dir) and ${ARTIFACT.<stem>}
 * (per-artifact registered paths) inside the command string. The script writes
 * its output files at the names declared in `produces` — forgewright registers
 * them by stem on advance.
 *
 * Paths are project-relative (relative to cwd) — forgewright runs commands at
 * the project root, so relative paths are shorter, more readable, and avoid
 * leaking absolute paths into git-tracked workflow.json snapshots.
 *
 * ${ARTIFACT.<stem>} substitution: any reference to an unregistered stem
 * throws with the phase index — this catches typos and missing upstream
 * phases at descriptor-build time, before the command runs.
 */
function substitutePlaceholders(command, cwd, workflow, phaseIndex) {
  const artifactsAbs = artifactsDir(cwd, workflow.workflowId);
  const artifactsRel = path.relative(cwd, artifactsAbs).split(path.sep).join('/');
  let out = command;
  if (out.includes(ARTIFACTS_PLACEHOLDER)) {
    out = out.split(ARTIFACTS_PLACEHOLDER).join(artifactsRel);
  }
  // String.replace on a /g regex is safe regardless of the regex's lastIndex
  // — it doesn't read it (unlike .test/.exec). No-match returns the string
  // unchanged, so the previous .test() guard was only a redundant fast-path
  // and introduced the lastIndex foot-gun.
  out = out.replace(ARTIFACT_PLACEHOLDER_PATTERN, (_, stem) =>
    resolveArtifactByStem(cwd, workflow, stem, phaseIndex)
  );
  return out;
}

/**
 * Returns the resolved (project-relative) path for each entry in produces
 * that has an explicit filename. Multi-output: one entry per map key.
 * Single-bare (no extension): empty array — the script picks the path.
 */
function resolveArtifactPaths(cwd, workflowId, parsedProduces) {
  if (!parsedProduces) return [];
  const artifactsAbs = artifactsDir(cwd, workflowId);
  const artifactsRel = path.relative(cwd, artifactsAbs).split(path.sep).join('/');
  return parsedProduces.entries
    .filter(e => e.hasExtension)
    .map(e => ({ stem: e.stem, filename: e.filename, path: `${artifactsRel}/${e.filename}` }));
}

function buildPlaceholderInstruction(workflowId, customInstruction, parsedProduces, resolvedPaths, consumedArtifacts) {
  const lines = [
    `No explicit command was supplied for this phase, and "tests.command" is unset in .claude/forgewright.json.`,
    `Inspect the project to determine the right test command. Priority order:`,
    `  1. The local "run-tests" skill if present (\`/run-tests\` or via Skill tool).`,
    `  2. package.json scripts ("test", "test:unit", etc).`,
    `  3. pytest.ini / pyproject.toml / setup.cfg (Python).`,
    `  4. Cargo.toml (Rust: \`cargo test\`).`,
    `  5. go.mod (Go: \`go test ./...\`).`,
    `  6. Makefile (look for "test" target).`,
    `  7. CI config (.github/workflows/, .gitlab-ci.yml).`,
    `  8. README testing section.`,
    `Run the chosen command, capture exit code and any failure summary, then report:`,
    `  workflow-advance --workflow ${workflowId} --result completed \\`,
    `    --mcp-result '{"command":"<cmd>","exitCode":<n>,"summary":"..."}'`,
    `If you cannot determine a command, set "tests.command" in .claude/forgewright.json and re-run, or report --result failed.`,
  ];
  let next = appendCustomInstruction(lines, customInstruction);
  next = appendConsumesInstruction(next, consumedArtifacts);
  next = appendProducesInstruction(next, parsedProduces, resolvedPaths);
  return next.join('\n');
}

function buildExplicitInstruction(command, workflowId, customInstruction, parsedProduces, resolvedPaths, consumedArtifacts) {
  const lines = [
    `Run the command: \`${command}\``,
    `Capture exit code and any failure summary. Report back:`,
    `  workflow-advance --workflow ${workflowId} --result completed \\`,
    `    --mcp-result '{"command":"${command}","exitCode":<n>,"summary":"..."}'`,
    `Use --result failed if the command fails AND the failure is not surface-level test output the user should review.`,
  ];
  let next = appendCustomInstruction(lines, customInstruction);
  next = appendConsumesInstruction(next, consumedArtifacts);
  next = appendProducesInstruction(next, parsedProduces, resolvedPaths);
  return next.join('\n');
}

/**
 * Resolves the command string for a phase: validates it's a non-empty string,
 * and substitutes ${TEST_CMD} from `workflow.tests.command` when configured.
 * When the phase references ${TEST_CMD} but no command is configured, returns
 * the placeholder unchanged and flags `isPlaceholder=true` so buildDescriptor
 * can emit the discovery-instruction branch.
 */
function resolveCommand(phase, workflow) {
  if (typeof phase.command !== 'string' || phase.command.length === 0) {
    throw new Error(`Command phase ${phase.index} requires a "command" string.`);
  }
  if (phase.command !== TEST_CMD_PLACEHOLDER) {
    return { command: phase.command, isPlaceholder: false };
  }
  const configured = loadConfiguredTestCommand(workflow);
  if (configured) return { command: configured, isPlaceholder: false };
  return { command: TEST_CMD_PLACEHOLDER, isPlaceholder: true };
}

function buildDescriptor(phase, workflow, { cwd }) {
  let { command, isPlaceholder } = resolveCommand(phase, workflow);

  const customInstruction = typeof phase.instruction === 'string' && phase.instruction.trim().length > 0
    ? phase.instruction.trim()
    : null;

  const parsedProduces = phase.produces ? parseProduces(phase.produces) : null;
  const resolvedPaths = resolveArtifactPaths(cwd, workflow.workflowId, parsedProduces);

  // Resolve consumed artifacts (validates registration + on-disk existence)
  // BEFORE substituting placeholders — same upstream-contract semantics as
  // handoff-phase. Either the listed consumes OR a ${ARTIFACT.<stem>} token in
  // the command will fail loudly if the stem is unknown / file is missing.
  const consumedArtifacts = resolveConsumedArtifacts(cwd, workflow, phase);

  // Substitute ${ARTIFACTS} and ${ARTIFACT.<stem>} in the command (skip for
  // the test-command placeholder branch — that gets resolved by the leader
  // picking a real test command).
  if (!isPlaceholder) {
    command = substitutePlaceholders(command, cwd, workflow, phase.index);
  }

  // Descriptor surface:
  //   - produces: array of {stem, filename, path} for explicit entries
  //     (empty for bare-name produces or absent produces).
  //   - consumes: array of {stem, path} project-relative; empty when absent.
  //   - Single-output back-compat: artifactPath = first entry's path or null.
  const artifactPath = resolvedPaths.length === 1 ? resolvedPaths[0].path : null;

  return {
    kind: 'phase',
    type: TYPE,
    command,
    isPlaceholder,
    produces: resolvedPaths,
    consumes: consumedArtifacts,
    artifactPath,
    workflowId: workflow.workflowId,
    phaseIndex: phase.index,
    phaseName: phase.name,
    instruction: isPlaceholder
      ? buildPlaceholderInstruction(workflow.workflowId, customInstruction, parsedProduces, resolvedPaths, consumedArtifacts)
      : buildExplicitInstruction(command, workflow.workflowId, customInstruction, parsedProduces, resolvedPaths, consumedArtifacts),
  };
}

function validateResult(result, phase) {
  // advanceWorkflow always passes { artifactPath, mcpResult } — that is the
  // single handler contract. The LLM's command result rides under .mcpResult.
  if (!result || typeof result !== 'object') {
    throw new Error('Command phase result must be an object.');
  }
  validateCommandResult(result.mcpResult);
  // Mirror skill-phase: --artifact-path is only required for bare-form
  // produces (`"metrics"` — no extension), where the command picks the
  // filename at write time. Extension-form ("metrics.json") and multi-form
  // ({stem: filename}) are auto-registered from the produces config by
  // workflow-lifecycle.js, so no leader-supplied path is needed.
  if (phase && phase.produces && !result.artifactPath) {
    const parsed = parseProduces(phase.produces);
    const requiresPath = parsed && parsed.kind === 'single' && !parsed.entries[0].hasExtension;
    if (requiresPath) {
      throw new Error(
        `Command phase ${phase.index} declares produces:"${phase.produces}" — ` +
        `--artifact-path is required (bare-form produces; the command picks the filename).`
      );
    }
  }
  return true;
}

module.exports = {
  TYPE,
  TEST_CMD_PLACEHOLDER,
  ARTIFACTS_PLACEHOLDER,
  buildDescriptor,
  validateResult,
  resolveCommand,
  loadConfiguredTestCommand,
  buildPlaceholderInstruction,
  buildExplicitInstruction,
  substitutePlaceholders,
  resolveArtifactPaths,
  resolveArtifactByStem,
  resolveConsumedArtifacts,
};
