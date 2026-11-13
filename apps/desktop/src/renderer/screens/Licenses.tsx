import { useEffect, useState } from 'react';
import type { ThirdPartyInfo } from '@zeyvola/protocol';
import { api } from '../api';
import { t, useLang } from '../i18n';
import { Badge, Button } from '../ui/controls';
import { Icon } from '../ui/icons';

type Codec = ThirdPartyInfo['codecs'][number];

/** Settings → "Lisanslar ve üçüncü taraf yazılımlar". Data comes from dist/licenses (written by the build). */
export function LicensesSection() {
  const lang = useLang();
  const [info, setInfo] = useState<ThirdPartyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.licenses().then(setInfo, (e: Error) => setError(e.message)); }, []);

  const toggle = (key: string) => setOpen(open === key ? null : key);
  const pick = (v: { tr: string; en: string }) => (lang === 'tr' ? v.tr : v.en);
  const status = (c: Codec) => (c.status === 'legal-review'
    ? <Badge tone="warning">{t("Hukuki inceleme gerekli")}</Badge>
    : <Badge tone="neutral">{t("Düşük risk · doğrulanmadı")}</Badge>);

  return (
    <section className="licenses">
      <h2>{t("Lisanslar ve üçüncü taraf yazılımlar")}</h2>
      <p className="muted">{t("Zeyvola aşağıdaki üçüncü taraf bileşenlerle birlikte dağıtılır. Her bileşen kendi lisansına tabidir.")}</p>
      {error && <p className="note is-error"><Icon name="warning" size={14} />{t("Lisans bilgileri okunamadı: {msg}", { msg: error })}</p>}
      {info && (
        <>
          <div className={info.ownLicense ? 'license-own is-set' : 'license-own'}>
            <div><strong>{t("Zeyvola'nın kendi lisansı")}</strong><Badge tone={info.ownLicense ? 'success' : 'warning'}>{info.ownLicense ?? t("Henüz seçilmedi")}</Badge></div>
            {info.ownNotice?.map((l) => <p key={l} className="muted small">{l}</p>)}
            <p className="muted small">{info.ownLicense
              ? t("Kişiler ve şirketler ücretsiz kullanabilir. Lisans, Zeyvola ile yaptığınız videolar üzerinde hak iddia etmez ve ticari kullanımlarını sınırlamaz. İzin verilmeyen tek amaç, Zeyvola ile rekabet eden bir ürün sağlamaktır; Zeyvola'nın yerine geçecek şekilde sunulan bir ürün ücretsiz olsa da rakip sayılır. Bağlayıcı olan lisans metnidir.")
              : t("Uygulamanın kendi lisansı henüz belirlenmedi. Bu bölüm yalnızca üçüncü taraf bileşenleri listeler.")}</p>
          </div>

          <div className="license-list" role="list">
            {info.packages.map((p) => (
              <div key={p.name} className="license-row" role="listitem">
                <div className="license-head">
                  <strong>{p.name}</strong>
                  <span className="mono muted small">{p.version}</span>
                  <Badge tone="success">{p.license}</Badge>
                  <button type="button" className="link" aria-expanded={open === p.name} onClick={() => toggle(p.name)}>
                    {open === p.name ? t("Metni gizle") : t("Lisans metni")}
                  </button>
                </div>
                <span className="muted small">{p.copyright.join(' · ')}</span>
                {open === p.name && <pre className="license-text">{p.text}</pre>}
              </div>
            ))}
            <div className="license-row" role="listitem">
              <div className="license-head">
                <strong>Electron</strong>
                <span className="mono muted small">{info.electron.version}</span>
                <Badge tone="success">{info.electron.license}</Badge>
                <button type="button" className="link" aria-expanded={open === 'electron'} onClick={() => toggle('electron')}>
                  {open === 'electron' ? t("Metni gizle") : t("Lisans metni")}
                </button>
              </div>
              <span className="muted small">{info.electron.copyright.join(' · ')}</span>
              {open === 'electron' && <pre className="license-text">{info.electron.text}</pre>}
              <p className="muted small">{t("Electron; Chromium, Node.js, FFmpeg ve diğer bileşenleri içerir. Bu bileşenlerin {n} girişlik lisans bildirimi uygulamayla birlikte gelir.", { n: info.electron.chromiumEntries })}</p>
              <div className="row-actions">
                <Button size="sm" variant="ghost" icon="info" onClick={() => void api.openChromiumLicenses().catch((e: Error) => setError(e.message))}>{t("Chromium bileşen bildirimlerini aç")}</Button>
              </div>
            </div>
            {/* Shipped with Electron but missing from its Chromium notices. */}
            {(info.supplements ?? []).map((r) => (
              <div key={r.id} className="license-row" role="listitem">
                <div className="license-head">
                  <strong>{r.name}</strong>
                  <Badge tone="success">{r.license.split(';')[0]!.split('.')[0]!}</Badge>
                  {r.text && (
                    <button type="button" className="link" aria-expanded={open === r.id} onClick={() => toggle(r.id)}>
                      {open === r.id ? t("Metni gizle") : t("Lisans metni")}
                    </button>
                  )}
                </div>
                <span className="muted small">{r.version}</span>
                {!r.text && <span className="muted small">{r.license}</span>}
                {open === r.id && <pre className="license-text">{r.text}</pre>}
              </div>
            ))}
          </div>

          <h3 className="license-subhead">{t("Codec'ler: açık kaynak lisansı ve patent ayrıdır")}</h3>
          <p className="muted small">{t("Bir bileşenin açık kaynak lisansı, onu kullananlara patent lisansı vermez. Aşağıdaki patent notları çözülmüş değildir ve hukuki görüş yerine geçmez.")}</p>
          {info.distribution && (
            <p className="note small"><Icon name="info" size={14} />{info.distribution === 'webm'
              ? t("Bu sürüm WebM odaklı dağıtımdır: H.264, AAC ve HEVC kullanmaz; dışa aktarma VP9 + Opus ile yapılır.")
              : info.distribution === 'webm-vp8'
              ? t("Bu sürüm deneysel VP8 dağıtımıdır: H.264, AAC ve HEVC kullanmaz; kayıt ve dışa aktarma VP8 + Opus (WebM) ile yapılır.")
              : t("Bu sürüm MP4 destekli dağıtımdır: H.264 ve AAC yalnızca işletim sisteminin kendi kodlayıcılarıyla yazılır; kurulum paketinde H.264 ve AAC çözücüsü bulunmaz.")}</p>
          )}
          <div className="codec-list" role="list">
            {info.codecs.map((c) => (
              <div key={c.id} className="codec-row" role="listitem">
                <div className="license-head"><strong>{lang === 'tr' ? c.name : c.nameEn ?? c.name}</strong>{status(c)}</div>
                <dl>
                  <div><dt>{t("Nerede")}</dt><dd>{pick(c.where)}</dd></div>
                  <div><dt>{t("Açık kaynak lisansı")}</dt><dd>{pick(c.license)}</dd></div>
                  <div><dt>{t("Patent durumu")}</dt><dd>{pick(c.patent)}</dd></div>
                </dl>
              </div>
            ))}
          </div>
          <div className="row-actions">
            <Button size="sm" variant="ghost" icon="folder" onClick={() => void api.openThirdPartyNotices().catch((e: Error) => setError(e.message))}>{t("Tüm bildirimleri aç")}</Button>
          </div>
        </>
      )}
    </section>
  );
}
