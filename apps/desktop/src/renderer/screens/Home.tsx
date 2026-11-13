import { useEffect, useState } from 'react';
import type { ProjectSummary } from '@zeyvola/protocol';
import { TICKS_PER_SECOND } from '@zeyvola/timing';
import { api } from '../api';
import { Empty, IconButton } from '../ui/controls';
import { Icon, type IconName } from '../ui/icons';
import { APP_VERSION } from '../../shared/brand';
import { currentLocale, durationText, t } from '../i18n';

function relativeDate(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return t("az önce");
  if (diff < 3600) return t("{n} dk önce", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("{n} sa önce", { n: Math.floor(diff / 3600) });
  return d.toLocaleDateString(currentLocale(), { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function Home(props: { onNewRecording: (kind?: 'display' | 'window' | 'region') => void; onOpen: (id: string) => void; refreshKey: number }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listProjects().then(setProjects).catch((e) => setError((e as Error).message));
  useEffect(() => { void load(); }, [props.refreshKey]);

  const quick: { kind: 'display' | 'window' | 'region'; icon: IconName; title: string; text: string }[] = [
    { kind: 'display', icon: 'screen', title: t("Tüm ekran"), text: t("Bir monitörün tamamı") },
    { kind: 'window', icon: 'window', title: t("Pencere"), text: t("Tek bir uygulama penceresi") },
    { kind: 'region', icon: 'region', title: t("Bölge"), text: t("Seçtiğiniz bir alan") },
  ];

  return (
    <div className="home">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">{t("Yeni kayıt")}</span>
          <h1>{t("Ekranını ve kendini ayrı kaydet.")}<br /><span>{t("Zoom, kamera ve gizlemeyi sonra ayarla.")}</span></h1>
          <p>{t("Ekran, kamera ve mikrofon ayrı dosyalara kaydedilir. Kayıttan sonra her şey zaman çizelgesinde düzenlenebilir.")}</p>
        </div>
        <div className="hero-actions">
          <button type="button" className="record-cta" onClick={() => props.onNewRecording()}>
            <span className="record-cta-dot"><Icon name="record" size={22} /></span>
            <span className="record-cta-text"><strong>{t("Kayda başla")}</strong><small>{t("Kaynak, kamera ve mikrofon seç")}</small></span>
            <Icon name="chevronRight" size={18} />
          </button>
          <div className="quick-grid">
            {quick.map((q) => (
              <button key={q.kind} type="button" className="quick-card" onClick={() => props.onNewRecording(q.kind)}>
                <Icon name={q.icon} size={20} />
                <strong>{q.title}</strong>
                <small>{q.text}</small>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="projects">
        <header className="section-head">
          <h2>{t("Projeler")}</h2>
          <IconButton icon="refresh" label={t("Yenile")} onClick={() => void load()} />
        </header>
        {error && <p className="note is-error">{error}</p>}
        {projects && projects.length === 0 && (
          <Empty icon="film" title={t("Henüz proje yok")}>{t("İlk kaydınızı yaptığınızda burada görünecek.")}</Empty>
        )}
        <div className="project-grid">
          {projects?.map((p) => (
            <article key={p.id} className="project-card" onDoubleClick={() => props.onOpen(p.id)}>
              <button type="button" className="project-thumb" onClick={() => props.onOpen(p.id)} aria-label={t("{name} projesini aç", { name: p.name })}>
                {p.thumbnail ? <img src={p.thumbnail} alt="" /> : <span className="thumb-placeholder"><Icon name="film" size={24} /></span>}
                {p.durationTicks > 0 && <span className="duration-chip mono">{durationText(p.durationTicks / TICKS_PER_SECOND)}</span>}
              </button>
              <div className="project-meta">
                <div>
                  <strong title={p.name}>{p.name}</strong>
                  <small>{relativeDate(p.updatedAt)} · {bytes(p.sizeBytes)}</small>
                </div>
                <div className="menu-wrap">
                  <IconButton icon="more" label={t("Proje menüsü")} onClick={() => setMenu(menu === p.id ? null : p.id)} />
                  {menu === p.id && (
                    <div className="menu" onMouseLeave={() => setMenu(null)}>
                      <button type="button" onClick={() => { setMenu(null); props.onOpen(p.id); }}><Icon name="film" size={15} />{t("Aç")}</button>
                      <button type="button" onClick={() => { setMenu(null); void api.revealProject(p.id); }}><Icon name="folder" size={15} />{t("Klasörde göster")}</button>
                      <button type="button" className="danger" onClick={async () => { setMenu(null); await api.trashProject(p.id); void load(); }}><Icon name="trash" size={15} />{t("Çöp kutusuna taşı")}</button>
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
        {projects && projects.length > 0 && <p className="muted small footnote">{t("Projeler, kayıtlarınızla birlikte bilgisayarınızda saklanır. Hiçbir veri buluta gönderilmez.")}</p>}
      </section>
      {projects === null && !error && <div className="loading-line" />}
      <footer className="home-foot muted small"><Icon name="info" size={14} />{t("Sürüm {v}", { v: APP_VERSION })}</footer>
    </div>
  );
}
