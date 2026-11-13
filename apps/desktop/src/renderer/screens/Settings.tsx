import { useEffect, useState } from 'react';
import type { AppInfo, BackendInfo, PermissionInfo } from '@zeyvola/protocol';
import { APP_NAME, COPYRIGHT, DEVELOPER, DEVELOPER_ROLE, LICENSE_NAME, SOURCE_URL } from '../../shared/brand';
import type { LangSetting, SettingsInfo } from '../../shared/i18n';
import { api } from '../api';
import { Badge, Button, Kbd, Segmented } from '../ui/controls';
import { Icon } from '../ui/icons';
import { LicensesSection } from './Licenses';
import { t } from '../i18n';

/** Display name of a BCP 47 tag in its own language, e.g. "tr-TR" → "Türkçe (Türkiye)". */
function languageName(tag: string): string {
  try {
    const name = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    return name ? name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) : tag;
  } catch {
    return tag;
  }
}

function LanguageSection() {
  const [s, setS] = useState<SettingsInfo | null>(null);
  useEffect(() => {
    void api.getSettings().then(setS);
    return api.onSettingsChanged(setS);
  }, []);
  if (!s) return null;
  const system = s.system[0];
  return (
    <section>
      <h2>{t("Dil")}</h2>
      <p className="muted">{t("Uygulama ilk açılışta bilgisayarınızın diline göre ayarlanır. Dilediğiniz zaman değiştirebilirsiniz.")}</p>
      <div className="lang-card">
        <Segmented<LangSetting> value={s.language} label={t("Dil")}
          onChange={(language) => void api.setLanguage(language).then(setS)}
          options={[
            { value: 'auto', label: t("Otomatik") },
            { value: 'tr', label: 'Türkçe' },
            { value: 'en', label: 'English' },
          ]} />
        <p className="muted small">
          {system ? t("Bilgisayarın dili: {name}", { name: languageName(system) }) : t("Bilgisayarın dili algılanamadı.")}
          {s.language === 'auto' && <> · {t("Otomatik seçim: {lang}", { lang: s.resolved === 'tr' ? 'Türkçe' : 'English' })}</>}
        </p>
      </div>
    </section>
  );
}

export function Settings({ embedded = false }: { embedded?: boolean }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [perms, setPerms] = useState<PermissionInfo | null>(null);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const refresh = () => {
    void api.appInfo().then(setInfo);
    void api.permissions().then(setPerms);
    void api.backends().then(setBackends);
  };
  useEffect(refresh, []);
  const label = (s?: string) => (s === 'granted' ? t("İzin var") : s === 'denied' ? t("Reddedildi") : s === 'not-determined' ? t("Henüz sorulmadı") : s === 'restricted' ? t("Kısıtlı") : t("Bilinmiyor"));
  const tone = (s?: string) => (s === 'granted' ? 'success' : s === 'denied' ? 'record' : 'neutral') as 'success' | 'record' | 'neutral';
  const permCards: { key: keyof PermissionInfo; title: string; text: string; pane: 'screen' | 'camera' | 'microphone' | 'input'; request?: 'camera' | 'microphone' }[] = [
    { key: 'screen', title: t("Ekran kaydı"), text: t("Ekranınızı veya bir pencereyi kaydetmek için gerekir."), pane: 'screen' },
    { key: 'camera', title: t("Kamera"), text: t("Kendinizi ekrandan ayrı kaydetmek için."), pane: 'camera', request: 'camera' },
    { key: 'microphone', title: t("Mikrofon"), text: t("Sesinizi kaydetmek için."), pane: 'microphone', request: 'microphone' },
    { key: 'input', title: t("Fare olayları"), text: t("Tıklamalar otomatik zoom önerileri için yalnızca yerelde kaydedilir. Tuş vuruşları kaydedilmez."), pane: 'input' },
  ];
  return (
    <div className={`settings${embedded ? ' is-embedded' : ''}`}>
      <LanguageSection />
      <section>
        <h2>{t("İzinler")}</h2>
        <p className="muted">{t("İzinleri işletim sistemi yönetir. Değiştirmek için ilgili ayar sayfasını açabilirsiniz.")}</p>
        <div className="perm-grid">
          {permCards.map((c) => (
            <div key={c.key} className="perm-card">
              <header><strong>{c.title}</strong><Badge tone={tone(perms?.[c.key])}>{label(perms?.[c.key])}</Badge></header>
              <p className="muted small">{c.text}</p>
              <div className="row-actions">
                {c.request && perms?.[c.key] === 'not-determined' && <Button size="sm" onClick={async () => { await api.requestPermission(c.request!); refresh(); }}>{t("İzin iste")}</Button>}
                <Button size="sm" variant="ghost" icon="sliders" onClick={() => api.openPermissionSettings(c.pane)}>{t("Sistem ayarını aç")}</Button>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>{t("Kayıt yöntemleri")}</h2>
        <div className="perm-grid">
          {backends.map((b) => (
            <div key={b.id} className="perm-card">
              <header><strong>{b.id === 'web' ? t("Tarayıcı yedek kaydı") : b.id === 'native-macos' ? t("Yerel kayıt (macOS)") : t("Yerel kayıt (Windows)")}</strong><Badge tone={b.available ? 'success' : 'neutral'}>{b.available ? t("Kullanılabilir") : t("Kullanılamıyor")}</Badge></header>
              {b.reason && <p className="muted small">{b.reason}</p>}
              <ul className="caps">
                <li className={b.capabilities.separateCursor ? 'ok' : ''}>{t("İmleç ayrı kayıt")}</li>
                <li className={b.capabilities.clicks ? 'ok' : ''}>{t("Tıklama verisi")}</li>
                <li className={b.capabilities.systemAudio ? 'ok' : ''}>{t("Sistem sesi")}</li>
              </ul>
            </div>
          ))}
        </div>
      </section>
      <section>
        <h2>{t("Kısayollar")}</h2>
        <dl className="shortcut-list">
          <div><dt><Kbd>⌥⇧S</Kbd></dt><dd>{t("Kaydı bitir")}</dd></div>
          <div><dt><Kbd>⌥⇧P</Kbd></dt><dd>{t("Kaydı duraklat / devam ettir")}</dd></div>
          <div><dt><Kbd>⌥⇧M</Kbd></dt><dd>{t("Kayıt sırasında işaret koy (zoom için ipucu olur)")}</dd></div>
          <div><dt><Kbd>?</Kbd></dt><dd>{t("Düzenleyicide tüm kısayollar")}</dd></div>
        </dl>
      </section>
      <section>
        <h2>{t("Depolama ve gizlilik")}</h2>
        <p className="muted small"><Icon name="folder" size={14} /> {t("Projeler:")} <code>{info?.projectsRoot}</code></p>
        <p className="muted small"><Icon name="shield" size={14} /> {t("Kayıtlar, imleç ve tıklama verileri yalnızca bu bilgisayarda saklanır. Uygulama ağ isteği yapmaz ve telemetri göndermez.")}</p>
      </section>
      <LicensesSection />
      <section>
        <h2>{t("Hakkında")}</h2>
        <p className="about-name"><strong>{APP_NAME}</strong> <span className="mono muted small">{info?.version}</span></p>
        <p className="muted small">{t("Geliştirici:")} {DEVELOPER} — {DEVELOPER_ROLE}</p>
        <p className="muted small">{COPYRIGHT} · {LICENSE_NAME} · <span className="mono">{SOURCE_URL}</span></p>
        <p className="muted small mono">Electron {info?.electron} · Chromium {info?.chrome} · {info?.platform} {info?.arch} · {info?.osVersion}</p>
        <p className="muted small">{t("Üçüncü taraf bileşenler kendi lisanslarıyla dağıtılır; lisansları yukarıdaki “Lisanslar ve üçüncü taraf yazılımlar” bölümündedir.")}</p>
      </section>
    </div>
  );
}
