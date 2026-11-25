#!/usr/bin/env node
// science-mcp — Science / AAAS journals + SPJ: discovery and open full text.
//
// science.org and spj.science.org HTML sit behind a Cloudflare managed challenge
// (403 `cf-mitigated: challenge`, measured 2026-09-25) — same as NEJM, so this server
// never fetches them. Subscriber full text is read through the user's own Chrome
// (Claude in Chrome) by the companion skill. Open channels used here: AAAS RSS,
// PubMed, Crossref (SPJ), NCBI PMC (Science Advances and SPJ are 100% in PMC).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as S from "./lib/science.js";
import { NCBI_KEY, get } from "./lib/http.js";

const server = new McpServer({ name: "science", version: "0.1.0" });
const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `HATA: ${e.message || e}` }] });
const fallbackNote = (r) =>
  r.fallback
    ? `\n⚠ PubMed esearch arızalı → PMID listesi Europe PMC yedeğinden (aynı MEDLINE kayıtları, SRC:MED; toplam ve sıralama PubMed'den biraz farklı olabilir; künyeler yine NCBI esummary'den).` +
      `\n  Europe PMC sorgusu: ${r.fallback.query}\n  Sebep: ${r.fallback.reason.slice(0, 200)}`
    : "";
const tool = (name, desc, shape, fn) =>
  server.tool(name, desc, shape, async (args) => {
    try { return text(await fn(args)); } catch (e) { return fail(e); }
  });

const JKEYS = Object.keys(S.JOURNALS);
const chromeHint = (doi) =>
  `Abonelik tam metni: ${S.fullTextUrl(doi)}\n` +
  `→ Claude in Chrome ile aç (kullanıcının AAAS oturumu). Cloudflare doğrulaması çıkarsa kullanıcı geçer (Claude tıklamaz).`;

async function resolve(id) {
  const s = String(id).trim();
  if (/^PMC\d+$/i.test(s)) return { pmcid: s.toUpperCase() };
  if (/^\d{5,9}$/.test(s)) return { pmid: s };
  const doi = S.parseDoi(s);
  if (!doi) throw new Error(`Tanınmayan kimlik: "${s}". DOI (10.1126/… veya 10.34133/…), science.org URL'i, PMID ya da PMCID ver.`);
  return { doi };
}

function mdTable(t) {
  const w = Math.max(...t.rows.map((r) => r.length), 1);
  const rows = t.rows.map((r) => [...r, ...Array(w - r.length).fill("")].map((c) => c.replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  return [`| ${rows[0].join(" | ")} |`, `|${" --- |".repeat(w)}`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

// ---------------------------------------------------------------- tools

tool(
  "science_search",
  "Science ailesi (Science, Sci Immunol, Sci Adv, Sci Robot, Sci Signal, Sci Transl Med) PubMed üzerinden; SPJ (Research, Plant Phenomics, BME Frontiers… 10.34133) Crossref üzerinden aranır. Cloudflare'siz.",
  {
    query: z.string().optional().describe("Konu, İngilizce. AAAS dergilerinde PubMed sözdizimi (MeSH, [tiab]) geçerli"),
    journal: z.enum(["all", ...JKEYS]).default("all").describe("all = altı AAAS dergisi (SPJ hariç); spj = Science Partner Journals"),
    pubType: z.enum(Object.keys(S.PUBTYPES)).default("any").describe("Yalnız AAAS/PubMed için"),
    from: z.string().optional().describe("YYYY veya YYYY/MM/DD"),
    until: z.string().optional(),
    sort: z.enum(["relevance", "date"]).default("relevance"),
    limit: z.number().int().min(1).max(50).default(10),
    page: z.number().int().min(1).default(1),
  },
  async (a) => {
    if (a.journal === "spj") {
      const r = await S.spjSearch(a);
      const lines = r.items.map((i, k) => `${k + 1}. ${i.title}\n   ${i.journal} ${i.date} · ${i.firstAuthor}\n   DOI ${i.doi}`);
      return `SPJ (Crossref, prefix 10.34133): ~${r.count} kayıt (üye bazlı sayı; SPJ dışı ${r.dropped} kayıt bu sayfadan atıldı)\n\n${lines.join("\n") || "(sonuç yok)"}\n\nSPJ açık erişimdir → science_pmc_fulltext(id=DOI).`;
    }
    const r = await S.search(a);
    const lines = r.items.map(
      (i, k) =>
        `${k + 1 + (a.page - 1) * a.limit}. ${i.title}\n   ${i.journal} ${i.date} · ${i.firstAuthor} · ${i.pubtypes.filter((t) => t !== "Journal Article").join(", ") || "Journal Article"}\n` +
        `   PMID ${i.pmid} · DOI ${i.doi || "-"}${i.pmcid ? ` · ${i.pmcid} (PMC'de)` : ""}`
    );
    return `Sorgu: ${r.term}\nToplam ${r.count} kayıt; sayfa ${a.page}${fallbackNote(r)}\n\n${lines.join("\n") || "(sonuç yok)"}\n\nAyrıntı/özet: science_article(id=PMID veya DOI).`;
  }
);

tool(
  "science_latest",
  "AAAS dergilerinin güncel sayı içindekileri (resmî RSS), makale türüne göre gruplu (Research Article, Perspective, In Depth, Review…). SPJ için Crossref'ten en yeni makaleler. Özet içermez.",
  {
    journal: z.enum(["all", ...JKEYS]).default("science"),
    type: z.string().optional().describe("Tür süzgeci, '|' ile regex (ör. 'Research Article|Review')"),
    grep: z.string().optional().describe("Başlıkta kelime(ler), '|' ile"),
  },
  async ({ journal, type, grep }) => {
    const typeRe = type ? new RegExp(type, "i") : null;
    const re = grep ? new RegExp(grep, "i") : null;
    const out = [];
    const js = journal === "all" ? S.AAAS : [journal];
    for (const j of js) {
      if (j === "spj") {
        const r = await S.spjSearch({ limit: 25, sort: "date" });
        const items = r.items.filter((i) => !re || re.test(i.title));
        out.push(`## SPJ — en yeni ${items.length} makale (Crossref)`);
        for (const i of items) out.push(`- ${i.title}\n  ${i.journal} · ${i.doi} · ${i.date}`);
        out.push("");
        continue;
      }
      const all = await S.latest(j);
      const items = all.filter((i) => (!typeRe || typeRe.test(i.type)) && (!re || re.test(i.title)));
      const head = all[0] ? `Cilt ${all[0].volume}, Sayı ${all[0].issue}` : "";
      out.push(`## ${S.JOURNALS[j].name} — ${head} (${items.length}/${all.length})`);
      const by = {};
      for (const i of items) (by[i.type] ||= []).push(i);
      for (const [k, arr] of Object.entries(by)) {
        out.push(`\n### ${k}`);
        for (const i of arr) out.push(`- ${i.title}\n  ${i.doi} · ${i.date.slice(0, 10)}${i.pages ? ` · s. ${i.pages}` : ""}`);
      }
      out.push("");
    }
    return out.join("\n");
  }
);

tool(
  "science_article",
  "Tek makalenin künyesi + özeti (PubMed; PubMed'de yoksa Crossref), yayın türü, MeSH, trial kaydı, düzeltme/geri çekme bağlantıları, PMC durumu ve tam metin yolu. id: DOI, science.org URL'i, PMID veya PMCID.",
  { id: z.string() },
  async ({ id }) => {
    const r = await resolve(id);
    if (r.pmcid && !r.doi) {
      const c = JSON.parse(await get(`https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${r.pmcid}&format=json`)).records?.[0];
      r.doi = c?.doi; r.pmid = c?.pmid;
    }
    if (r.doi && !r.pmid) r.pmid = await S.pmidForDoi(r.doi);
    const a = r.pmid ? await S.article(r.pmid) : null;
    const doi = a?.doi || r.doi;
    const j = doi && S.journalOf(doi);
    const pmcid = a?.pmcid || (doi ? await S.pmcidForDoi(doi) : null);
    let head;
    if (a) {
      head = [
        `# ${a.title}`,
        `${a.citation}${j ? ` · ${S.JOURNALS[j].name}` : ""}`,
        `PMID ${a.pmid} · DOI ${doi || "-"}${pmcid ? ` · ${pmcid}` : ""}`,
        `Yazarlar (${a.authors.length}): ${a.authors.slice(0, 8).join(", ")}${a.authors.length > 8 ? ", …" : ""}`,
        `Yayın türü: ${a.pubtypes.join("; ")}`,
        a.trials.length ? `Kayıt: ${a.trials.join(", ")}` : "",
        a.mesh.length ? `MeSH: ${a.mesh.join("; ")}` : "",
        a.linked.length ? `Bağlantılı: ${a.linked.slice(0, 10).join(" · ")}` : "",
        "", "## Özet",
        a.abstract.length ? a.abstract.map((x) => (x.label ? `**${x.label}.** ${x.text}` : x.text)).join("\n\n") : "(PubMed'de özet yok)",
      ];
    } else {
      const c = doi ? await S.crossrefWork(doi) : null;
      if (!c) return `Bulunamadı (${doi || id}): PubMed'de de Crossref'te de kayıt yok — DOI yanlış olabilir.`;
      head = [
        `# ${c.title}`,
        `${c.journal} ${c.date}${c.volume ? `;${c.volume}` : ""}${c.page ? `:${c.page}` : ""} · (künye Crossref'ten; PubMed'de kayıt yok)`,
        `DOI ${doi}${pmcid ? ` · ${pmcid}` : ""}`,
        `Yazarlar (${c.authors.length}): ${c.authors.slice(0, 8).join(", ")}${c.authors.length > 8 ? ", …" : ""}`,
        "", "## Özet", c.abstract || "(Crossref'te özet yok)",
      ];
    }
    const tail = ["", "## Tam metin"];
    if (pmcid) tail.push(`PMC kopyası var → science_pmc_fulltext(id="${pmcid}")${j && S.JOURNALS[j].oa ? " (açık erişim, yayın sürümü)" : " (çoğu zaman yazar el yazması)"}.`);
    else tail.push("PMC kopyası yok.");
    if (doi) tail.push(chromeHint(doi));
    return [...head, ...tail].filter((x) => x !== "").join("\n");
  }
);

tool(
  "science_pmc_fulltext",
  "PMC'deki tam metin (NCBI; Cloudflare'siz). Science Advances ve SPJ'de %100 kapsama; diğer AAAS dergilerinde çoğu kopya yazar el yazmasıdır. sections/find/tables ile daraltılır. id: PMCID, PMID veya DOI.",
  {
    id: z.string(),
    sections: z.string().optional().describe("Bölüm başlığında regex, '|' ile (ör. 'RESULTS|Methods')"),
    find: z.string().optional().describe("Paragraf süzgeci, '|' ile"),
    tables: z.boolean().default(false),
    maxChars: z.number().int().min(1000).max(200000).default(30000),
  },
  async ({ id, sections, find, tables, maxChars }) => {
    const r = await resolve(id);
    let pmcid = r.pmcid;
    if (!pmcid && r.doi) pmcid = await S.pmcidForDoi(r.doi);
    if (!pmcid && r.pmid) pmcid = (await S.article(r.pmid))?.pmcid;
    if (!pmcid) return `PMC kopyası yok.${r.doi ? `\n${chromeHint(r.doi)}` : ""}`;
    const ft = await S.pmcFullText(pmcid);
    if (!ft.available) return `${pmcid}: yayıncı PMC tam metnini XML olarak vermiyor (${ft.notice || "gövde yok"}).${r.doi ? `\n${chromeHint(r.doi)}` : ""}`;
    const secRe = sections ? new RegExp(sections, "i") : null;
    const findRe = find ? new RegExp(find, "i") : null;
    const out = [
      `# ${ft.title}`,
      `${ft.pmcid} · ${ft.manuscript ? "YAZAR EL YAZMASI (yayın sürümünden küçük farklar olabilir)" : "yayın sürümü"} · ${ft.sections.length} bölüm · ${ft.tables.length} tablo · ${ft.figures.length} şekil`,
      "",
    ];
    if (!secRe && !findRe) out.push("İçindekiler: " + ft.sections.map((s) => s.title).join(" | "), "");
    let parentHit = false;
    for (const s of ft.sections) {
      const hit = !secRe || secRe.test(s.title) || (parentHit && s.depth > 1);
      if (secRe && s.depth === 1) parentHit = secRe.test(s.title);
      if (!hit) continue;
      let body = s.text;
      if (findRe) body = body.split("\n\n").filter((p) => findRe.test(p)).join("\n\n");
      if (!body) continue;
      out.push(`${"#".repeat(Math.min(s.depth + 1, 4))} ${s.title}`, body, "");
    }
    if (tables) for (const t of ft.tables) out.push(`### ${t.label} ${t.caption}`, mdTable(t), "");
    else if (ft.tables.length) out.push("Tablolar: " + ft.tables.map((t) => `${t.label} ${t.caption.slice(0, 80)}`).join(" · ") + " → tables=true");
    if (ft.figures.length) out.push("Şekiller: " + ft.figures.map((f) => `${f.label} ${f.caption.slice(0, 100)}`).join(" · "));
    const s = out.join("\n");
    return s.length > maxChars ? s.slice(0, maxChars) + `\n\n… [${s.length - maxChars} karakter kesildi; sections/find ile daralt]` : s;
  }
);

tool(
  "science_access_check",
  "Açık kanalların (6 AAAS RSS, PubMed, Crossref/SPJ, PMC) erişim teşhisi. Abonelik tam metni bu sunucudan değil Chrome'dan okunur.",
  {},
  async () => {
    const rows = [];
    const probe = async (label, fn) => {
      const t = Date.now();
      try { rows.push(`✓ ${label}: ${await fn()} (${Date.now() - t} ms)`); } catch (e) { rows.push(`✗ ${label}: ${e.message.slice(0, 160)}`); }
    };
    for (const j of S.AAAS) await probe(`${S.JOURNALS[j].name} RSS`, async () => `${(await S.latest(j)).length} öğe`);
    // NCBI ERROR bodies now throw in eutils(); a whole journal at 0 is also never healthy.
    // Europe PMC fallback keeps search working, but esearch itself is still reported ✗.
    let pm;
    await probe("PubMed", async () => {
      pm = await S.search({ journal: "sciadv", limit: 1 });
      if (pm.fallback) throw new Error(pm.fallback.reason);
      if (!pm.count) throw new Error("0 Sci Adv kaydı — PubMed yanıtı şüpheli");
      return `${pm.count} Sci Adv kaydı`;
    });
    if (pm?.fallback) rows.push(`${pm.count ? "✓" : "✗"} Europe PMC yedeği: ${pm.count} Sci Adv kaydı (arama bununla sürüyor)`);
    await probe("Crossref SPJ", async () => `${(await S.spjSearch({ limit: 1 })).items[0]?.doi || "boş"}`);
    await probe("PMC efetch", async () => { const f = await S.pmcFullText("PMC12501636"); return f.available ? `${f.sections.length} bölüm` : "gövde yok"; });
    rows.push(`NCBI API anahtarı: ${NCBI_KEY ? "var" : "YOK (3 istek/sn)"}`);
    rows.push("Abonelik tam metni: Claude in Chrome. science.org doğrudan HTTP'ye Cloudflare challenge verir — bu sunucu denemez.");
    return rows.join("\n");
  }
);

await server.connect(new StdioServerTransport());
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
