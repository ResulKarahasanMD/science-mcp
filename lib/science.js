// Science / AAAS journals + Science Partner Journals (SPJ): RSS, PubMed, Crossref, PMC.

import { get, eutils, pubmedSearch } from "./http.js";

// PMC coverage measured 2026-09-25 (2024 PubMed records → in PMC):
//   Science 248/1857, Sci Immunol 72/170, Sci Adv 2314/2314, Sci Robot 3/137,
//   Sci Signal 42/144, Sci Transl Med 135/303; SPJ journals 100%.
export const JOURNALS = {
  science: { name: "Science", ta: '"Science"[ta]', doi: "10.1126/science.", jc: "science", oa: false },
  sciimmunol: { name: "Science Immunology", ta: '"Sci Immunol"[ta]', doi: "10.1126/sciimmunol.", jc: "sciimmunol", oa: false },
  sciadv: { name: "Science Advances", ta: '"Sci Adv"[ta]', doi: "10.1126/sciadv.", jc: "sciadv", oa: true },
  scirobotics: { name: "Science Robotics", ta: '"Sci Robot"[ta]', doi: "10.1126/scirobotics.", jc: "scirobotics", oa: false },
  signaling: { name: "Science Signaling", ta: '"Sci Signal"[ta]', doi: "10.1126/scisignal.", jc: "signaling", oa: false },
  stm: { name: "Science Translational Medicine", ta: '"Sci Transl Med"[ta]', doi: "10.1126/scitranslmed.", jc: "stm", oa: false },
  spj: { name: "Science Partner Journals (SPJ)", doi: "10.34133/", oa: true },
};
export const AAAS = ["science", "sciimmunol", "sciadv", "scirobotics", "signaling", "stm"];

const rssUrl = (j) => `https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=${JOURNALS[j].jc}`;

export function parseDoi(input) {
  if (!input) return null;
  const m = String(input).match(/10\.(?:1126|34133)\/[A-Za-z0-9._-]+/);
  return m ? m[0].replace(/[.,;]+$/, "") : null;
}

export function journalOf(doi) {
  const d = (doi || "").toLowerCase();
  return Object.keys(JOURNALS).find((k) => d.startsWith(JOURNALS[k].doi)) || null;
}

export function fullTextUrl(doi) {
  return journalOf(doi) === "spj" ? `https://spj.science.org/doi/${doi}` : `https://www.science.org/doi/${doi}`;
}

// ---------- tiny XML helpers ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
export function strip(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : "";
}
function tags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);
}

// ---------- RSS (AAAS journals). Unlike NEJM, items carry dc:type = article type. ----------
export async function latest(journal) {
  const xml = await get(rssUrl(journal));
  return [...xml.matchAll(/<item\s[^>]*>([\s\S]*?)<\/item>/g)].map(([, it]) => ({
    journal,
    doi: strip(tag(it, "prism:doi")) || parseDoi(strip(tag(it, "link"))),
    type: strip(tag(it, "dc:type")) || "?",
    title: strip(tag(it, "title")),
    date: strip(tag(it, "dc:date")),
    volume: strip(tag(it, "prism:volume")),
    issue: strip(tag(it, "prism:number")),
    pages: [strip(tag(it, "prism:startingPage")), strip(tag(it, "prism:endingPage"))].filter(Boolean).join("-"),
  }));
}

// ---------- Crossref (SPJ: no single RSS, ~20 journals under prefix 10.34133) ----------
function crossrefItem(i) {
  const d = i.published?.["date-parts"]?.[0] || i.issued?.["date-parts"]?.[0] || [];
  return {
    doi: i.DOI,
    title: strip((i.title || [""])[0]),
    journal: decode((i["container-title"] || [""])[0]),
    date: d.join("-"),
    type: i.type,
    firstAuthor: i.author?.[0] ? `${i.author[0].family || ""} ${i.author[0].given?.[0] || ""}`.trim() : "",
    abstract: i.abstract ? strip(i.abstract.replace(/<jats:title>[^<]*<\/jats:title>/g, "")) : "",
    authors: (i.author || []).map((a) => `${a.family || ""} ${(a.given || "").split(/\s+/).map((x) => x[0]).join("")}`.trim()),
    volume: i.volume, issue: i.issue, page: i.page || i["article-number"],
  };
}

export async function spjSearch({ query, from, until, sort = "relevance", limit = 10, page = 1 }) {
  const q = new URLSearchParams({ rows: String(Math.min(limit * 3, 100)), offset: String((page - 1) * limit * 3) });
  if (query) q.set("query.bibliographic", query);
  // /prefixes/{p}/works is keyed by Crossref *member*: it also returns Elsevier CSBJ
  // (10.1016/j.csbj…), and filter=prefix:10.34133 did not change that (710 → 710,
  // measured 2026-09-25). So over-fetch and keep only real SPJ DOIs.
  const f = ["type:journal-article"];
  if (from) f.push(`from-pub-date:${from.replace(/\//g, "-")}`);
  if (until) f.push(`until-pub-date:${until.replace(/\//g, "-")}`);
  q.set("filter", f.join(","));
  if (sort === "date" || !query) { q.set("sort", "published"); q.set("order", "desc"); }
  const j = JSON.parse(await get(`https://api.crossref.org/prefixes/10.34133/works?${q}`)).message;
  const spj = j.items.filter((i) => i.DOI.toLowerCase().startsWith("10.34133/"));
  return { count: j["total-results"], dropped: j.items.length - spj.length, items: spj.slice(0, limit).map(crossrefItem) };
}

export async function crossrefWork(doi) {
  try {
    return crossrefItem(JSON.parse(await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)).message);
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return null;
    throw e;
  }
}

// ---------- PubMed ----------
export const PUBTYPES = {
  any: "",
  rct: "randomized controlled trial[pt]",
  trial: "clinical trial[pt]",
  review: "review[pt]",
  "meta-analysis": "(meta-analysis[pt] OR systematic review[pt])",
};

export function buildQuery({ query, journal = "all", pubType = "any", from, until }) {
  const js = journal === "all" ? AAAS : [journal];
  const parts = [`(${js.map((j) => JOURNALS[j].ta).join(" OR ")})`];
  if (query) parts.push(`(${query})`);
  if (PUBTYPES[pubType]) parts.push(PUBTYPES[pubType]);
  if (from || until) parts.push(`("${from || "1880"}"[dp] : "${until || "3000"}"[dp])`);
  return parts.join(" AND ");
}

export async function search({ limit = 10, page = 1, sort = "relevance", ...q }) {
  const term = buildQuery(q);
  const { count, ids, fallback } = await pubmedSearch(term, { limit, page, sort });
  if (!ids.length) return { term, count, fallback, items: [] };
  const sum = JSON.parse(await eutils("esummary", { db: "pubmed", retmode: "json", id: ids.join(",") })).result;
  return {
    term,
    count,
    fallback,
    items: ids.map((id) => {
      const r = sum[id] || {};
      const aid = Object.fromEntries((r.articleids || []).map((a) => [a.idtype, a.value]));
      return {
        pmid: id, doi: aid.doi || parseDoi(r.elocationid), pmcid: aid.pmc || null,
        title: strip(r.title), journal: r.source, date: r.pubdate,
        pubtypes: r.pubtype || [], firstAuthor: r.authors?.[0]?.name || "",
      };
    }),
  };
}

export async function pmidForDoi(doi) {
  return (await pubmedSearch(`${doi}[doi]`, { limit: 1 })).ids[0] || null;
}

export async function pmcidForDoi(doi) {
  const r = JSON.parse(await get(`https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${encodeURIComponent(doi)}&format=json`)).records?.[0];
  return r?.pmcid || null;
}

export async function article(pmid) {
  const xml = await eutils("efetch", { db: "pubmed", id: pmid, retmode: "xml" });
  const art = tag(xml, "PubmedArticle");
  if (!art) return null;
  // Only the FIRST <ArticleIdList> is the article's own: <ReferenceList> entries carry
  // ArticleIds too, and fromEntries keeps the last one seen — that returned a cited
  // paper's DOI/PMCID (found 2026-09-25: PMID 41442501 → sciimmunol DOI of a reference).
  const ids = Object.fromEntries(
    [...tag(art, "ArticleIdList").matchAll(/<ArticleId IdType="([^"]+)">([^<]+)<\/ArticleId>/g)].map((m) => [m[1], m[2]])
  );
  const d = tag(art, "PubDate");
  return {
    pmid,
    doi: ids.doi || null,
    pmcid: ids.pmc || null,
    title: strip(tag(art, "ArticleTitle")),
    journal: strip(tag(art, "Title")),
    citation: `${strip(tag(art, "ISOAbbreviation"))} ${strip(tag(d, "Year"))};${strip(tag(art, "Volume"))}(${strip(tag(art, "Issue"))}):${strip(tag(art, "MedlinePgn")) || ids.doi || ""}`,
    authors: tags(art, "Author").map((a) => strip(tag(a, "CollectiveName")) || `${strip(tag(a, "LastName"))} ${strip(tag(a, "Initials"))}`.trim()),
    pubtypes: tags(art, "PublicationType").map(strip),
    mesh: tags(art, "DescriptorName").map(strip),
    trials: [...art.matchAll(/<AccessionNumber>([^<]+)<\/AccessionNumber>/g)].map((m) => m[1]),
    abstract: [...tag(art, "Abstract").matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(([, a, b]) => ({
      label: (a.match(/Label="([^"]+)"/) || [])[1] || "", text: strip(b),
    })),
    linked: [...art.matchAll(/<CommentsCorrections RefType="(\w+)"[^>]*>[\s\S]*?<RefSource>([^<]+)<\/RefSource>/g)]
      .filter((m) => /CommentIn|ErratumIn|RetractionIn|UpdateIn|ExpressionOfConcernIn/.test(m[1]))
      .map((m) => `${m[1]}: ${strip(m[2])}`),
  };
}

// ---------- PMC full text via NCBI efetch (covers OA and NIH author manuscripts) ----------
export async function pmcFullText(pmcid) {
  const id = pmcid.toUpperCase().startsWith("PMC") ? pmcid.toUpperCase() : `PMC${pmcid}`;
  const xml = await eutils("efetch", { db: "pmc", id: id.slice(3), retmode: "xml" });
  if (!/<body[\s>]/.test(xml)) {
    const notice = strip((xml.match(/<!--[^>]*does not allow[\s\S]*?-->/) || [""])[0]);
    return { pmcid: id, available: false, notice };
  }
  // Linear walk: <sec>s nest, a lazy regex would stop at the first inner </sec>.
  const body = tag(xml, "body").replace(/<(table-wrap|fig)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, "");
  const sections = [];
  let depth = 0;
  for (const m of body.matchAll(/<(\/?)sec(?:\s[^>]*)?>|<title>([\s\S]*?)<\/title>|<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
    if (m[0].startsWith("<sec")) depth++;
    else if (m[1] === "/") depth--;
    else if (m[2] !== undefined) sections.push({ title: strip(m[2]), depth, text: "" });
    else {
      if (!sections.length) sections.push({ title: "(giriş)", depth: 1, text: "" });
      const s = sections[sections.length - 1];
      s.text += (s.text ? "\n\n" : "") + strip(m[3]);
    }
  }
  const manuscript = /nihms|author manuscript|<article-id pub-id-type="manuscript"/i.test(xml.slice(0, 5000));
  return {
    pmcid: id, available: true, manuscript,
    title: strip(tag(xml, "article-title")),
    sections,
    tables: tags(xml, "table-wrap").map((t) => ({
      label: strip(tag(t, "label")), caption: strip(tag(t, "caption")),
      rows: tags(t, "tr").map((tr) => [...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => strip(c[1]))),
    })),
    figures: tags(xml, "fig").map((f) => ({ label: strip(tag(f, "label")), caption: strip(tag(f, "caption")) })),
  };
}
