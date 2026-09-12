import { api } from './api';
import { all, change, deviceChanged, get, transaction } from './device-db';
import type { Progress } from './Playback';

export interface DeviceProgress extends Progress {
  book_id: string; updated_at_ms: number; pending: boolean; base_updated_at_ms?: number; conflict?: Progress; syncError?: string;
}
const syncing = new Map<string, Promise<void>>();
const available = () => !!globalThis.indexedDB;
const stamp = (p: Progress | null | undefined) => p?.updated_at_ms ?? 0;
export async function readProgress(bookId: string): Promise<Progress | null> {
  if (!available()) return api<Progress | null>(`/books/${bookId}/listening-progress`);
  // Synchronization will resolve pending edits separately. Loading a track must never discard one.
  const local = await get<DeviceProgress>('progress', bookId);
  if (local?.pending || navigator.onLine === false) return local?.version_id ? local : null;
  try {
    const server = await api<Progress | null>(`/books/${bookId}/listening-progress`, { signal: AbortSignal.timeout(5000) });
    const next = await change<DeviceProgress>('progress', bookId, (latest) => {
      if (latest?.pending || stamp(latest) >= stamp(server)) return latest ?? { book_id: bookId, version_id: '', section_id: '', offset: 0, speed: 1, updated_at_ms: 0, pending: false };
      return { ...server!, book_id: bookId, updated_at_ms: stamp(server), pending: false };
    });
    return next.version_id ? next : null;
  } catch { return (await get<DeviceProgress>('progress', bookId)) ?? null; }
}
export async function saveLocalProgress(bookId: string, value: Progress & { updated_at_ms: number }): Promise<void> {
  if (!available()) {
    const { section_id: _section, ...payload } = value;
    await api(`/books/${bookId}/listening-progress`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true });
    return;
  }
  await transaction(['progress', 'positions'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('progress');
    store.get(bookId).onsuccess = (event) => {
      const old = (event.target as IDBRequest<DeviceProgress | undefined>).result;
      const next = { ...value, book_id: bookId, updated_at_ms: Math.max(value.updated_at_ms, stamp(old) + 1), pending: true, base_updated_at_ms: old?.pending ? old.base_updated_at_ms : stamp(old) };
      store.put(next, bookId);
      tx.objectStore('positions').put(next, JSON.stringify([bookId, value.version_id]));
      done(undefined);
    };
  });
  deviceChanged();
  // The durable local write is complete even if the server cannot be reached.
  void syncBook(bookId).catch(() => {});
}
export function syncBook(bookId: string): Promise<void> {
  if (syncing.has(bookId)) return syncing.get(bookId)!;
  const promise = reconcile(bookId).finally(() => { syncing.delete(bookId); deviceChanged(); });
  syncing.set(bookId, promise); return promise;
}
async function reconcile(bookId: string) {
  if (!available() || navigator.onLine === false) return;
  const local = await get<DeviceProgress>('progress', bookId);
  if (!local?.pending || local.conflict) return;
  try {
    let server = await api<Progress | null>(`/books/${bookId}/listening-progress`, { signal: AbortSignal.timeout(5000) });
    if (server && server.version_id !== local.version_id && stamp(server) > (local.base_updated_at_ms ?? 0)) {
      await change<DeviceProgress>('progress', bookId, (latest) => latest?.updated_at_ms === local.updated_at_ms ? { ...latest, conflict: server!, syncError: undefined } : latest!);
      return;
    }
    if (stamp(server) < local.updated_at_ms) {
      server = await api<Progress>(`/books/${bookId}/listening-progress`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ version_id: local.version_id, offset: local.offset, speed: local.speed, updated_at_ms: local.updated_at_ms }),
      });
    }
    if (!server) return;
    await change<DeviceProgress>('progress', bookId, (latest) => {
      if (latest?.updated_at_ms !== local.updated_at_ms) return latest!;
      if (server!.version_id !== local.version_id) return { ...latest, conflict: server! };
      return { ...server!, book_id: bookId, updated_at_ms: stamp(server), pending: false };
    });
  } catch (error) {
    await change<DeviceProgress>('progress', bookId, (latest) => latest?.updated_at_ms === local.updated_at_ms
      ? { ...latest, syncError: error instanceof Error ? error.message : 'Sync failed. Your position remains on this device.' } : latest!);
  }
}
export async function resolveProgress(bookId: string, choice: 'device' | 'server') {
  const local = await get<DeviceProgress>('progress', bookId);
  if (!local?.conflict) return;
  if (choice === 'server') {
    await change<DeviceProgress>('progress', bookId, (latest) => latest?.updated_at_ms === local.updated_at_ms
      ? { ...local.conflict!, book_id: bookId, updated_at_ms: stamp(local.conflict), pending: false } : latest!);
  } else {
    // Explicitly replace the remote version. Re-read on the next ordinary edit if another device races.
    const value = { version_id: local.version_id, offset: local.offset, speed: local.speed, updated_at_ms: Math.max(Date.now(), local.updated_at_ms + 1, stamp(local.conflict) + 1) };
    const server = await api<Progress>(`/books/${bookId}/listening-progress`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
    await change<DeviceProgress>('progress', bookId, (latest) => latest?.updated_at_ms === local.updated_at_ms
      ? server.version_id === local.version_id ? { ...server, book_id: bookId, updated_at_ms: stamp(server), pending: false } : { ...latest, conflict: server } : latest!);
  }
  deviceChanged();
}
export async function syncPending() {
  if (!available()) return;
  const rows = await all<DeviceProgress>('progress');
  for (const row of rows) if (row.pending) await syncBook(row.book_id);
}

/** Local history retains each version; the server still synchronizes the latest book position. */
export async function readVersionProgress(bookId: string, versionId: string, localOnly = false): Promise<Progress | null> {
  const latest = localOnly && available() ? await get<DeviceProgress>('progress', bookId) : await readProgress(bookId);
  const history = available() ? await get<Progress>('positions', JSON.stringify([bookId, versionId])) : undefined;
  if (latest?.version_id === versionId && stamp(latest) >= stamp(history)) return latest;
  return history ?? null;
}
