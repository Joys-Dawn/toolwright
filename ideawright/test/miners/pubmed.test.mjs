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

test('mine uses POST for efetch (not GET) so large PMID lists do not 414', async (t) => {
  // Regression: with max_per_query=1000 the efetch URL exceeded NCBI's
  // ~200-UID GET limit and returned HTTP 414. NCBI's docs (NBK25499) say
  // "if more than about 200 UIDs are to be provided, the request should be
  // made using the HTTP POST method." This test pins POST as the transport
  // for efetch regardless of list size.
  const originalFetch = globalThis.fetch;
  const efetchCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('esearch.fcgi')) {
      return {
        ok: true,
        async json() { return { esearchresult: { idlist: ['1', '2'] } }; },
      };
    }
    if (String(url).includes('efetch.fcgi')) {
      efetchCalls.push({ url: String(url), init });
      return { ok: true, async text() { return FIXTURE; } };
    }
    throw new Error(`unexpected url: ${url}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { queries: ['(algorithm[Title]) AND hasabstract[Filter]'] },
    logger: { warn() {}, info() {}, error() {} },
    lookbackDays: 3650,
  });

  assert.equal(efetchCalls.length, 1, 'efetch should be called once');
  assert.equal(efetchCalls[0].init?.method, 'POST', 'efetch must use POST');
  assert.equal(
    efetchCalls[0].init?.headers?.['Content-Type'],
    'application/x-www-form-urlencoded',
    'efetch must send form-urlencoded body',
  );
  assert.ok(
    String(efetchCalls[0].init?.body ?? '').includes('id=1%2C2'),
    'PMIDs must be in the body, not the URL',
  );
  assert.ok(
    !efetchCalls[0].url.includes('id='),
    'efetch URL must not carry the id param when POSTing',
  );
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

test('mine config.lookback_days widens the mindate window', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('esearch.fcgi')) {
      return { ok: true, async json() { return { esearchresult: { idlist: [] } }; } };
    }
    return { ok: true, async text() { return ''; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { queries: ['whatever'], lookback_days: 365 },
    logger: { warn() {}, info() {}, error() {} },
  });

  const url = urls.find((u) => u.includes('esearch.fcgi')) ?? '';
  // 365 days before today gives mindate roughly a year ago. We don't pin
  // the clock here — just verify the lookback flowed through to URL params.
  const m = url.match(/mindate=(\d{4})/);
  assert.ok(m, 'mindate should be in the URL');
  const yearInUrl = Number(m[1]);
  const expectedYearFloor = new Date(Date.now() - 366 * 86400_000).getUTCFullYear();
  assert.ok(
    yearInUrl <= expectedYearFloor + 1,
    `mindate year (${yearInUrl}) should be at or before ${expectedYearFloor + 1} for a 365-day lookback`,
  );
});

test('mine config.max_per_query overrides the function default', async (t) => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    if (String(url).includes('esearch.fcgi')) {
      capturedUrl = String(url);
      return { ok: true, async json() { return { esearchresult: { idlist: [] } }; } };
    }
    return { ok: true, async text() { return ''; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await mine({
    cursors: {},
    config: { queries: ['whatever'], max_per_query: 7 },
    logger: { warn() {}, info() {}, error() {} },
  });

  assert.match(capturedUrl, /retmax=7/);
});
