// Types for tools/third-party-notices.mjs (used by apps/desktop/src/shared/licenses.test.ts).
export interface ShippedPackage {
  name: string; version: string; license: string; licenseFile: string | null;
  copyright: string[]; repository: string; textSha256: string | null; text: string;
}
export interface CodecNote {
  id: string; name: string; chromiumTitle: string | null; profiles: ('mp4' | 'webm')[];
  where: { tr: string; en: string }; license: { tr: string; en: string }; patent: { tr: string; en: string };
  status: 'legal-review' | 'low-risk-unverified';
  inChromiumNotice: boolean | null;
}
export interface SupplementNotice {
  id: string; name: string; platforms: ('darwin' | 'win32')[]; files: string[]; version: string; license: string;
  licenseFile: string | null; source: string; text: string;
}
export interface NoticeData {
  packages: ShippedPackage[];
  electron: {
    name: 'electron'; version: string; license: string; copyright: string[]; text: string; licensePath: string;
    chromium: { path: string; bytes: number; sha256: string; entries: number; titles: string[] };
  };
  codecs: CodecNote[];
  profile: 'mp4' | 'webm' | null;
  platform: string | null;
  supplements: SupplementNotice[];
}
export const ROOT: string;
export const NOTICES_PATH: string;
export function shippedPackages(root?: string): ShippedPackage[];
export function collect(root?: string, opts?: { electronDist?: string | null; profile?: 'mp4' | 'webm' | null; platform?: string | null }): NoticeData;
export function supplementNotices(root?: string, platform?: string | null): SupplementNotice[];
export function renderMarkdown(data: NoticeData): string;
export function renderJson(data: NoticeData): string;
export function bundledPackages(distDir: string): string[];
export function shippedProblems(data: NoticeData): string[];
export function inventoryGaps(root?: string): { missingFromInventory: string[]; notInstalled: string[] };
export function writeDist(distDir: string, root?: string, opts?: { electronDist?: string | null; profile?: 'mp4' | 'webm' | null; platform?: string | null }): { problems: string[]; data: NoticeData };
