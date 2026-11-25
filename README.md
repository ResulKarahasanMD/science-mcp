# science-mcp

> **English summary.** A discovery and open-full-text MCP server (stdio) for the Science family of journals (AAAS) and Science Partner Journals. It uses only open channels: official RSS feeds, PubMed, Crossref and NCBI PMC. It does not fetch subscriber full text and does not try to get past the publisher's bot protection.
> The rest of this README is in Turkish.

Science ailesi (Science, Science Immunology, Science Advances, Science Robotics, Science Signaling, Science Translational Medicine) ve Science Partner Journals (SPJ) için keşif ve açık tam metin MCP sunucusu (Node ESM, stdio). Yalnız açık kanalları kullanır: resmî RSS, PubMed E-utilities, Crossref ve NCBI PMC.

Abonelik tam metnini bu sunucu çekmez. science.org ve spj.science.org sayfaları anonim isteklere Cloudflare doğrulamasıyla yanıt verir; sunucu bunu aşmaya çalışmaz. Tam metin gerekiyorsa makaleyi kendi tarayıcında, kendi erişiminle aç.

## Araçlar

| Araç | Ne yapar |
|---|---|
| `science_search` | Science ailesini PubMed, SPJ dergilerini (DOI öneki 10.34133) Crossref üzerinden arar. |
| `science_latest` | AAAS dergilerinin güncel sayı içindekileri (resmî RSS), makale türüne göre gruplu. SPJ için Crossref'ten en yeni makaleler. Özet içermez. |
| `science_article` | Tek makalenin künyesi ve özeti (PubMed, orada yoksa Crossref), yayın türü, MeSH, trial kaydı, düzeltme ve geri çekme bağlantıları, PMC durumu. Kimlik: DOI, science.org adresi, PMID ya da PMCID. |
| `science_pmc_fulltext` | PMC'deki tam metin. Bölüm, terim ve tablo seçimiyle daraltılabilir. |
| `science_access_check` | Açık kanalların (6 AAAS RSS'i, PubMed, Crossref, PMC) erişim teşhisi. |

## PMC kapsaması

2024 yayınları için 2026-09-25'te ölçüldü:

| Dergi | PMC'de / toplam |
|---|---|
| Science Advances | 2314 / 2314 |
| Science Translational Medicine | 135 / 303 |
| Science Immunology | 72 / 170 |
| Science Signaling | 42 / 144 |
| Science | 248 / 1857 |
| Science Robotics | 3 / 137 |

SPJ dergilerinin tamamı PMC'dedir. Science Advances ve SPJ dışındaki dergilerde PMC kopyalarının çoğu yazar el yazmasıdır.

## Kurulum

```bash
npm install
claude mcp add science -- node /path/to/science-mcp/index.js
```

`NCBI_API_KEY` ortam değişkeni isteğe bağlıdır; verilirse NCBI'ın hız sınırı yükselir.

## Test

```bash
npm run test:unit   # ağ gerektirmez
npm test            # birim testleri + canlı vakalar
node test.mjs pmc   # canlı vakaları ada göre süz
```

## Sınırlar

- Science'ın bazı PMC kayıtları tam metnin XML olarak indirilmesine izin vermez (örnek: PMC6286148).
- Crossref'in üye bazlı sorgusu başka yayıncıların kayıtlarını da döndürür; sonuçlar DOI önekine göre süzülür.
- PubMed araması arızalanırsa PMID listesi Europe PMC'den alınır ve çıktıda bunu belirten bir uyarı görünür.

## Lisans

[MIT](LICENSE). Bu proje AAAS ile bağlantılı değildir; makale içeriğinin hakları yayıncıya aittir.
