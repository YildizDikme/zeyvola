import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackendInfo, CaptureConfig, PermissionInfo, SourceInfo } from '@zeyvola/protocol';
import { api } from '../api';
import { Badge, Button, IconButton, Segmented, Select, Toggle } from '../ui/controls';
import { Icon } from '../ui/icons';
import { t } from '../i18n';

type Kind = 'display' | 'window' | 'region';
interface Region { x: number; y: number; w: number; h: number }

function useDevices(kind: 'videoinput' | 'audioinput', enabled: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(async () => {
    const all = await navigator.mediaDevices.enumerateDevices();
    setDevices(all.filter((d) => d.kind === kind && d.deviceId));
  }, [kind]);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [enabled, refresh]);
  return { devices, refresh };
}

export function NewRecording(props: { initialKind?: Kind; onBack: () => void; onStarted: () => void }) {
  const [kind, setKind] = useState<Kind>(props.initialKind ?? 'display');
  const [sources, setSources] = useState<SourceInfo[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [perms, setPerms] = useState<PermissionInfo | null>(null);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [backend, setBackend] = useState<'auto' | 'native' | 'web'>('auto');
  const [cameraOn, setCameraOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [cameraId, setCameraId] = useState<string>('');
  const [micId, setMicId] = useState<string>('');
  const [systemAudio, setSystemAudio] = useState(true);
  const [fps, setFps] = useState<30 | 60>(60);
  const [quality, setQuality] = useState<'standard' | 'high' | 'max'>('high');
  const [countdown, setCountdown] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [level, setLevel] = useState(0);
  const camVideo = useRef<HTMLVideoElement>(null);
  const streams = useRef<MediaStream[]>([]);
  const cams = useDevices('videoinput', cameraOn);
  const mics = useDevices('audioinput', micOn);

  const loadSources = useCallback(async () => {
    setSources(null);
    try {
      const list = await api.sources();
      setSources(list);
      setPerms(await api.permissions());
    } catch (e) {
      // Without screen recording permission the system refuses the list. Show the permission note
      // instead of loading forever; any other failure is reported as it is.
      setSources([]);
      const p = await api.permissions().catch(() => null);
      setPerms(p);
      if (p?.screen === 'granted') setError(t("Kaynaklar alınamadı: {msg}", { msg: (e as Error).message }));
    }
  }, []);

  useEffect(() => {
    void loadSources();
    void api.backends().then(setBackends);
  }, [loadSources]);

  const visible = (sources ?? []).filter((s) => (kind === 'window' ? s.kind === 'window' : s.kind === 'display'));
  useEffect(() => {
    if (!visible.some((s) => s.id === selected)) setSelected(visible[0]?.id ?? null);
  }, [kind, sources]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!cameraId && cams.devices[0]) setCameraId(cams.devices[0].deviceId); }, [cams.devices, cameraId]);
  useEffect(() => { if (!micId && mics.devices[0]) setMicId(mics.devices[0].deviceId); }, [mics.devices, micId]);

  const stopPreviews = () => {
    for (const s of streams.current) for (const t of s.getTracks()) t.stop();
    streams.current = [];
  };

  // The preview keeps the camera on until the recorder has opened and warmed it up, so the
  // device never switches off between preview and recording. If the recorder cannot open a
  // device the preview holds (exclusive cameras on Windows), it asks us to let go.
  useEffect(() => {
    const offState = api.onCaptureState((s) => {
      if (s.devicesReady || s.phase === 'recording') stopPreviews();
      if (s.phase === 'error' || s.phase === 'idle') setStarting(false);
    });
    const offRelease = api.onReleaseDevices(stopPreviews);
    return () => { offState(); offRelease(); };
  }, []);

  // Camera preview (released before recording so the capture backend can open the device).
  useEffect(() => {
    if (!cameraOn) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    void navigator.mediaDevices.getUserMedia({ video: cameraId ? { deviceId: { exact: cameraId }, width: { ideal: 640 } } : { width: { ideal: 640 } } })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        streams.current.push(s);
        if (camVideo.current) camVideo.current.srcObject = s;
        void cams.refresh();
        // The preview runs, so access was granted (perhaps just now, in the system's own dialog).
        setPerms((p) => (p ? { ...p, camera: 'granted' } : p));
      })
      .catch(() => setPerms((p) => (p ? { ...p, camera: 'denied' } : p)));
    return () => { cancelled = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [cameraOn, cameraId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Microphone level meter.
  useEffect(() => {
    if (!micOn) { setLevel(0); return; }
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    void navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true }).then((s) => {
      if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      streams.current.push(s);
      void mics.refresh();
      setPerms((p) => (p ? { ...p, microphone: 'granted' } : p));
      ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(an);
      const data = new Float32Array(an.fftSize);
      const tick = () => {
        an.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
        raf = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => setPerms((p) => (p ? { ...p, microphone: 'denied' } : p)));
    return () => { cancelled = true; cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); void ctx?.close(); };
  }, [micOn, micId]); // eslint-disable-line react-hooks/exhaustive-deps

  const native = backends.find((b) => b.id === 'native-macos' || b.id === 'native-windows');
  const effective = backend === 'web' || (backend === 'auto' && !native?.available) ? backends.find((b) => b.id === 'web') : native;
  const systemAudioSupported = !!effective?.capabilities.systemAudio;
  const source = visible.find((s) => s.id === selected);

  const start = async () => {
    if (!source) return;
    setError(null);
    setStarting(true);
    const cam = cams.devices.find((d) => d.deviceId === cameraId);
    const mic = mics.devices.find((d) => d.deviceId === micId);
    const r = kind === 'region' && region && source.bounds
      ? { x: Math.round(region.x * source.bounds.w), y: Math.round(region.y * source.bounds.h), w: Math.round(region.w * source.bounds.w), h: Math.round(region.h * source.bounds.h) }
      : undefined;
    const config: CaptureConfig = {
      target: { kind, sourceId: source.id, displayId: source.displayId, label: source.name, ...(r ? { region: r } : {}) },
      cameraDeviceId: cameraOn && cam ? cam.deviceId : null,
      cameraLabel: cameraOn && cam ? cam.label : null,
      micDeviceId: micOn && mic ? mic.deviceId : null,
      micLabel: micOn && mic ? mic.label : null,
      systemAudio: systemAudio && systemAudioSupported,
      fps, quality, countdown, backend,
    };
    try {
      props.onStarted();
      await api.startCapture(config);
    } catch (e) {
      setError((e as Error).message);
      setStarting(false);
    }
  };

  const permRow = (label: string, key: keyof PermissionInfo, pane: 'screen' | 'camera' | 'microphone' | 'input') => {
    const st = perms?.[key] ?? 'unknown';
    const ok = st === 'granted';
    return (
      <div className="perm-row">
        <span className={`perm-dot is-${ok ? 'ok' : st === 'denied' ? 'bad' : 'unknown'}`} />
        <span>{label}</span>
        <small className="muted">{ok ? t("İzin var") : st === 'denied' ? t("Reddedildi") : st === 'not-determined' ? t("Sorulmadı") : t("Bilinmiyor")}</small>
        {!ok && <button type="button" className="link" onClick={() => api.openPermissionSettings(pane)}>{t("Ayarları aç")}</button>}
      </div>
    );
  };

  return (
    <div className="new-recording">
      <header className="page-head">
        <IconButton icon="back" label={t("Geri")} onClick={() => { stopPreviews(); props.onBack(); }} />
        <h1>{t("Yeni kayıt")}</h1>
      </header>
      <div className="nr-grid">
        <section className="nr-sources">
          <div className="nr-toolbar">
            <Segmented<Kind> value={kind} onChange={setKind} label={t("Kayıt türü")}
              options={[{ value: 'display', label: t("Ekran"), icon: 'screen' }, { value: 'window', label: t("Pencere"), icon: 'window' }, { value: 'region', label: t("Bölge"), icon: 'region' }]} />
            <IconButton icon="refresh" label={t("Kaynakları yenile")} onClick={() => void loadSources()} />
          </div>
          {sources === null && <div className="loading-line" />}
          {sources && visible.length === 0 && (
            <div className="note is-warning"><Icon name="warning" size={14} />
              {perms?.screen === 'denied'
                ? t("Ekran kaydı izni yok. Sistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Ses Kaydı bölümünde Zeyvola'yı açın, sonra Zeyvola'yı yeniden başlatın. Zeyvola listede açık görünüyorsa (ör. bir güncellemeden sonra), onu \"–\" ile listeden kaldırıp yeniden izin verin.")
                : t("Kaynak bulunamadı. macOS'ta Sistem Ayarları › Gizlilik ve Güvenlik › Ekran Kaydı bölümünden izin vermeniz gerekebilir.")}
              <button type="button" className="link" onClick={() => api.openPermissionSettings('screen')}>{t("Ayarları aç")}</button>
              {perms?.screen === 'denied' && <button type="button" className="link" onClick={() => void api.relaunch()}>{t("Yeniden başlat")}</button>}
            </div>
          )}
          {kind === 'region' && source ? (
            <RegionPicker source={source} region={region} onChange={setRegion} others={visible} onSelect={setSelected} />
          ) : (
            <div className="source-grid">
              {visible.map((s) => (
                <button key={s.id} type="button" className={`source-card${s.id === selected ? ' is-on' : ''}`} onClick={() => setSelected(s.id)}>
                  <span className="source-thumb">{s.thumbnail ? <img src={s.thumbnail} alt="" /> : <Icon name={s.kind === 'window' ? 'window' : 'screen'} size={28} />}</span>
                  <span className="source-name">{s.appIcon && <img src={s.appIcon} alt="" className="app-icon" />}{s.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="nr-side">
          <div className="nr-card">
            <header><Icon name="camera" size={16} /><strong>{t("Kamera")}</strong><Toggle label="" checked={cameraOn} onChange={setCameraOn} /></header>
            {cameraOn && (
              <>
                <div className="cam-preview"><video ref={camVideo} autoPlay muted playsInline /></div>
                <Select label={t("Aygıt")} value={cameraId} onChange={setCameraId} options={cams.devices.map((d) => ({ value: d.deviceId, label: d.label || t("Kamera") }))} />
                <p className="muted small">{t("Kamera ekrandan ayrı kaydedilir; konumu ve şekli sonradan değişir.")}</p>
              </>
            )}
          </div>
          <div className="nr-card">
            <header><Icon name="mic" size={16} /><strong>{t("Mikrofon")}</strong><Toggle label="" checked={micOn} onChange={setMicOn} /></header>
            {micOn && (
              <>
                <Select label={t("Aygıt")} value={micId} onChange={setMicId} options={mics.devices.map((d) => ({ value: d.deviceId, label: d.label || t("Mikrofon") }))} />
                <div className="meter" aria-label={t("Mikrofon seviyesi")}><span style={{ width: `${level * 100}%` }} /></div>
              </>
            )}
          </div>
          <div className="nr-card">
            <header><Icon name="speaker" size={16} /><strong>{t("Sistem sesi")}</strong><Toggle label="" checked={systemAudio && systemAudioSupported} disabled={!systemAudioSupported} onChange={setSystemAudio} /></header>
            {!systemAudioSupported && (
              <p className="muted small">
                {window.zeyvola.platform === 'darwin'
                  ? t("macOS’ta bilgisayarın kendi sesi bu sürümde kaydedilemiyor. Mikrofon, kamera ve ekran kaydı normal çalışır.")
                  : t("Bu kayıt yönteminde bilgisayarın sesi kaydedilemiyor.")}
              </p>
            )}
          </div>
          <div className="nr-card">
            <header><Icon name="sliders" size={16} /><strong>{t("Kalite")}</strong></header>
            <Segmented<'30' | '60'> size="sm" label={t("Kare hızı")} value={String(fps) as '30' | '60'} onChange={(v) => setFps(Number(v) as 30 | 60)} options={[{ value: '30', label: t("30 fps") }, { value: '60', label: t("60 fps") }]} />
            <Segmented<'standard' | 'high' | 'max'> size="sm" label={t("Kalite")} value={quality} onChange={setQuality} options={[{ value: 'standard', label: t("Standart") }, { value: 'high', label: t("Yüksek") }, { value: 'max', label: t("En yüksek") }]} />
            <Segmented<'0' | '3' | '5'> size="sm" label={t("Geri sayım")} value={String(countdown) as '0' | '3' | '5'} onChange={(v) => setCountdown(Number(v))} options={[{ value: '0', label: t("Yok") }, { value: '3', label: t("3 sn") }, { value: '5', label: t("5 sn") }]} />
          </div>
          <div className="nr-card">
            <header><Icon name="info" size={16} /><strong>{t("Kayıt yöntemi")}</strong></header>
            <Segmented<'auto' | 'native' | 'web'> size="sm" label={t("Yöntem")} value={backend} onChange={setBackend}
              options={[{ value: 'auto', label: t("Otomatik") }, { value: 'native', label: t("Yerel") }, { value: 'web', label: t("Yedek") }]} />
            <div className="backend-info">
              {effective && (
                <>
                  <Badge tone={effective.id === 'web' ? 'warning' : 'success'}>{effective.id === 'web' ? t("Tarayıcı yedek kaydı") : t("Yerel kayıt")}</Badge>
                  <ul className="caps">
                    <li className={effective.capabilities.separateCursor ? 'ok' : ''}>{t("İmleç ayrı kayıt")}</li>
                    <li className={effective.capabilities.clicks ? 'ok' : ''}>{t("Tıklama verisi (otomatik zoom)")}</li>
                    <li className={effective.capabilities.systemAudio ? 'ok' : ''}>{t("Sistem sesi")}</li>
                  </ul>
                </>
              )}
              {native && !native.available && <p className="muted small">{native.reason}</p>}
            </div>
          </div>
          {window.zeyvola.platform === 'darwin' && (
            <div className="nr-card perms">
              <header><Icon name="shield" size={16} /><strong>{t("İzinler")}</strong></header>
              {permRow(t("Ekran kaydı"), 'screen', 'screen')}
              {permRow(t("Kamera"), 'camera', 'camera')}
              {permRow(t("Mikrofon"), 'microphone', 'microphone')}
            </div>
          )}
          {error && <p className="note is-error"><Icon name="warning" size={14} />{error}</p>}
          <Button variant="record" size="lg" icon="record" wide onClick={start} disabled={!source || starting || (kind === 'region' && !region)}>
            {starting ? t("Kamera ve kayıt hazırlanıyor…") : t("Kaydı başlat")}
          </Button>
          <p className="muted small center">{t("Kayıt sırasında:")} <kbd className="kbd">⌥⇧S</kbd> {t("bitir ·")} <kbd className="kbd">⌥⇧P</kbd> {t("duraklat ·")} <kbd className="kbd">⌥⇧M</kbd> {t("işaret")}</p>
        </aside>
      </div>
    </div>
  );
}

function RegionPicker(props: { source: SourceInfo; region: Region | null; onChange: (r: Region | null) => void; others: SourceInfo[]; onSelect: (id: string) => void }) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [lock, setLock] = useState<'free' | '16:9' | '9:16' | '1:1'>('16:9');
  const ref = useRef<HTMLDivElement>(null);
  const b = props.source.bounds;
  const displayAspect = b ? b.w / b.h : 16 / 9;
  const ratio = lock === 'free' ? null : lock === '16:9' ? 16 / 9 : lock === '9:16' ? 9 / 16 : 1;
  const pt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const update = (a: { x: number; y: number }, c: { x: number; y: number }) => {
    let w = Math.abs(c.x - a.x);
    let h = Math.abs(c.y - a.y);
    if (ratio) {
      // Normalized units: width fraction × display aspect = pixel aspect.
      const want = ratio / displayAspect;
      if (w / Math.max(h, 1e-6) > want) w = h * want; else h = w / want;
    }
    const x = c.x >= a.x ? a.x : a.x - w;
    const y = c.y >= a.y ? a.y : a.y - h;
    props.onChange({ x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) });
  };
  return (
    <div className="region-picker">
      <div className="nr-toolbar">
        <Select label={t("Ekran")} value={props.source.id} onChange={props.onSelect} options={props.others.map((s) => ({ value: s.id, label: s.name }))} />
        <Segmented<'free' | '16:9' | '9:16' | '1:1'> size="sm" label={t("Oran")} value={lock} onChange={setLock}
          options={[{ value: '16:9', label: '16:9' }, { value: '9:16', label: '9:16' }, { value: '1:1', label: '1:1' }, { value: 'free', label: t("Serbest") }]} />
      </div>
      <div
        ref={ref}
        className="region-canvas"
        style={{ aspectRatio: String(displayAspect) }}
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); const p = pt(e); setDrag(p); props.onChange({ x: p.x, y: p.y, w: 0, h: 0 }); }}
        onPointerMove={(e) => { if (drag) update(drag, pt(e)); }}
        onPointerUp={() => { setDrag(null); if (props.region && (props.region.w < 0.02 || props.region.h < 0.02)) props.onChange(null); }}
      >
        {props.source.thumbnail && <img src={props.source.thumbnail} alt="" draggable={false} />}
        {props.region && (
          <span className="region-rect" style={{ left: `${props.region.x * 100}%`, top: `${props.region.y * 100}%`, width: `${props.region.w * 100}%`, height: `${props.region.h * 100}%` }}>
            {b && <small className="mono">{Math.round(props.region.w * b.w)}×{Math.round(props.region.h * b.h)}</small>}
          </span>
        )}
        {!props.region && <span className="region-hint">{t("Kaydedilecek alanı sürükleyerek seçin")}</span>}
      </div>
    </div>
  );
}
