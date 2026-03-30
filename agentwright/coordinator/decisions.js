'use strict';

const { readJson, readJsonLines, writeJson } = require('./io');
const { stageFindingsQueueFile, summaryFile } = require('./paths');

function validateDecisions(cwd, runId, stageName, decisions) {
  const emittedFindingIds = readJsonLines(stageFindingsQueueFile(cwd, runId, stageName), [])
    .filter(event => event.type === 'finding' && typeof event.finding?.id === 'string')
    .map(event => event.finding.id);
  const emittedSet = new Set(emittedFindingIds);
  const decisionIds = decisions.decisions
    .map(decision => decision.findingId)
    .filter(id => typeof id === 'string');
  const seenDecisionIds = new Set();
  const duplicateDecisionIds = [];
  for (const findingId of decisionIds) {
    if (seenDecisionIds.has(findingId)) {
      duplicateDecisionIds.push(findingId);
      continue;
    }
    seenDecisionIds.add(findingId);
  }
  const missingDecisionIds = emittedFindingIds.filter(findingId => !seenDecisionIds.has(findingId));
  const unexpectedDecisionIds = [...seenDecisionIds].filter(findingId => !emittedSet.has(findingId));
  if (duplicateDecisionIds.length > 0 || missingDecisionIds.length > 0 || unexpectedDecisionIds.length > 0) {
    throw new Error(
      `Stage ${stageName} decisions do not match emitted findings. ` +
      `Missing: ${missingDecisionIds.length}, duplicate: ${duplicateDecisionIds.length}, unexpected: ${unexpectedDecisionIds.length}.`
    );
  }
}

function updateSummary(cwd, runId, stageName, decisions, completionResult, scope) {
  const summary = readJson(summaryFile(cwd, runId), {
    runId,
    scope,
    completedStages: [],
    rejectedFindings: [],
    pendingApprovals: []
  });
  summary.completedStages.push({
    name: stageName,
    result: completionResult,
    counts: {
      valid: decisions.decisions.filter(d => d.decision === 'valid').length,
      invalid: decisions.decisions.filter(d => d.decision === 'invalid').length,
      approval: decisions.decisions.filter(d => d.decision === 'valid_needs_approval').length
    }
  });
  summary.rejectedFindings.push(
    ...decisions.decisions
      .filter(d => d.decision === 'invalid')
      .map(d => ({
        stage: stageName,
        findingId: d.findingId,
        rationale: d.rationale || ''
      }))
  );
  summary.pendingApprovals.push(
    ...decisions.decisions
      .filter(d => d.decision === 'valid_needs_approval')
      .map(d => ({
        stage: stageName,
        findingId: d.findingId,
        rationale: d.rationale || ''
      }))
  );
  writeJson(summaryFile(cwd, runId), summary);
}

module.exports = {
  validateDecisions,
  updateSummary
};
