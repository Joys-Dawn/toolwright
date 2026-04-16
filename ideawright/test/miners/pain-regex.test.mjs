import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasPainPhrase,
  matchPainPhrases,
  painPatternCount,
} from '../../lib/miners/pain-regex.mjs';

test('detects explicit "I wish there was" phrasings', () => {
  assert.ok(hasPainPhrase('I wish there was a tool to convert markdown to anki cards'));
  assert.ok(hasPainPhrase('I wish there were some way to dedupe my contacts across apps'));
  assert.ok(hasPainPhrase('i wish there was a way to search my old tweets offline'));
});

test('detects "why is there no / why isn\'t there" phrasings', () => {
  assert.ok(hasPainPhrase('why is there no app that tracks my daily water intake'));
  assert.ok(hasPainPhrase("why isn't there a tool for cross-platform clipboard sync"));
  assert.ok(hasPainPhrase('why hasnt anyone built a proper recipe manager yet'));
});

test('detects "someone should build / would pay for" phrasings', () => {
  assert.ok(hasPainPhrase('someone should build a CLI for X'));
  assert.ok(hasPainPhrase("I'd pay for a service that transcribes voice notes"));
  assert.ok(hasPainPhrase("I would happily pay for something that does this"));
});

test('detects frustration / gap phrasings', () => {
  assert.ok(hasPainPhrase('frustrated with every note-taking app out there'));
  assert.ok(hasPainPhrase("i hate that Notion is so slow on mobile"));
  assert.ok(hasPainPhrase("there's no good way to search my old tweets"));
  assert.ok(hasPainPhrase('every tool I tried for this is broken'));
  assert.ok(hasPainPhrase("can't find a decent library for unicode segmentation"));
});

test('ignores non-pain text', () => {
  assert.ok(!hasPainPhrase('The weather is nice today'));
  assert.ok(!hasPainPhrase('Here is how to use regex in JavaScript'));
  assert.ok(!hasPainPhrase(''));
  assert.ok(!hasPainPhrase(null));
  assert.ok(!hasPainPhrase(undefined));
});

test('matchPainPhrases returns pattern + match + excerpt', () => {
  const text =
    'Earlier today I wish there was a tool for cross-platform clipboard history ' +
    'that syncs over LAN only. Has this been built? Curious.';
  const matches = matchPainPhrases(text);
  assert.ok(matches.length >= 1);
  const first = matches[0];
  assert.ok(first.excerpt.includes('clipboard history'));
  assert.ok(first.match.toLowerCase().startsWith('i wish there was'));
  assert.ok(typeof first.pattern === 'string');
});

test('matchPainPhrases handles multiple matches in one post', () => {
  const text =
    "I wish there was an app for this, and honestly I'd pay for one too. " +
    'Frustrated that every tool I tried falls short.';
  const matches = matchPainPhrases(text);
  assert.ok(matches.length >= 2);
});

test('painPatternCount returns a positive number', () => {
  assert.ok(painPatternCount() > 10);
});
