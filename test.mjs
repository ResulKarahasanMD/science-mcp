// Live smoke test over stdio. No mocks. Every id below was observed in real data on
// 2026-09-25 (RSS / PubMed / idconv) — do not replace with invented DOIs.
//   npm test | node test.mjs pmc
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const filter = process.argv[2];
const client = new Client({ name: "science-test", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("./index.js", import.meta.url).pathname] }));

const cases = [
  ["tools-listed", null, null, async () => (await client.listTools()).tools.length === 5],
  ["access", "science_access_check", {}, (t) => (t.match(/✓/g) || []).length === 9],
  ["search-all", "science_search", { query: "CRISPR base editing" }, (t) => t.includes("10.1126/science.1225829")],
  ["search-stm-date", "science_search", { journal: "stm", from: "2025", until: "2025", sort: "date", limit: 5 }, (t) => t.includes('"Sci Transl Med"[ta]') && /Sci Transl Med 2025/.test(t)],
  ["search-spj", "science_search", { journal: "spj", query: "deep learning plant phenotyping", limit: 5 }, (t) => t.includes("10.34133/") && !t.includes("10.1016/")],
  ["latest-science", "science_latest", { journal: "science" }, (t) => t.includes("## Science —") && t.includes("### Research Article")],
  ["latest-type", "science_latest", { journal: "all", type: "^Research Article$" }, (t) => t.includes("Science Translational Medicine") && !t.includes("### Perspective")],
  ["latest-spj", "science_latest", { journal: "spj" }, (t) => t.includes("## SPJ") && t.includes("10.34133/")],
  ["article-science", "science_article", { id: "10.1126/science.1225829" }, (t) => t.includes("PMID 22745249") && t.includes("PMC6286148") && t.includes("www.science.org/doi/10.1126/science.1225829")],
  ["article-url", "science_article", { id: "https://www.science.org/doi/10.1126/science.1231143" }, (t) => t.includes("PMID 23287718")],
  ["article-spj", "science_article", { id: "10.34133/research.0933" }, (t) => t.includes("PMC12501636") && t.includes("spj.science.org/doi/10.34133/research.0933") && t.includes("açık erişim")],
  ["article-pmcid", "science_article", { id: "PMC12799294" }, (t) => t.includes("10.1126/scitranslmed.aea9007")],
  ["article-bad-doi", "science_article", { id: "10.1126/science.zzz9999999" }, (t) => t.includes("Bulunamadı")],
  ["pmc-sciadv", "science_pmc_fulltext", { id: "10.1126/sciadv.adz6907" }, (t) => t.includes("PMC13600164") && t.includes("yayın sürümü") && t.includes("İçindekiler:")],
  ["pmc-manuscript", "science_pmc_fulltext", { id: "10.1126/scitranslmed.aea9007", sections: "INTRODUCTION" }, (t) => t.includes("YAZAR EL YAZMASI") && t.includes("INTRODUCTION") && !t.includes("## DISCUSSION")],
  ["pmc-tables", "science_pmc_fulltext", { id: "10.1126/science.abq7248", sections: "^$", tables: true }, (t) => t.includes("| --- |")],
  ["pmc-noxml", "science_pmc_fulltext", { id: "PMC6286148" }, (t) => t.includes("XML olarak vermiyor")],
  ["pmc-find", "science_pmc_fulltext", { id: "10.34133/research.0933", find: "strain" }, (t) => /strain/i.test(t) && t.length < 30000],
  ["bad-id", "science_article", { id: "hello" }, (t, isErr) => isErr && t.includes("Tanınmayan kimlik")],
];

let pass = 0, run = 0;
for (const [name, tool, args, check] of cases) {
  if (filter && !name.includes(filter)) continue;
  run++;
  const t0 = Date.now();
  try {
    let ok;
    if (!tool) ok = await check();
    else {
      const r = await client.callTool({ name: tool, arguments: args });
      const txt = r.content.map((c) => c.text).join("\n");
      ok = await check(txt, !!r.isError);
      if (!ok) console.log(`   çıktı: ${txt.slice(0, 500).replace(/\n/g, " ⏎ ")}`);
    }
    if (ok) pass++;
    console.log(`${ok ? "PASS" : "FAIL"} ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${pass}/${run} geçti`);
await client.close();
process.exit(pass === run ? 0 : 1);
