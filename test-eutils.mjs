// Offline unit test: NCBI answers an outage with HTTP 200 + ERROR and no count/idlist
// (observed 2026-09-27). Search must then fall back to Europe PMC (and say so), and when
// both are down surface as isError / ✗ — never as "0 kayıt". Mocked fetch, no network.
//   node test-eutils.mjs
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { eutilsError, pubmedToEpmc } from "./lib/http.js";
import * as L from "./lib/science.js";

const J = "sciadv";
const P = { search: "science_search", access: "science_access_check", searchArgs: { query: "x", journal: J } };
const SOLR = '{"esearchresult":{"ERROR":"Search Backend failed: ... Cannot connect to SOLR"}}';
const ZERO = '{"header":{"type":"esearch","version":"0.3"},"esearchresult":{"count":"0","retmax":"0","retstart":"0","idlist":[],"translationset":[],"querytranslation":""}}';
const EPMC_OK = '{"hitCount":2,"resultList":{"result":[{"id":"111","source":"MED","pmid":"111"},{"id":"222","source":"MED","pmid":"222"}]}}';
const EPMC_DOWN = '{"errMsg":"Search service is temporarily unavailable. Please retry later."}';
const ESUMMARY = '{"result":{"uids":["111","222"],"111":{"title":"Trial A","source":"J","pubdate":"2024","articleids":[{"idtype":"doi","value":"10.1056/NEJMoa0000001"}],"authors":[{"name":"Doe J"}]},"222":{"title":"Trial B","source":"J","pubdate":"2023","articleids":[],"authors":[]}}}';
const json = { retmode: "json" };

// In-process fetch router: first URL substring that matches wins; anything else is offline.
const route = (map) => async (url) => {
  const u = String(url);
  for (const [k, b] of Object.entries(map)) if (u.includes(k)) return new Response(b, { status: 200 });
  throw new TypeError(`mock offline: ${u.slice(0, 60)}`);
};
async function withFetch(f, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = f;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

async function server(body) {
  const c = new Client({ name: "eutils-test", version: "0" });
  await c.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["--import", new URL("./test-mock-fetch.mjs", import.meta.url).href, new URL("./index.js", import.meta.url).pathname],
    env: { ...process.env, MOCK_ESEARCH: body },
  }));
  const call = async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { err: !!r.isError, t: r.content.map((x) => x.text).join("\n") };
  };
  return { call, close: () => c.close() };
}

const cases = [
  // --- ERROR detection
  ["eutilsError: esearch ERROR json", () => assert.match(eutilsError("esearch", json, SOLR), /Cannot connect to SOLR/)],
  ["eutilsError: esearch without count", () => assert.match(eutilsError("esearch", json, '{"esearchresult":{"idlist":[]}}'), /count yok/)],
  ["eutilsError: top-level error", () => assert.match(eutilsError("esummary", json, '{"error":"API rate limit exceeded"}'), /rate limit/)],
  ["eutilsError: non-JSON body", () => assert.match(eutilsError("esearch", json, "<html>502</html>"), /JSON olmayan/)],
  ["eutilsError: genuine zero hits ok", () => assert.equal(eutilsError("esearch", json, ZERO), "")],
  ["eutilsError: phrasesnotfound ok", () => assert.equal(eutilsError("esearch", json, '{"esearchresult":{"count":"0","idlist":[],"errorlist":{"phrasesnotfound":["zzqx"]}}}'), "")],
  ["eutilsError: efetch XML ERROR", () => assert.match(eutilsError("efetch", { retmode: "xml" }, '<?xml version="1.0"?>\n<eFetchResult><ERROR>Cannot retrieve</ERROR></eFetchResult>'), /Cannot retrieve/)],
  ["eutilsError: efetch XML ok", () => assert.equal(eutilsError("efetch", { retmode: "xml" }, "<PubmedArticleSet><PubmedArticle/></PubmedArticleSet>"), "")],

  // --- PubMed → Europe PMC translation, on this server's real buildQuery output
  ["epmc: journal + rct + year range + [tiab]", () => {
    const e = pubmedToEpmc(L.buildQuery({ journal: J, pubType: "rct", from: "2021", until: "2022", query: "aspirin AND heart failure[tiab]" }));
    assert.match(e, /JOURNAL:"[^"]+"/);
    assert.match(e, /PUB_TYPE:"randomized controlled trial"/);
    assert.match(e, /PUB_YEAR:\[2021 TO 2022\]/);
    assert.match(e, /\(TITLE_ABS:aspirin OR MESH_HEADING:aspirin OR KW:aspirin\) AND TITLE_ABS:"heart failure"/);
    assert.match(e, / AND SRC:MED$/);
    assert.doesNotMatch(e, /\[(ta|pt|dp|tiab)\]/);
  }],
  ["epmc: meta-analysis OR group", () =>
    assert.match(pubmedToEpmc(L.buildQuery({ journal: J, pubType: "meta-analysis" })), /\(PUB_TYPE:"meta-analysis" OR PUB_TYPE:"systematic review"\)/)],
  ["epmc: month dates → FIRST_PDATE (Feb end = 28)", () =>
    assert.match(pubmedToEpmc(L.buildQuery({ journal: J, from: "2021/02", until: "2021/02" })), /FIRST_PDATE:\[2021-02-01 TO 2021-02-28\]/)],
  ["epmc: DOI", () => assert.equal(pubmedToEpmc("10.1056/NEJMoa1107039[doi]"), '(DOI:"10.1056/NEJMoa1107039") AND SRC:MED')],
  ["epmc: MeSH + author", () => assert.match(pubmedToEpmc('"Heart Failure"[mh] AND Smith J[au]'), /MESH_HEADING:"Heart Failure" AND AUTH:"Smith J"/)],
  ["epmc: bare words/phrases scoped like PubMed all-fields (no full text)", () =>
    assert.equal(pubmedToEpmc('("base editing" OR cas9)'),
      '(((TITLE_ABS:"base editing" OR MESH_HEADING:"base editing" OR KW:"base editing") OR (TITLE_ABS:cas9 OR MESH_HEADING:cas9 OR KW:cas9))) AND SRC:MED')],
  ["epmc: unknown tag throws, not dropped", () => assert.throws(() => pubmedToEpmc("x[sb]"), /\[sb\] alanını çeviremiyor/)],

  // --- lib behaviour
  ["lib: esearch ERROR → Europe PMC fallback", () => withFetch(route({ "/esearch.fcgi": SOLR, "europepmc": EPMC_OK, "/esummary.fcgi": ESUMMARY }), async () => {
    const r = await L.search({ query: "x", journal: J });
    assert.equal(r.count, 2);
    assert.deepEqual(r.items.map((i) => i.pmid), ["111", "222"]);
    assert.equal(r.items[0].title, "Trial A");
    assert.match(r.fallback.reason, /Cannot connect to SOLR/);
    assert.match(r.fallback.query, /JOURNAL:.* AND SRC:MED/);
  })],
  ["lib: both down → combined error", () => withFetch(route({ "/esearch.fcgi": SOLR, "europepmc": EPMC_DOWN }), () =>
    assert.rejects(L.search({ query: "x", journal: J }), /Cannot connect to SOLR \| Europe PMC yedeği de başarısız: Europe PMC: Search service is temporarily unavailable/))],
  ["lib: pmidForDoi falls back", () => withFetch(route({ "/esearch.fcgi": SOLR, "europepmc": EPMC_OK }), async () =>
    assert.equal(await L.pmidForDoi("10.1056/NEJMoa1107039"), "111"))],
  ["lib: genuine zero hits → no fallback", () => withFetch(route({ "/esearch.fcgi": ZERO }), async () => {
    const r = await L.search({ query: "x", journal: J });
    assert.equal(r.count, 0);
    assert.equal(r.fallback, null);
  })],

  // --- MCP level (server process; its mock serves only esearch, Europe PMC is offline)
  ["mcp: esearch ERROR + Europe PMC down → isError, access ✗ PubMed", async () => {
    const s = await server(SOLR);
    try {
      const r = await s.call(P.search, P.searchArgs);
      assert.equal(r.err, true, r.t);
      assert.match(r.t, /Cannot connect to SOLR/);
      assert.doesNotMatch(r.t, /Toplam 0 kayıt/);
      const a = await s.call(P.access);
      assert.match(a.t, /✗ PubMed: .*Cannot connect to SOLR/, a.t);
      assert.doesNotMatch(a.t, /✓ PubMed/);
    } finally { await s.close(); }
  }],
  ["mcp: genuine zero hits → not an error", async () => {
    const s = await server(ZERO);
    try {
      const r = await s.call(P.search, P.searchArgs);
      assert.equal(r.err, false, r.t);
      assert.match(r.t, /Toplam 0 kayıt/);
      assert.doesNotMatch(r.t, /Europe PMC/);
      assert.match((await s.call(P.access)).t, /✗ PubMed: 0 /);
    } finally { await s.close(); }
  }],
];

let pass = 0;
for (const [name, fn] of cases) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { console.log(`FAIL ${name}: ${e.message.split("\n")[0]}`); }
}
console.log(`\n${pass}/${cases.length} geçti (eutils birim)`);
process.exit(pass === cases.length ? 0 : 1);
