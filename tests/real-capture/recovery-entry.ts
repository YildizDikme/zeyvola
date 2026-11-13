// Bundled for the real capture harness: the app's own project store and crash recovery,
// so the SIGKILL scenario goes through exactly what the app runs at its next start.
export { ProjectStore } from '../../apps/desktop/src/main/projects';
export { parseSessionLog, recoverAbandoned, SESSION_FILE } from '../../apps/desktop/src/main/capture/recovery';
export { probeFiles } from '../../apps/desktop/src/main/capture/helper-client';
