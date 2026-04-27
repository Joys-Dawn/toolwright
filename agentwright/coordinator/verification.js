'use strict';

const { readJson, readJsonLines, writeJson } = require('./io');
const {
  validateRunId,
  validateStageName,
  stageFindingsQueueFile,
  stageDecisionsFile,
  stageMetaFile,
  stageVerifierFile,
  summaryFile
} = require('./paths');
const { loadRun, getCurrentGroup, withRunLock } = require('./run-ledger');
const { markDeadStageWorkers } = require('./health-check');
const { completeStage, nextStage } = require('./lifecycle');

const VALID_DECISIONS = new Set(['valid', 'invalid', 'valid_needs_approval']);

function getEmittedFindings(cwd, runId, stageName) {
  return readJsonLines(stageFindingsQueueFile(cwd, runId, stageName), [])
    .filter(event => event.type === 'finding' && typeof event.finding?.id === 'string');
}

function deriveCompletionResult(decisions) {
  if (decisions.length === 0) return 'accepted';
  if (decisions.some(d => d.decision === 'valid_needs_approval')) return 'approval';
  if (decisions.every(d => d.decision === 'invalid')) return 'rejected';
  return 'accepted';
}

function doneResult(cwd, runId) {
  return { status: 'done', runId, summary: readJson(summaryFile(cwd, runId), {}) };
}

async function tryAutoComplete(cwd, runId, stageName, decisions) {
  const meta = readJson(stageMetaFile(cwd, runId, stageName));
  if (!meta || !meta.auditDone) return { stageComplete: false };

  const emitted = getEmittedFindings(cwd, runId, stageName);
  const emittedIds = new Set(emitted.map(e => e.finding.id));
  const decidedIds = new Set(decisions.map(d => d.findingId));

  for (const id of emittedIds) {
    if (!decidedIds.has(id)) return { stageComplete: false };
  }

  const run = loadRun(cwd, runId);
  const stage = run.stages.find(s => s.name === stageName);
  if (!stage || stage.status !== 'awaiting_verification_completion') {
    return { stageComplete: false };
  }

  const result = deriveCompletionResult(decisions);
  const completion = completeStage(runId, stageName, result);

  let groupAdvanced = completion.groupCompleted || false;
  let pipelineComplete = false;
  let nextStages = null;

  const updatedRun = loadRun(cwd, runId);
  if (updatedRun.status === 'completed') {
    pipelineComplete = true;
  } else if (groupAdvanced) {
    const next = await nextStage(runId);
    if (next.activeStages) {
      nextStages = next.activeStages.map(s => s.currentStage);
    }
  }

  return { stageComplete: true, groupAdvanced, pipelineComplete, nextStages };
}

function pollStage(cwd, runId, stageName, stage) {
  const verifier = readJson(stageVerifierFile(cwd, runId, stageName), {
    processedFindingIds: []
  });
  const processedSet = new Set(verifier.processedFindingIds || []);
  const emitted = getEmittedFindings(cwd, runId, stageName);
  const meta = readJson(stageMetaFile(cwd, runId, stageName));

  const unprocessed = emitted.find(e => !processedSet.has(e.finding.id));
  if (unprocessed) {
    return {
      status: 'finding',
      runId,
      stage: stageName,
      finding: unprocessed.finding,
      progress: {
        processed: processedSet.size,
        total: emitted.length,
        auditDone: Boolean(meta && meta.auditDone)
      }
    };
  }

  if (!meta || !meta.auditDone) {
    return {
      status: 'waiting',
      runId,
      stage: stageName,
      progress: {
        processed: processedSet.size,
        total: emitted.length,
        auditDone: false
      }
    };
  }

  if (stage.status === 'audit_failed') {
    return {
      status: 'error',
      runId,
      stage: stageName,
      error: meta.error || 'Auditor failed',
      meta
    };
  }

  if (stage.status === 'awaiting_verification_completion') {
    const decisionsData = readJson(stageDecisionsFile(cwd, runId, stageName), { decisions: [] });
    const decidedIds = new Set(decisionsData.decisions.map(d => d.findingId));
    const allDecided = emitted.every(e => decidedIds.has(e.finding.id));
    if (allDecided) {
      return { status: 'ready_to_complete', stageName, decisionsData };
    }
  }

  // Transient state: worker wrote auditDone but hasn't updated stage status yet
  if (meta && meta.auditDone && stage.status === 'auditing') {
    return {
      status: 'waiting',
      runId,
      stage: stageName,
      progress: {
        processed: processedSet.size,
        total: emitted.length,
        auditDone: true
      }
    };
  }

  return null;
}

async function tryAdvanceGroup(cwd, runId) {
  const run = loadRun(cwd, runId);
  const group = getCurrentGroup(run);
  if (!group) return false;

  try {
    const next = await nextStage(runId);
    return next.status !== 'completed' && next.activeStages;
  } catch (err) {
    process.stderr.write(`Warning: failed to advance to next group: ${err.message}\n`);
    return false;
  }
}

// Must stay below the Bash timeout=600000 instructed in commands/audit-{run,step,resume}.md.
// 30s buffer covers a final pollOnce that hits a group transition (tryAdvanceGroup →
// launchCurrentGroup → createGroupSnapshot, which can copy a large workspace on non-git
// repos), plus stdout flush, before Bash sends SIGKILL.
const DEFAULT_WAIT_MS = 570000;
const POLL_INTERVAL_MS = 3000;

async function pollOnce(cwd, runId) {
  const failedAutoComplete = new Set();

  while (true) {
    let run = loadRun(cwd, runId);
    markDeadStageWorkers(cwd, run);
    run = loadRun(cwd, runId);

    if (run.status === 'completed') return doneResult(cwd, runId);

    const currentGroup = getCurrentGroup(run);
    if (!currentGroup) return doneResult(cwd, runId);

    for (const stageName of currentGroup.stages) {
      const stage = run.stages.find(s => s.name === stageName);
      if (!stage || stage.status === 'completed') continue;

      const poll = pollStage(cwd, runId, stageName, stage);
      if (!poll) continue;

      if (poll.status === 'ready_to_complete') {
        if (failedAutoComplete.has(poll.stageName)) continue;
        try {
          const result = deriveCompletionResult(poll.decisionsData.decisions);
          completeStage(runId, poll.stageName, result);
          run = loadRun(cwd, runId);
          continue;
        } catch (err) {
          failedAutoComplete.add(poll.stageName);
          process.stderr.write(`Warning: auto-complete failed for stage ${poll.stageName}: ${err.message}\n`);
        }
        continue;
      }

      return poll;
    }

    run = loadRun(cwd, runId);
    if (run.status === 'completed') return doneResult(cwd, runId);

    if (await tryAdvanceGroup(cwd, runId)) {
      continue;
    }

    return doneResult(cwd, runId);
  }
}

async function nextFinding(runId, opts = {}) {
  const cwd = process.cwd();
  validateRunId(runId);

  const wait = opts.wait === true || (typeof opts.wait === 'number' && opts.wait > 0);
  if (!wait) {
    return pollOnce(cwd, runId);
  }

  const maxWaitMs = typeof opts.wait === 'number' && opts.wait > 0 ? opts.wait : DEFAULT_WAIT_MS;
  const pollIntervalMs = typeof opts.pollIntervalMs === 'number' && opts.pollIntervalMs > 0
    ? opts.pollIntervalMs
    : POLL_INTERVAL_MS;
  const startedAt = performance.now();

  while (true) {
    const result = await pollOnce(cwd, runId);
    if (result.status !== 'waiting') return result;
    const remaining = maxWaitMs - (performance.now() - startedAt);
    if (remaining <= 0) return result;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
}

function requireFlag(flags, name) {
  if (!flags[name]) {
    throw new Error(`Missing required flag: --${name}`);
  }
  return flags[name];
}

async function recordDecision(runId, stageName, findingId, opts) {
  const cwd = process.cwd();
  validateRunId(runId);
  validateStageName(stageName);

  if (!findingId || typeof findingId !== 'string') {
    throw new Error('findingId must be a non-empty string.');
  }
  if (!VALID_DECISIONS.has(opts.decision)) {
    throw new Error(`Invalid decision: ${opts.decision}. Must be one of: ${[...VALID_DECISIONS].join(', ')}`);
  }

  const decisionsPath = stageDecisionsFile(cwd, runId, stageName);
  const verifierPath = stageVerifierFile(cwd, runId, stageName);

  let decisionsData;
  withRunLock(cwd, runId, () => {
    decisionsData = readJson(decisionsPath, { stage: stageName, decisions: [] });
    if (decisionsData.decisions.some(d => d.findingId === findingId)) {
      throw new Error(`Duplicate decision: findingId ${findingId} already recorded.`);
    }

    const matchingFinding = getEmittedFindings(cwd, runId, stageName)
      .find(event => event.finding.id === findingId);
    const findingAuditType = matchingFinding?.finding?.auditType;

    const decisionRecord = {
      findingId,
      decision: opts.decision,
      action: opts.action || 'none',
      rationale: opts.rationale || '',
      filesChanged: opts.filesChanged || [],
      verificationEvidence: opts.evidence || ''
    };
    if (typeof findingAuditType === 'string' && findingAuditType.length > 0) {
      decisionRecord.auditType = findingAuditType;
    }
    decisionsData.decisions.push(decisionRecord);
    writeJson(decisionsPath, decisionsData);

    const verifier = readJson(verifierPath, {
      stage: stageName,
      lastConsumedIndex: 0,
      processedFindingIds: [],
      fixedCount: 0,
      invalidCount: 0,
      deferredCount: 0,
      updatedAt: new Date().toISOString()
    });

    verifier.processedFindingIds.push(findingId);
    verifier.lastConsumedIndex = verifier.processedFindingIds.length;

    if (opts.decision === 'valid' && opts.action === 'fixed') {
      verifier.fixedCount = (verifier.fixedCount || 0) + 1;
    } else if (opts.decision === 'invalid') {
      verifier.invalidCount = (verifier.invalidCount || 0) + 1;
    } else if (opts.decision === 'valid_needs_approval') {
      verifier.deferredCount = (verifier.deferredCount || 0) + 1;
    }

    verifier.updatedAt = new Date().toISOString();
    writeJson(verifierPath, verifier);
  });

  let auto;
  try {
    auto = await tryAutoComplete(cwd, runId, stageName, decisionsData.decisions);
  } catch (err) {
    process.stderr.write(`Warning: auto-complete failed after recording decision: ${err.message}\n`);
    auto = { stageComplete: false };
  }

  return {
    ok: true,
    runId,
    stage: stageName,
    findingId,
    decision: opts.decision,
    stageComplete: auto.stageComplete,
    groupAdvanced: auto.groupAdvanced || false,
    pipelineComplete: auto.pipelineComplete || false,
    nextStages: auto.nextStages || null
  };
}

module.exports = {
  nextFinding,
  recordDecision,
  requireFlag
};
