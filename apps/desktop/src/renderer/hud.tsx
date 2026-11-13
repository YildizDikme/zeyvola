import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CaptureState } from '@zeyvola/protocol';
import { api } from './api';
import { initI18n, t, useLang } from './i18n';
import { Icon } from './ui/icons';
import { keyLabel, RECORDING_KEYS } from './ui/keys';
import './styles/tokens.css';
import './styles/hud.css';

function Hud() {
  useLang();
  const [s, setS] = useState<CaptureState | null>(null);
  useEffect(() => {
    void api.captureState().then(setS);
    return api.onCaptureState(setS);
  }, []);
  if (!s) return null;
  if (s.phase === 'countdown') {
    return (
      <div className="hud hud-countdown drag">
        <span className="count" key={s.countdown}>{s.countdown}</span>
        <span>{t("Kayıt başlıyor")}</span>
        <button type="button" className="hud-btn no-drag" onClick={() => void api.cancelCapture()} title={t("İptal")}><Icon name="close" size={16} /></button>
      </div>
    );
  }
  const sec = Math.floor(s.elapsedMs / 1000);
  const time = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const paused = s.phase === 'paused';
  return (
    <div className={`hud drag${paused ? ' is-paused' : ''}`}>
      <span className="rec-dot" />
      <span className="time mono">{time}</span>
      <span className="level" aria-label={t("Mikrofon seviyesi")}><span style={{ transform: `scaleX(${Math.max(0.04, s.micLevel)})` }} /></span>
      <span className="sep" />
      {paused
        ? <button type="button" className="hud-btn no-drag" onClick={() => void api.resumeCapture()} title={t("Devam et ({key})", { key: keyLabel(RECORDING_KEYS.pause) })}><Icon name="play" size={16} /></button>
        : <button type="button" className="hud-btn no-drag" onClick={() => void api.pauseCapture()} title={t("Duraklat ({key})", { key: keyLabel(RECORDING_KEYS.pause) })} disabled={s.phase !== 'recording'}><Icon name="pause" size={16} /></button>}
      <button type="button" className="hud-btn no-drag" onClick={() => void api.markCapture()} title={t("İşaret koy ({key})", { key: keyLabel(RECORDING_KEYS.mark) })} disabled={s.phase !== 'recording'}><Icon name="marker" size={16} /></button>
      <button type="button" className="hud-btn stop no-drag" onClick={() => void api.stopCapture()} title={t("Bitir ({key})", { key: keyLabel(RECORDING_KEYS.stop) })} disabled={s.phase === 'finishing'}><Icon name="stop" size={16} /><span>{t("Bitir")}</span></button>
      <button type="button" className="hud-btn no-drag" onClick={() => void api.cancelCapture()} title={t("İptal et")} disabled={s.phase === 'finishing'}><Icon name="close" size={15} /></button>
    </div>
  );
}

void initI18n().finally(() => createRoot(document.getElementById('root')!).render(<StrictMode><Hud /></StrictMode>));
