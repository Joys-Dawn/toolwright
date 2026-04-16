import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAtomFeed, detectCodeUrl } from '../../lib/miners/arxiv.mjs';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.12345v1</id>
    <updated>2026-04-10T00:00:00Z</updated>
    <published>2026-04-08T00:00:00Z</published>
    <title>A Novel Framework for Streaming Graph Analytics</title>
    <summary>We present a new algorithm for streaming graph analytics.
Code is available at https://github.com/acme/streamgraph and achieves 3x
speedup over prior work. Applications include fraud detection.</summary>
    <author><name>Alice Smith</name></author>
    <author><name>Bob Jones</name></author>
    <link href="http://arxiv.org/abs/2401.12345v1" rel="alternate"/>
    <link href="http://arxiv.org/pdf/2401.12345v1" rel="related"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.DB" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.DB" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.DS" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.99999v1</id>
    <updated>2026-04-09T00:00:00Z</updated>
    <published>2026-04-05T00:00:00Z</published>
    <title>Pure Theory Paper With No Code</title>
    <summary>We prove a theoretical bound on something.</summary>
    <author><name>Solo Theorist</name></author>
    <link href="http://arxiv.org/abs/2401.99999v1" rel="alternate"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="math.CO" scheme="http://arxiv.org/schemas/atom"/>
    <category term="math.CO" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

test('parseAtomFeed extracts entries with metadata', () => {
  const entries = parseAtomFeed(FIXTURE);
  assert.equal(entries.length, 2);
  const e = entries[0];
  assert.equal(e.arxivId, '2401.12345v1');
  assert.match(e.title, /Streaming Graph Analytics/);
  assert.match(e.summary, /streaming graph analytics/i);
  assert.equal(e.authors.length, 2);
  assert.equal(e.authors[0], 'Alice Smith');
  assert.equal(e.primaryCategory, 'cs.DB');
  assert.ok(e.categories.includes('cs.DS'));
  assert.ok(e.published.startsWith('2026-04-08'));
});

test('parseAtomFeed detects GitHub code_url from abstract', () => {
  const entries = parseAtomFeed(FIXTURE);
  assert.equal(entries[0].codeUrl, 'https://github.com/acme/streamgraph');
});

test('parseAtomFeed leaves codeUrl null when none is present', () => {
  const entries = parseAtomFeed(FIXTURE);
  assert.equal(entries[1].codeUrl, null);
});

test('detectCodeUrl finds github / huggingface / gitlab in text', () => {
  assert.equal(
    detectCodeUrl('See https://github.com/foo/bar for details.'),
    'https://github.com/foo/bar',
  );
  assert.equal(
    detectCodeUrl('Model at https://huggingface.co/org/model-name'),
    'https://huggingface.co/org/model-name',
  );
  assert.equal(
    detectCodeUrl('Hosted at https://gitlab.com/team/repo.'),
    'https://gitlab.com/team/repo',
  );
});

test('detectCodeUrl returns null when no known host is present', () => {
  assert.equal(detectCodeUrl('No code link here.'), null);
  assert.equal(detectCodeUrl('Code at http://example.com/code'), null);
});

test('detectCodeUrl strips trailing punctuation', () => {
  const got = detectCodeUrl('See https://github.com/foo/bar.');
  assert.equal(got, 'https://github.com/foo/bar');
});

test('parseAtomFeed handles HTML entity decoding in titles', () => {
  const xml = `<feed><entry>
    <id>http://arxiv.org/abs/1</id>
    <title>A &amp; B &lt;vs&gt; C</title>
    <summary>x</summary>
    <published>2026-04-01T00:00:00Z</published>
  </entry></feed>`;
  const entries = parseAtomFeed(xml);
  assert.equal(entries[0].title, 'A & B <vs> C');
});
