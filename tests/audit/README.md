# Bağımsız denetim testleri

Bu testler ana test paketinden (`pnpm test`, `pnpm smoke`) ayrıdır. Projeye hiçbir şey yazmazlar ve yalnızca sentetik veri kullanırlar.

| Dosya | Ne yapar | Çalıştırma |
|---|---|---|
| `run-privacy-harness.mjs` + `privacy-harness/` | Gizleme piksel testleri: zaman aralığı, kesmeler, zoom, kamera, 4 format, hareketli alan. Ayrıca dışa aktarılan MP4/WebM karelerinde sızıntı kontrolü ve performans ölçümü. İki farklı sentetik "sır" kullanılır; gizli karelerde çıktı bayt bayt aynı olmalıdır. | `node tests/audit/run-privacy-harness.mjs` |
| `persist.audit.test.ts` | Karmaşık bir proje kaydedilip açılınca birebir aynı mı ve aynı mı çiziliyor. | `npx vitest run --config tests/audit/vitest.audit.config.ts` |

