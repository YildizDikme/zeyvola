export const ELECTRON_VERSION: string;
/** Path of an official Electron artifact in the local download cache, or null (never downloads). */
export function cached(spec: string): string | null;
/** Path of an official Electron artifact, downloaded and SHA-256 checked when not cached. */
export function artifact(spec: string): Promise<string>;
