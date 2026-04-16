import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePubmedXml, mine } from '../../lib/miners/pubmed.mjs';

const FIXTURE = `<PubmedArticleSet>
<PubmedArticle>
  <MedlineCitation>
    <PMID>99999001</PMID>
    <Article>
      <Journal>
        <Title>Nature Methods</Title>
        <JournalIssue>
          <PubDate>
            <Year>2026</Year>
            <Month>Apr</Month>
            <Day>10</Day>
          </PubDate>
        </JournalIssue>
      </Journal>
      <ArticleTitle>A scalable open-source tool for single-cell data integration</ArticleTitle>
      <Abstract>
        <AbstractText Label="BACKGROUND">Existing tools are slow.</AbstractText>
        <AbstractText Label="RESULTS">We introduce a new algorithm that is 10x faster.</AbstractText>
      </Abstract>
      <AuthorList>
        <Author>
          <LastName>Smith</LastName>
          <ForeName>Alice</ForeName>
        </Author>
        <Author>
          <LastName>Jones</LastName>
          <ForeName>Bob</ForeName>
        </Author>
      </AuthorList>
    </Article>
  </MedlineCitation>
</PubmedArticle>
<PubmedArticle>
  <MedlineCitation>
    <PMID>99999002</PMID>
    <Article>
      <Journal>
        <Title>Bioinformatics</Title>
        <JournalIssue>
          <PubDate>
            <Year>2026</Year>
            <Month>03</Month>
          </PubDate>
        </JournalIssue>
      </Journal>
      <ArticleTitle>Another paper &amp; its tool</ArticleTitle>
      <Abstract>
        <AbstractText>No label attribute here.</AbstractText>
      </Abstract>
      <AuthorList>
        <Author><LastName>Solo</LastName><Initials>X</Initials></Author>
      </AuthorList>
    </Article>
  </MedlineCitation>
</PubmedArticle>
</PubmedArticleSet>`;

test('parsePubmedXml extracts PMID, title, abstract, authors, journal, pub date', () => {
  const articles = parsePubmedXml(FIXTURE);
  assert.equal(articles.length, 2);

  const a = articles[0];
  assert.equal(a.pmid, '99999001');
  assert.match(a.title, /scalable open-source tool/);
  assert.match(a.abstract, /Existing tools are slow/);
  assert.match(a.abstract, /10x faster/);
  assert.equal(a.pubDate, '2026-04-10');
  assert.equal(a.journal, 'Nature Methods');
  assert.deepEqual(a.authors, ['Alice Smith', 'Bob Jones']);
});

test('parsePubmedXml concatenates multiple AbstractText sections', () => {
  const [a] = parsePubmedXml(FIXTURE);
  assert.ok(a.abstract.includes('Existing tools are slow'));
  assert.ok(a.abstract.includes('10x faster'));
});

test('parsePubmedXml decodes HTML entities in titles', () => {
  const articles = parsePubmedXml(FIXTURE);
  assert.equal(articles[1].title, 'Another paper & its tool');
});

test('parsePubmedXml handles numeric month and missing day', () => {
  const articles = parsePubmedXml(FIXTURE);
  assert.equal(articles[1].pubDate, '2026-03-01');
});

test('parsePubmedXml handles Initials-only authors', () => {
  const articles = parsePubmedXml(FIXTURE);
  assert.deepEqual(articles[1].authors, ['X Solo']);
});

test('mine calls esearch + efetch and emits observations', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (url.includes('esearch.fcgi')) {
      return {
        ok: true,
        async json() {
          return { esearchresult: { idlist: ['99999001', '99999002'] } };
        },
      };
    }
    if (url.includes('efetch.fcgi')) {
      return { ok: true, async text() { return FIXTURE; } };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: { queries: ['(algorithm[Title]) AND hasabstract[Filter]'] },
    logger: { warn() {}, info() {}, error() {} },
    lookbackDays: 3650,
  });

  assert.ok(calls.some((u) => u.includes('esearch.fcgi')));
  assert.ok(calls.some((u) => u.includes('efetch.fcgi')));
  assert.equal(observations.length, 2);
  assert.equal(observations[0].source, 'pubmed');
  assert.ok(observations[0].source_url.startsWith('https://pubmed.ncbi.nlm.nih.gov/'));
  assert.ok(observations[0].raw_id.startsWith('pubmed:'));
});

test('mine skips efetch when esearch returns no PMIDs', async (t) => {
  const originalFetch = globalThis.fetch;
  let efetchCalled = false;
  globalThis.fetch = async (url) => {
    if (url.includes('esearch.fcgi')) {
      return { ok: true, async json() { return { esearchresult: { idlist: [] } }; } };
    }
    efetchCalled = true;
    return { ok: true, async text() { return ''; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const { observations } = await mine({
    cursors: {},
    config: { queries: ['whatever'] },
    logger: { warn() {}, info() {}, error() {} },
  });
  assert.equal(observations.length, 0);
  assert.equal(efetchCalled, false);
});
