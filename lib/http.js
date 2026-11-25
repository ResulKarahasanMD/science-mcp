// Open-channel HTTP: PubMed E-utilities, Europe PMC, Crossref, Science RSS.
// None of these sit behind the Cloudflare challenge (measured 2026-09-25).
// science.org / spj.science.org HTML is deliberately NOT fetched here.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// GUI-launched Claude passes ${VAR} literally (see memory mcp-secrets-env-file),
// so fall back to reading the shared env file ourselves.
function ncbiKey() {
  const v = process.env.NCBI_API_KEY;
  if (v && !v.startsWith("${")) return v;
  const f = join(homedir(), ".config", "claude", "env");
  if (!existsSync(f)) return "";
  const m = readFileSync(f, "utf8").match(/^(?:export\s+)?NCBI_API_KEY=["']?([^"'\n]+)/m);
  return m ? m[1].trim() : "";
}
export const NCBI_KEY = ncbiKey();

const UA = "science-mcp/0.1 (personal research tool; mailto via NCBI tool param)";
const MIN_GAP = { ncbi: NCBI_KEY ? 110 : 350, other: 250 };
const last = {};

async function pace(bucket) {
  const gap = (last[bucket] || 0) + MIN_GAP[bucket] - Date.now();
  last[bucket] = Date.now() + Math.max(gap, 0);
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
}

export async function get(url, { accept, bucket = "other", retries = 2 } = {}) {
  for (let i = 0; ; i++) {
    await pace(bucket);
    const r = await fetch(url, { headers: { "user-agent": UA, ...(accept ? { accept } : {}) } });
    if ((r.status === 429 || r.status >= 500) && i < retries) {
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.replace(/api_key=[^&]+/, "api_key=***")}: ${text.slice(0, 200)}`);
    return text;
  }
}

// NCBI reports backend outages as HTTP 200 with an ERROR field and no results (seen
// 2026-09-27: esearch → {"esearchresult":{"ERROR":"Search Backend failed: … Cannot
// connect to SOLR"}}, no count/idlist). Callers read that as "0 hits", so an outage
// looked like an empty search. Returns the NCBI message, or "" if the body is usable.
// errorlist/warninglist (e.g. phrasesnotfound) are normal zero-hit answers, not errors.
export function eutilsError(endpoint, params, text) {
  if (params.retmode === "json") {
    let j;
    try { j = JSON.parse(text); } catch { return `JSON olmayan yanıt: ${text.slice(0, 200)}`; }
    const msg = j.error || j.esearchresult?.ERROR;
    if (msg) return String(msg);
    if (endpoint === "esearch" && j.esearchresult?.count === undefined) return `esearchresult.count yok: ${text.slice(0, 200)}`;
    return "";
  }
  const m = text.slice(0, 4000).match(/<ERROR>([\s\S]*?)<\/ERROR>/);
  if (m) return m[1].trim();
  if (endpoint === "esearch" && !/<Count>/.test(text)) return `<Count> yok: ${text.slice(0, 200)}`;
  return "";
}

const EU = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/";
export async function eutils(endpoint, params) {
  const q = new URLSearchParams({ tool: "science-mcp", ...params });
  if (NCBI_KEY) q.set("api_key", NCBI_KEY);
  const text = await get(`${EU}${endpoint}.fcgi?${q}`, { bucket: "ncbi" });
  const err = eutilsError(endpoint, params, text);
  if (err) throw new Error(`NCBI ${endpoint} hatası (HTTP 200): ${err}`);
  return text;
}

// ---------- PubMed search with Europe PMC fallback ----------
// 2026-09-27: PubMed esearch was down (SOLR) while esummary/efetch and Europe PMC search
// kept working. Europe PMC indexes the same MEDLINE/PubMed records (SRC:MED, with PMIDs),
// so on esearch failure the PubMed term is translated and only the PMID list comes from
// there; metadata still comes from NCBI esummary/efetch. Callers must show `fallback`.
const EPMC_FIELD = {
  ta: "JOURNAL", pt: "PUB_TYPE", tiab: "TITLE_ABS", ti: "TITLE", ab: "ABSTRACT",
  mh: "MESH_HEADING", mesh: "MESH_HEADING", majr: "MESH_HEADING", au: "AUTH", doi: "DOI",
};
const pad = (n) => String(n).padStart(2, "0");
function epmcDay(s, end) {
  const [y, m, d] = s.split("/").map(Number);
  if (d) return `${y}-${pad(m)}-${pad(d)}`;
  if (m) return end ? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) : `${y}-${pad(m)}-01`;
  return end ? `${y}-12-31` : `${y}-01-01`;
}
function epmcDate(a, b) {
  if (/^\d{4}$/.test(a) && /^\d{4}$/.test(b)) return `PUB_YEAR:[${a} TO ${b}]`;
  return `FIRST_PDATE:[${epmcDay(a, false)} TO ${epmcDay(b, true)}]`;
}

// PubMed term → Europe PMC query. Throws on a field tag it cannot map rather than
// silently dropping it (a dropped filter would widen the search without saying so).
export function pubmedToEpmc(term) {
  const t = term
    .replace(/\("([\d/]+)"\[dp\] : "([\d/]+)"\[dp\]\)/g, (_, a, b) => epmcDate(a, b))
    .replace(/"([\d/]+)"\[dp\]/g, (_, a) => epmcDate(a, a))
    .replace(/(?<![\w.\/-])("[^"]+"|(?:(?!(?:AND|OR|NOT)\b)[\w.\/-]+\s+)*(?!(?:AND|OR|NOT)\b)[\w.\/-]+)\[(\w+)(?::[^\]]*)?\]/g, (_, v, f) => {
      const F = EPMC_FIELD[f.toLowerCase()];
      if (!F) throw new Error(`Europe PMC yedeği [${f}] alanını çeviremiyor`);
      return `${F}:"${v.replace(/"/g, "")}"`;
    });
  // Unfielded Europe PMC terms also hit OA full text (2026-09-27: "CRISPR base editing" in
  // the 6 AAAS journals → 1301 hits incl. unrelated papers; 34 once scoped). PubMed's
  // all-fields is title/abstract/MeSH/keywords, so bare words and phrases get that scope.
  const scoped = t.replace(/[A-Z_]+:(?:"[^"]*"|\[[^\]]*\]|[^\s()]+)|"[^"]*"|\b(?:AND|OR|NOT)\b|[^\s()"]+/g, (m) =>
    /^[A-Z_]+:|^(?:AND|OR|NOT)$/.test(m) ? m : `(TITLE_ABS:${m} OR MESH_HEADING:${m} OR KW:${m})`);
  return `(${scoped}) AND SRC:MED`;
}

export async function epmcSearch(term, { limit = 20, page = 1, sort = "relevance" } = {}) {
  const query = pubmedToEpmc(term);
  if (limit * page > 1000) throw new Error("Europe PMC yedeği ilk 1000 kayıtla sınırlı");
  const q = new URLSearchParams({ query, format: "json", resultType: "idlist", pageSize: String(limit * page) });
  if (sort === "date") q.set("sort", "P_PDATE_D desc");
  const j = JSON.parse(await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?${q}`));
  if (j.hitCount === undefined) throw new Error(`Europe PMC: ${j.errMsg || "hitCount yok"}`);
  const ids = (j.resultList?.result || []).map((r) => r.pmid).filter(Boolean).slice((page - 1) * limit);
  return { query, count: j.hitCount, ids };
}

export async function pubmedSearch(term, { limit = 20, page = 1, sort = "relevance" } = {}) {
  try {
    const sr = JSON.parse(
      await eutils("esearch", {
        db: "pubmed", retmode: "json", term,
        retmax: String(limit), retstart: String((page - 1) * limit),
        sort: sort === "date" ? "pub_date" : "relevance",
      })
    ).esearchresult;
    return { count: +sr.count, ids: sr.idlist || [], fallback: null };
  } catch (e) {
    let ep;
    try { ep = await epmcSearch(term, { limit, page, sort }); }
    catch (e2) { throw new Error(`${e.message} | Europe PMC yedeği de başarısız: ${e2.message}`); }
    return { count: ep.count, ids: ep.ids, fallback: { reason: e.message, query: ep.query } };
  }
}
