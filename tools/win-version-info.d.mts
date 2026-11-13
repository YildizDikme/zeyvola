export const STRING_KEYS: string[];
export interface FixedInfo { strucVersion: number; flagsMask: number; flags: number; os: number; type: number; subtype: number; dateMS: number; dateLS: number }
export interface VersionInfo {
  fileVersion: number[];
  productVersion: number[];
  fixed: FixedInfo;
  strings: Record<string, string>;
  tableKey: string | null;
  translation: [number, number] | null;
}
export function versionParts(v: string | number[]): number[];
export function encodeVersionInfo(info: { fixed?: FixedInfo; fileVersion: string | number[]; productVersion: string | number[]; strings: Record<string, string>; tableKey?: string; translation?: [number, number] }): Buffer;
export function decodeVersionInfo(buf: Buffer): VersionInfo;
export function findVersionResources(buf: Buffer): { signed: boolean; entries: { lang: number; entry: number; offset: number; size: number }[] };
export function setVersionInfo(buf: Buffer, info: { fileVersion: string | number[]; productVersion: string | number[]; strings: Record<string, string> }): { lang: number; before: Record<string, string>; size: number }[];
