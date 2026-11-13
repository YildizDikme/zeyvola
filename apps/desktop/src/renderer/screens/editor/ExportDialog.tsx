import { useEffect, useRef, useState } from 'react';
import { itemTimelineRanges, layoutSegments, type ID } from '@zeyvola/project-model';
import { formatTimecode, frameDuration } from '@zeyvola/timing';
import { api } from '../../api';
import type { ExportTarget } from '@zeyvola/protocol';
import {
  checkExportSupport, exportBaseName, ExportMedia, outputSize, renderStill, runExport, type ExportFormat, type ExportOptions, type ExportProgress, type ExportSupport,
} from '../../export/exporter';
import type { Player } from '../../playback/player';
import { useEditor, type EditorStore } from '../../state/editor-store';
import { Button, IconButton, Segmented, Toggle } from '../../ui/controls';
import { Icon } from '../../ui/icons';
import { durationText, t } from '../../i18n';
import { PROFILE } from '../../../shared/distribution';

interface Check { id: ID; label: string; frames: { label: string; src: string | null }[] }

export function ExportDialog({ store, onClose }: { store: EditorStore; player: Player; onClose: () => void }) {
  const project = useEditor(store, (s) => s.project);
  const cursors = useEditor(store, (s) => s.cursors);
  const mediaBase = useEditor(store, (s) => s.mediaBase);
  const [variantId, setVariantId] = useState(project.activeVariantId);
  const [format, setFormat] = useState<ExportFormat>(PROFILE.defaultExport);
  const [resolution, setResolution] = useState<'1080' | '2160'>('1080');
  const [fps, setFps] = useState<30 | 60>(project.sequence.fps.num >= 50 ? 60 : 30);
  const [quality, setQuality] = useState<'standard' | 'high'>('high');
  const [audio, setAudio] = useState(true);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [confirmed, setConfirmed] = useState(project.privacy.length === 0);
  const abort = useRef<AbortController | null>(null);
  const size = outputSize(project, { variantId, resolution });
  const busy = progress && ['preparing', 'audio', 'video', 'finishing'].includes(progress.phase);
  // Where the file goes: main's default folder (last chosen, else Movies) until the user picks a
  // place with the system save dialog. A target is used once; a new one is fetched after each export.
  const [target, setTarget] = useState<ExportTarget | null>(null);
  const [customName, setCustomName] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [targetRound, setTargetRound] = useState(0);
  const [support, setSupport] = useState<ExportSupport | null>(null);
  const baseName = customName ?? exportBaseName(project, variantId);

  useEffect(() => {
    if (busy) return;
    let live = true;
    api.exportDefaultTarget(project.id, baseName, format)
      .then((tg) => { if (live) { setTarget(tg); setTargetError(null); } })
      .catch((e: Error) => { if (live) setTargetError(e.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetched only when the name, format or round changes
  }, [project.id, baseName, format, targetRound]);

  // Can this device write the chosen format at all? Asked before the export, never discovered halfway.
  useEffect(() => {
    let live = true;
    setSupport(null);
    void checkExportSupport(project, { variantId, format, resolution, fps, quality, includeAudio: audio }).then((r) => { if (live) setSupport(r); });
    return () => { live = false; };
  }, [project, variantId, format, resolution, fps, quality, audio]);

  const chooseTarget = async () => {
    try {
      const tg = await api.exportChooseTarget(project.id, baseName, format);
      if (!tg) return;
      setTarget(tg);
      setTargetError(null);
      setCustomName(tg.name.replace(/\.[^.]+$/, ''));
    } catch (e) {
      setTargetError((e as Error).message);
    }
  };

  // Privacy check strip: frames around every hidden region's boundaries.
  useEffect(() => {
    let cancelled = false;
    const media = new ExportMedia(mediaBase);
    void (async () => {
      const placements = layoutSegments(project);
      const fd = frameDuration(project.sequence.fps);
      const out: Check[] = [];
      for (const [i, item] of project.privacy.entries()) {
        for (const r of itemTimelineRanges(project, item, placements)) {
          const frames = [
            { label: t("Önce"), t: Math.max(0, r.start - fd) },
            { label: t("İlk kare"), t: r.start },
            { label: t("Son kare"), t: Math.max(r.start, r.end - fd) },
            { label: t("Sonra"), t: r.end },
          ];
          const check: Check = { id: `${item.id}-${r.start}`, label: t("Alan {n} · {from}–{to}", { n: i + 1, from: formatTimecode(r.start), to: formatTimecode(r.end) }), frames: frames.map((f) => ({ label: f.label, src: null })) };
          out.push(check);
          for (const [k, f] of frames.entries()) {
            if (cancelled) return;
            try {
              check.frames[k]!.src = await renderStill(project, cursors, mediaBase, f.t, variantId, { width: 240, height: Math.round(240 * size.height / size.width) }, media);
            } catch { /* leave empty */ }
            if (!cancelled) setChecks([...out]);
          }
        }
      }
      if (!cancelled) setChecks([...out]);
    })();
    return () => { cancelled = true; media.dispose(); };
  }, [project, cursors, mediaBase, variantId, size.width, size.height]);

  const start = async () => {
    if (!target) return;
    abort.current = new AbortController();
    const opts: ExportOptions = { variantId, format, resolution, fps, quality, includeAudio: audio, target };
    setProgress({ phase: 'preparing', frame: 0, total: 0, rate: 0, etaSeconds: 0 });
    try {
      await runExport(project, cursors, mediaBase, opts, setProgress, abort.current.signal);
    } catch (e) {
      setProgress({ phase: 'error', frame: 0, total: 0, rate: 0, etaSeconds: 0, message: (e as Error).message });
    } finally {
      // The token was spent; the next export gets a fresh, unused name in the same folder.
      setTarget(null);
      setTargetRound((n) => n + 1);
    }
  };
  const canStart = confirmed && !!target && support?.ok === true;

  // Leaving the editor stops a running export; its partial file is deleted.
  useEffect(() => () => abort.current?.abort(), []);

  const pct = progress && progress.total > 0 ? progress.frame / progress.total : 0;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal export-modal" role="dialog" aria-label={t("Dışa aktar")}>
        <header>
          <div><h2>{t("Dışa aktar")}</h2><p className="muted">{t("Tüm zoom, kamera, tema ve gizleme efektleri önizlemedeki gibi uygulanır.")}</p></div>
          <IconButton icon="close" label={t("Kapat")} onClick={onClose} disabled={!!busy} />
        </header>
        <div className="export-grid">
          <div className="export-options">
            <label className="field-label">{t("Format")}</label>
            <Segmented<string> value={variantId} onChange={setVariantId} options={project.variants.map((v) => ({ value: v.id, label: v.name }))} label={t("Format")} />
            <label className="field-label">{t("Dosya türü")}</label>
            <Segmented<ExportFormat> value={format} onChange={setFormat} label={t("Dosya türü")}
              options={PROFILE.formats.map((f) => ({
                value: f,
                label: f === 'mp4' ? t("MP4 · H.264") : PROFILE.id === 'webm-vp8' ? t("WebM · VP8") : t("WebM · VP9"),
              }))} />
            <p className="note small"><Icon name="info" size={14} />{format === 'webm'
              ? PROFILE.id === 'webm-vp8'
                ? t("Deneysel: telifsiz VP8 + Opus. YouTube ve tarayıcılar destekler; aynı görüntü kalitesi için dosya VP9’dan büyüktür.")
                : t("Telifsiz codec’ler (VP9 + Opus). YouTube ve tarayıcılar destekler.")
              : t("En geniş uyumluluk: QuickTime, Windows ve telefonlar açar. H.264 ve AAC, işletim sisteminin kendi kodlayıcısıyla yazılır; bu codec’ler patentlidir, ayrıntılar Lisanslar bölümünde.")}</p>
            <label className="field-label">{t("Çözünürlük")}</label>
            <Segmented<'1080' | '2160'> value={resolution} onChange={setResolution} label={t("Çözünürlük")} options={[{ value: '1080', label: t("1080p") }, { value: '2160', label: t("4K") }]} />
            <label className="field-label">{t("Kare hızı")}</label>
            <Segmented<'30' | '60'> value={String(fps) as '30' | '60'} onChange={(v) => setFps(Number(v) as 30 | 60)} label={t("Kare hızı")} options={[{ value: '30', label: t("30 fps") }, { value: '60', label: t("60 fps") }]} />
            <label className="field-label">{t("Kalite")}</label>
            <Segmented<'standard' | 'high'> value={quality} onChange={setQuality} label={t("Kalite")} options={[{ value: 'standard', label: t("Standart") }, { value: 'high', label: t("Yüksek") }]} />
            <Toggle label={t("Sesi dahil et")} checked={audio} onChange={setAudio} />
            <p className="muted small mono">{size.width}×{size.height} · {fps} fps</p>
            {support && !support.ok && (
              <div className="note is-error export-unsupported">
                <Icon name="warning" size={14} />
                <div>
                  <span>{support.message}</span>
                  {support.suggestWebm && <Button size="sm" onClick={() => setFormat('webm')} disabled={!!busy}>{t("WebM’e geç")}</Button>}
                </div>
              </div>
            )}
            <label className="field-label">{t("Kaydedilecek yer")}</label>
            <div className="export-target">
              <Icon name="folder" size={16} />
              <div className="export-target-text" title={target ? `${target.folder}/${target.name}` : undefined}>
                <strong>{target?.name ?? '…'}</strong>
                <span className="muted small" dir="rtl"><bdi dir="ltr">{target?.folder ?? ''}</bdi></span>
              </div>
              <Button size="sm" onClick={chooseTarget} disabled={!!busy}>{t("Değiştir…")}</Button>
            </div>
            {targetError && <p className="note is-error small"><Icon name="warning" size={14} />{targetError}</p>}
          </div>
          <div className="export-side">
            {project.privacy.length > 0 ? (
              <>
                <h3><Icon name="shield" size={16} /> {t("Gizlilik kontrolü")}</h3>
                <p className="muted small">{t("Her gizleme alanının sınır karelerini kontrol edin. \"İlk kare\" ve \"Son kare\" gizlenmiş olmalı.")}</p>
                <div className="privacy-checks">
                  {checks.map((c) => (
                    <div key={c.id} className="privacy-check">
                      <span className="small">{c.label}</span>
                      <div className="check-frames">
                        {c.frames.map((f) => (
                          <figure key={f.label} className={f.label === t("İlk kare") || f.label === t("Son kare") ? 'is-inside' : ''}>
                            {f.src ? <img src={f.src} alt={f.label} /> : <span className="thumb-wait" />}
                            <figcaption>{f.label}</figcaption>
                          </figure>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <Toggle label={t("Gizleme alanlarını kontrol ettim")} checked={confirmed} onChange={setConfirmed} />
              </>
            ) : (
              <p className="note"><Icon name="shield" size={14} />{t("Bu projede gizleme alanı yok.")}</p>
            )}
            <p className="note small is-warning"><Icon name="warning" size={14} />{t("Düzenlenmemiş orijinal kayıtlar proje klasöründe durur ve hassas bilgi içerebilir. Paylaşırken yalnızca dışa aktarılan dosyayı paylaşın.")}</p>
          </div>
        </div>
        <footer>
          {progress ? (
            <div className="export-progress">
              {progress.phase === 'done' ? (
                <div className="export-done">
                  <Icon name="check" size={18} />
                  <span title={progress.path}>{t("Hazır")}{progress.bytes ? ` · ${(progress.bytes / 1024 / 1024).toFixed(1)} MB` : ''}</span>
                  {progress.path && <Button size="sm" icon="folder" onClick={() => api.showItem(progress.path!)}>{t("Klasörde göster")}</Button>}
                </div>
              ) : progress.phase === 'error' ? (
                <p className="note is-error"><Icon name="warning" size={14} />{progress.message}</p>
              ) : progress.phase === 'cancelled' ? (
                <span className="muted">{t("İptal edildi; yarım dosya silindi.")}</span>
              ) : (
                <>
                  <div className="bar"><span style={{ width: `${pct * 100}%` }} /></div>
                  <span className="muted small mono">
                    {progress.phase === 'audio' ? t("Ses hazırlanıyor…") : progress.phase === 'finishing' ? t("Dosya tamamlanıyor…") : t("{frame}/{total} kare · {rate} kare/sn · kalan {eta}", { frame: progress.frame, total: progress.total, rate: progress.rate.toFixed(1), eta: durationText(progress.etaSeconds) })}
                    {progress.encoder ? ` · ${progress.encoder}` : ''}
                  </span>
                </>
              )}
            </div>
          ) : <span />}
          <div className="footer-actions">
            {busy
              ? <Button variant="secondary" onClick={() => abort.current?.abort()}>{t("İptal")}</Button>
              : <Button variant="primary" icon="export" onClick={start} disabled={!canStart}>{t("Dışa aktar")}</Button>}
          </div>
        </footer>
      </div>
    </div>
  );
}
