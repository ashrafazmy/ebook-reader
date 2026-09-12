import { api, type BookDetail, type SectionDetail } from './api';
import type { ChapterVersion } from './Playback';
import { all, change, deviceChanged, get, transaction } from './device-db';

export interface Download {
  id: string; book: BookDetail; version: ChapterVersion; section?: SectionDetail;
  receivedBytes?: number; totalBytes?: number; phase?: 'transferring' | 'verifying' | 'saving';
  state: 'downloading' | 'ready' | 'failed' | 'removed'; bytes: number; error?: string; token: string; updatedAt: number;
}
const active = new Map<string, AbortController>();
export function listDownloads() { return all<Download>('downloads'); }
export async function readDownload(id: string): Promise<{ item: Download; audio: Blob }> {
  const result = await transaction<{ item?: Download; audio?: Blob }>(['downloads', 'audio'], 'readonly', (tx, done) => {
    const metadata = tx.objectStore('downloads').get(id), audio = tx.objectStore('audio').get(id);
    audio.onsuccess = () => done({ item: metadata.result, audio: audio.result });
  });
  if (result.item?.state !== 'ready' || !result.item.section || !result.audio || result.audio.size !== result.item.bytes || result.audio.size < 44) {
    if (result.item?.state === 'ready') { await change<Download>('downloads', id, (old) => ({ ...old!, state: 'failed', error: 'Downloaded files are missing or were evicted. Download this version again.' })); deviceChanged(); }
    throw new Error('This chapter is not available offline. Connect and download it again.');
  }
  return { item: result.item, audio: result.audio };
}
export async function removeDownload(id: string) {
  active.get(id)?.abort();
  await transaction(['downloads', 'audio'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('downloads');
    store.get(id).onsuccess = (e) => {
      const old: Download | undefined = (e.target as IDBRequest).result;
      if (old) store.put({ ...old, section: undefined, state: 'removed', bytes: 0, error: undefined, token: crypto.randomUUID() }, id);
      tx.objectStore('audio').delete(id); done(undefined);
    };
  }); deviceChanged();
}
export async function downloadChapter(book: BookDetail, version: ChapterVersion): Promise<void> {
  if (active.has(version.id)) return;
  if (version.state !== 'ready' || !version.audio_url?.startsWith('/api/chapter-audio/')) throw new Error('Only completed chapter audio can be downloaded.');
  const existing = await get<Download>('downloads', version.id);
  if (existing?.state === 'ready') { try { await readDownload(version.id); return; } catch { /* Explicit repair. */ } }
  if (active.has(version.id)) return;
  const controller = new AbortController(); active.set(version.id, controller);
  const token = crypto.randomUUID();
  const initial: Download = { id: version.id, book, version, state: 'downloading', bytes: 0, token, updatedAt: Date.now() };
  try {
    await change<Download>('downloads', version.id, () => initial); deviceChanged();
    const section = await api<SectionDetail>(`/books/${book.id}/sections/${version.section_id}`, { signal: controller.signal });
    if (section.id !== version.section_id || !Array.isArray(section.blocks)) throw new Error('Chapter text does not match this audio version.');
    const response = await fetch(version.audio_url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok || response.status === 206) throw new Error(`Audio download failed (${response.status}). Retry when connected.`);
    const length = Number(response.headers.get('Content-Length'));
    const expected = !response.headers.get('Content-Encoding') && Number.isFinite(length) && length > 0 ? length : 0;
    const report = async (receivedBytes: number, phase: Download['phase']) => {
      await change<Download>('downloads', version.id, (old) => old?.token === token ? { ...old, receivedBytes, totalBytes: expected || undefined, phase } : old!); deviceChanged();
    };
    await report(0, 'transferring');
    const estimate = await navigator.storage?.estimate?.();
    if (expected && estimate?.quota && expected > estimate.quota - (estimate.usage ?? 0)) throw new Error('Not enough device storage. Remove a download and try again.');
    const parts: BlobPart[] = [];
    let received = 0, reportedAt = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value.slice().buffer); received += value.byteLength;
          if (Date.now() - reportedAt >= 150) { await report(received, 'transferring'); reportedAt = Date.now(); }
        }
      } finally { reader.releaseLock(); }
    } else { const blob = await response.blob(); parts.push(blob); received = blob.size; }
    await report(received, 'verifying');
    const audio = new Blob(parts);
    if (audio.size < 44 || (expected && audio.size !== expected)) throw new Error('Audio download was incomplete. Retry when connected.');
    const header = new Uint8Array(await audio.slice(0, 12).arrayBuffer());
    if (String.fromCharCode(...header.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...header.slice(8, 12)) !== 'WAVE' || new DataView(header.buffer).getUint32(4, true) + 8 !== audio.size) throw new Error('Downloaded audio is not the expected WAV file.');
    const wav = audio.slice(0, audio.size, 'audio/wav');
    await report(received, 'saving');
    await transaction(['downloads', 'audio'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('downloads');
      store.get(version.id).onsuccess = (e) => {
        const old: Download = (e.target as IDBRequest).result;
        if (old?.token === token && !controller.signal.aborted) {
          tx.objectStore('audio').put(wav, version.id);
          store.put({ ...initial, state: 'ready', section, bytes: wav.size }, version.id);
        }
        done(undefined);
      };
    });
  } catch (error) {
    controller.abort();
    const message = error instanceof DOMException && error.name === 'QuotaExceededError'
      ? 'Device storage is full. Remove a download and try again.' : error instanceof Error ? error.message : 'Download failed.';
    await change<Download>('downloads', version.id, (old) => old?.token === token ? { ...old, state: 'failed', error: message } : old!).catch(() => {});
    throw new Error(message);
  } finally { active.delete(version.id); deviceChanged(); }
}
export function isDownloading(id: string) { return active.has(id); }
export async function downloadedVersions(bookId: string) {
  const rows = await listDownloads();
  return rows.filter((item) => item.book.id === bookId && item.state === 'ready').map((item) => item.version);
}
