/**
 * Pure checks for AI review JSON parsing. No network, no DB connection: the env
 * values only satisfy config's import-time validation.
 */
import assert from 'node:assert/strict';
import { parseReviewAssessment, parseSignalEvaluation } from '../src/ai/assist.js';

const fenced = `
\`\`\`json
{
  "summary": "The submission includes a demo link and short notes.",
  "requirementChecks": [
    {"requirement": "Demo link", "status": "met", "evidence": "A URL is present."},
    {"requirement": "Setup steps", "status": "unclear", "evidence": null}
  ],
  "missingItems": ["Acceptance screenshots"],
  "risks": ["The repo branch is not named."],
  "questions": ["Which branch should be reviewed?"],
  "confidence": 0.82
}
\`\`\`
extra prose with a brace } after the object
`;

const parsed = parseReviewAssessment(fenced);
assert.ok(parsed, 'fenced JSON with trailing prose parses');
assert.equal(parsed.summary, 'The submission includes a demo link and short notes.');
assert.equal(parsed.requirementChecks.length, 2);
assert.equal(parsed.requirementChecks[0].status, 'met');
assert.equal(parsed.missingItems[0], 'Acceptance screenshots');
assert.equal(parsed.confidence, 0.82);

assert.equal(parseReviewAssessment('not json'), null, 'plain prose is rejected');
assert.equal(
  parseReviewAssessment('{"summary":"x","requirementChecks":[{"requirement":"r","status":"done"}],"confidence":2}')!
    .requirementChecks.length,
  0,
  'invalid requirement status is dropped',
);

const signal = parseSignalEvaluation(`
Here is the object:
{
  "score": 12,
  "shouldDraft": true,
  "title": "Produce a launch demo",
  "description": "Create a short demo for the launch.",
  "requiredOutput": "- 30s video\\n- Source link",
  "deadline": "before Friday",
  "maxAssignees": 99,
  "reason": "The message asks for a concrete launch deliverable.",
  "confidence": 1.4
}
`);
assert.ok(signal, 'signal JSON with prose parses');
assert.equal(signal.score, 10, 'signal score is clamped');
assert.equal(signal.maxAssignees, 20, 'signal maxAssignees is clamped');
assert.equal(signal.confidence, 1, 'signal confidence is clamped');
assert.equal(signal.shouldDraft, true);
assert.equal(signal.reason, 'The message asks for a concrete launch deliverable.');
assert.equal(parseSignalEvaluation('{"score":"high","shouldDraft":true}'), null, 'non-numeric signal score rejected');

console.log('AI parser checks OK');
