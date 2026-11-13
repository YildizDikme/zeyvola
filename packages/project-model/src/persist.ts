import { deepMerge, type DeepPartial } from './commands';
import { defaultStyle, defaultVariants } from './factory';
import type { Project } from './types';
import { SCHEMA_VERSION } from './types';

export class ProjectFormatError extends Error {}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validates and normalizes a parsed project.json. Missing optional sections are filled
 * with defaults so older files keep opening; structurally broken files are rejected.
 */
export function parseProject(json: unknown): Project {
  if (!isObj(json)) throw new ProjectFormatError('Proje dosyası bir nesne değil.');
  const schema = json.schema;
  if (schema !== SCHEMA_VERSION) throw new ProjectFormatError(`Desteklenmeyen proje şeması: ${String(schema)}`);
  for (const key of ['id', 'name'] as const) {
    if (typeof json[key] !== 'string') throw new ProjectFormatError(`Eksik alan: ${key}`);
  }
  if (!isObj(json.recordings)) throw new ProjectFormatError('Eksik alan: recordings');
  const seq = json.sequence;
  if (!isObj(seq) || !Array.isArray(seq.segments) || !isObj(seq.fps)) throw new ProjectFormatError('Eksik alan: sequence');
  for (const s of seq.segments as unknown[]) {
    if (!isObj(s) || typeof s.id !== 'string' || typeof s.recordingId !== 'string'
      || typeof s.sourceStart !== 'number' || typeof s.sourceEnd !== 'number') {
      throw new ProjectFormatError('Bozuk segment kaydı');
    }
  }
  const arr = (k: string) => (Array.isArray(json[k]) ? (json[k] as unknown[]) : []);
  const variants = Array.isArray(json.variants) && json.variants.length > 0 ? (json.variants as Project['variants']) : defaultVariants();
  const activeVariantId = typeof json.activeVariantId === 'string' && variants.some((v) => v.id === json.activeVariantId)
    ? json.activeVariantId : variants[0]!.id;
  const project: Project = {
    schema: SCHEMA_VERSION,
    id: json.id as string,
    name: json.name as string,
    createdAt: typeof json.createdAt === 'string' ? json.createdAt : new Date(0).toISOString(),
    updatedAt: typeof json.updatedAt === 'string' ? json.updatedAt : new Date(0).toISOString(),
    recordings: json.recordings as Project['recordings'],
    sequence: seq as unknown as Project['sequence'],
    zooms: arr('zooms') as Project['zooms'],
    cameraLayouts: arr('cameraLayouts') as Project['cameraLayouts'],
    privacy: (arr('privacy') as Project['privacy']).map((p) => ({ ...p, keyframes: Array.isArray(p.keyframes) ? p.keyframes : [] })),
    magnifiers: arr('magnifiers') as Project['magnifiers'],
    style: deepMerge<Project['style']>(defaultStyle(), (isObj(json.style) ? json.style : {}) as DeepPartial<Project['style']>),
    variants,
    activeVariantId,
    audio: deepMerge<Project['audio']>({ mic: { gain: 1, muted: false }, system: { gain: 0.8, muted: false } }, (isObj(json.audio) ? json.audio : {}) as DeepPartial<Project['audio']>),
    zoomEngine: isObj(json.zoomEngine) ? (json.zoomEngine as Project['zoomEngine']) : { sensitivity: 'medium' },
  };
  return project;
}

export function serializeProject(project: Project, now = new Date()): string {
  return JSON.stringify({ ...project, updatedAt: now.toISOString() }, null, 2);
}
