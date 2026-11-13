import { useEffect, useState } from 'react';
import type { CaptureState, OpenedProject, RecoveryNotice } from '@zeyvola/protocol';
import { api } from './api';
import { t, useLang } from './i18n';
import { Editor } from './screens/editor/Editor';
import { Home } from './screens/Home';
import { NewRecording } from './screens/NewRecording';
import { Settings } from './screens/Settings';
import { Button, Segmented } from './ui/controls';
import { BrandMark, Icon } from './ui/icons';

type Route =
  | { name: 'home' }
  | { name: 'settings' }
  | { name: 'new'; kind?: 'display' | 'window' | 'region' }
  | { name: 'editor'; opened: OpenedProject };

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function App() {
  useLang(); // re-render the whole tree when the language changes
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recoveries, setRecoveries] = useState<RecoveryNotice[]>([]);

  useEffect(() => {
    void api.captureState().then(setCapture);
    void api.recoveries().then(setRecoveries);
    const off1 = api.onCaptureState(setCapture);
    const off3 = api.onRecovered((list) => {
      setRecoveries(list);
      setRefreshKey((k) => k + 1);
    });
    const off2 = api.onCaptureFinished(async (r) => {
      try {
        const opened = await api.openProject(r.projectId);
        setRoute({ name: 'editor', opened });
      } catch (e) {
        setError((e as Error).message);
      }
      setRefreshKey((k) => k + 1);
    });
    // Test hooks (only in --smoke mode).
    const onSmoke = (e: Event) => { if (document.documentElement.dataset.smoke === '1') void open((e as CustomEvent<string>).detail); };
    window.addEventListener('zeyvola:smoke-open', onSmoke);
    return () => { off1(); off2(); off3(); window.removeEventListener('zeyvola:smoke-open', onSmoke); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const open = async (id: string) => {
    try {
      setRoute({ name: 'editor', opened: await api.openProject(id) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // The setup screen stays mounted through preparing/countdown so its camera preview keeps
  // the device alive until the recorder has taken it over.
  const recording = capture && (capture.phase === 'recording' || capture.phase === 'paused' || capture.phase === 'finishing');

  if (route.name === 'editor') {
    // A recording just rebuilt after a crash: say so once in the editor.
    const recovered = recoveries.find((r) => r.projectId === route.opened.id);
    return <Editor key={route.opened.id} opened={route.opened} notice={recovered?.message}
      onNoticeShown={() => { if (recovered) void api.dismissRecovery(recovered.recordingId); }}
      onBack={() => { setRoute({ name: 'home' }); setRefreshKey((k) => k + 1); }} />;
  }

  return (
    <div className="shell">
      <header className="topbar drag">
        <div className="brand no-drag"><BrandMark /><span>{t("Zeyvola")}</span></div>
        <nav className="no-drag">
          <Segmented<'home' | 'settings'> size="sm" label={t("Bölüm")} value={route.name === 'settings' ? 'settings' : 'home'}
            onChange={(v) => setRoute(v === 'home' ? { name: 'home' } : { name: 'settings' })} options={[{ value: 'home', label: t("Projeler"), icon: 'film' }, { value: 'settings', label: t("Ayarlar"), icon: 'sliders' }]} />
        </nav>
        <div className="topbar-right no-drag" />
      </header>
      {error && <div className="banner is-error"><Icon name="warning" size={15} />{error}<button className="link" onClick={() => setError(null)}>{t("Kapat")}</button></div>}
      {recoveries.map((r) => (
        <div key={r.recordingId} className="banner is-info" role="status"><Icon name="info" size={15} />{r.message}
          <span className="banner-actions">
            <button className="link" onClick={() => void open(r.projectId)}>{t("Projeyi aç")}</button>
            <button className="link" onClick={() => void api.dismissRecovery(r.recordingId)}>{t("Kapat")}</button>
          </span></div>
      ))}
      {capture?.phase === 'error' && (
        <div className="banner is-error"><Icon name="warning" size={15} />{t("Kayıt hatası:")} {capture.message}
          <button className="link" onClick={() => void api.dismissCaptureError()}>{t("Kapat")}</button></div>
      )}
      <main className="shell-main">
        {recording ? (
          <div className="recording-live">
            <span className="live-dot" />
            <h1>{capture.phase === 'countdown' ? t("Kayıt {n} saniye içinde başlıyor", { n: capture.countdown }) : capture.phase === 'finishing' ? t("Kayıt kaydediliyor…") : capture.phase === 'paused' ? t("Kayıt duraklatıldı") : t("Kayıt sürüyor")}</h1>
            <p className="mono big">{formatElapsed(capture.elapsedMs)}</p>
            <div className="row-actions center">
              {capture.phase === 'recording' && <Button icon="pause" onClick={() => void api.pauseCapture()}>{t("Duraklat")}</Button>}
              {capture.phase === 'paused' && <Button icon="play" onClick={() => void api.resumeCapture()}>{t("Devam et")}</Button>}
              <Button variant="record" icon="stop" onClick={() => void api.stopCapture()} disabled={capture.phase === 'finishing'}>{t("Bitir")}</Button>
              <Button variant="ghost" onClick={() => void api.cancelCapture()} disabled={capture.phase === 'finishing'}>{t("İptal")}</Button>
            </div>
            {capture.message && <p className="note is-warning">{capture.message}</p>}
          </div>
        ) : route.name === 'new' ? (
          <NewRecording initialKind={route.kind} onBack={() => setRoute({ name: 'home' })} onStarted={() => undefined} />
        ) : route.name === 'settings' ? (
          <Settings />
        ) : (
          <Home refreshKey={refreshKey} onNewRecording={(kind) => setRoute({ name: 'new', kind })} onOpen={open} />
        )}
      </main>
    </div>
  );
}
