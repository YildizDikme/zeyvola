import { contextBridge, ipcRenderer } from 'electron';

/** Only these channels are reachable from page scripts. */
const INVOKE = new Set([
  'app:info', 'app:relaunch',
  'projects:list', 'projects:create', 'projects:open', 'projects:save', 'projects:rename', 'projects:trash',
  'projects:reveal', 'projects:readText', 'projects:setThumbnail',
  'permissions:get', 'permissions:request', 'permissions:openSettings',
  'capture:backends', 'capture:sources', 'capture:state', 'capture:start', 'capture:pause', 'capture:resume',
  'capture:mark', 'capture:stop', 'capture:cancel', 'capture:dismissError', 'capture:recoveries', 'capture:dismissRecovery',
  'cw:open', 'cw:chunk', 'cw:close', 'cw:started', 'cw:level', 'cw:failed', 'cw:ready', 'cw:busy',
  'export:defaultTarget', 'export:chooseTarget', 'export:encoderInfo', 'export:mfBegin', 'export:mfWrite', 'export:begin', 'export:write', 'export:end', 'shell:showItem', 'settings:get', 'settings:set',
  'licenses:get', 'licenses:openChromium', 'licenses:openNotices',
  'smoke:report', 'smoke:writeFile', 'smoke:appendRecording', 'smoke:realRecording', 'smoke:shot', 'smoke:pickFile', 'smoke:aacFixture', 'smoke:cpu', 'smoke:avCheck', 'smoke:listDir', 'smoke:saveShot', 'smoke:docsExportFolder',
  'media:pickVideo', 'media:importVideo', 'media:discardImport',
]);

const EVENTS = new Set(['settings:changed', 'capture:state', 'capture:finished', 'capture:releaseDevices', 'capture:recovered', 'cw:prepare', 'cw:go', 'cw:pause', 'cw:resume', 'cw:stop']);

contextBridge.exposeInMainWorld('zeyvola', {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`İzin verilmeyen kanal: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel: string, listener: (data: unknown) => void): () => void {
    if (!EVENTS.has(channel)) throw new Error(`İzin verilmeyen olay: ${channel}`);
    const h = (_e: unknown, data: unknown) => listener(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
  platform: process.platform,
});
