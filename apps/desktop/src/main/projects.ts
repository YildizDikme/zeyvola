import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  addRecording, createProject, parseProject, sequenceDuration, serializeProject, type Project, type Recording,
} from '@zeyvola/project-model';
import { IMPORT_VIDEO_TYPES, type ImportedVideo, type ProjectSummary } from '@zeyvola/protocol';
import { PROJECT_FILE } from '../shared/brand';
import { dirSize, exists, removeQuiet, safeJoin, writeFileAtomic } from './fsutil';
import { tm } from './settings';

/**
 * Projects are folders under one root: project.json + media/ + cache/.
 * Writes are atomic and the previous project.json is kept as project.json.bak.
 */
export class ProjectStore {
  private dirs = new Map<string, string>();
  private writeChain = new Map<string, Promise<void>>();

  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.scan();
  }

  private async scan(): Promise<void> {
    this.dirs.clear();
    let entries;
    try { entries = await readdir(this.root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(this.root, e.name);
      try {
        const head = JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8')) as { id?: unknown };
        if (typeof head.id === 'string') this.dirs.set(head.id, dir);
      } catch { /* not a project folder */ }
    }
  }

  /** Every project folder, freshly scanned. */
  async entries(): Promise<{ id: string; dir: string }[]> {
    await this.scan();
    return [...this.dirs].map(([id, dir]) => ({ id, dir }));
  }

  dirOf(id: string): string {
    const d = this.dirs.get(id);
    if (!d) throw new Error(tm("Proje bulunamadı"));
    return d;
  }

  resolve(id: string, rel: string): string {
    const p = safeJoin(this.dirOf(id), rel);
    if (!p) throw new Error('Geçersiz yol');
    return p;
  }

  /**
   * Copies a video from the computer into the project (media/imp_…/), so the project stays
   * self-contained and the original file is never touched.
   */
  async importVideo(id: string, src: string): Promise<ImportedVideo> {
    const ext = extname(src).toLowerCase();
    const mime = IMPORT_VIDEO_TYPES[ext];
    if (!mime) throw new Error(tm("Bu dosya türü desteklenmiyor. MP4, MOV, M4V veya WebM seçin."));
    const recordingId = `imp_${randomBytes(6).toString('hex')}`;
    const file = `media/${recordingId}/video${ext}`;
    const dest = this.resolve(id, file);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    return { recordingId, file, mime, name: basename(src, extname(src)), bytes: (await stat(dest)).size };
  }

  /** Removes a copied video that turned out not to be playable. */
  async discardImport(id: string, recordingId: string): Promise<void> {
    await removeQuiet(this.resolve(id, `media/${recordingId}`));
  }

  async list(): Promise<ProjectSummary[]> {
    await this.scan();
    const out: ProjectSummary[] = [];
    for (const [id, dir] of this.dirs) {
      try {
        const p = parseProject(JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8')));
        let thumbnail: string | null = null;
        const thumbPath = join(dir, 'cache', 'thumbnail.jpg');
        if (await exists(thumbPath)) thumbnail = `data:image/jpeg;base64,${(await readFile(thumbPath)).toString('base64')}`;
        out.push({
          id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          durationTicks: sequenceDuration(p), recordings: Object.keys(p.recordings).length,
          thumbnail, sizeBytes: await dirSize(join(dir, 'media')),
        });
      } catch { /* skip unreadable project */ }
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  async create(name: string): Promise<{ id: string; dir: string; project: Project }> {
    const project = createProject(name);
    const safe = name.replace(/[^\p{L}\p{N} ._-]+/gu, '').trim().slice(0, 60) || 'Proje';
    let dir = join(this.root, `${safe} ${project.id.slice(4, 12)}`);
    let n = 2;
    while (await exists(dir)) dir = join(this.root, `${safe} ${project.id.slice(4, 12)}-${n++}`);
    await mkdir(join(dir, 'media'), { recursive: true });
    await mkdir(join(dir, 'cache'), { recursive: true });
    await writeFileAtomic(join(dir, PROJECT_FILE), serializeProject(project));
    this.dirs.set(project.id, dir);
    return { id: project.id, dir, project };
  }

  async read(id: string): Promise<Project> {
    return parseProject(JSON.parse(await readFile(join(this.dirOf(id), PROJECT_FILE), 'utf8')));
  }

  /** Saves serialized JSON after validating it. Writes for one project are serialized. */
  async save(id: string, json: string): Promise<void> {
    const project = parseProject(JSON.parse(json));
    if (project.id !== id) throw new Error('Proje kimliği uyuşmuyor');
    const dir = this.dirOf(id);
    const prev = this.writeChain.get(id) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const file = join(dir, PROJECT_FILE);
      try {
        const current = await readFile(file);
        await writeFileAtomic(`${file}.bak`, current);
      } catch { /* first save */ }
      await writeFileAtomic(file, serializeProject(project));
    });
    this.writeChain.set(id, next);
    await next;
  }

  async appendRecording(id: string, recording: Recording): Promise<Project> {
    const project = addRecording(await this.read(id), recording);
    await this.save(id, serializeProject(project));
    return project;
  }

  async rename(id: string, name: string): Promise<void> {
    const p = await this.read(id);
    await this.save(id, serializeProject({ ...p, name: name.trim() || p.name }));
  }

  async setThumbnail(id: string, jpeg: Uint8Array): Promise<void> {
    await writeFileAtomic(join(this.dirOf(id), 'cache', 'thumbnail.jpg'), jpeg);
  }

  forget(id: string): void {
    this.dirs.delete(id);
  }

  async mediaDir(id: string, recordingId: string): Promise<string> {
    const dir = join(this.dirOf(id), 'media', recordingId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async fileSize(path: string): Promise<number> {
    try { return (await stat(path)).size; } catch { return 0; }
  }
}
