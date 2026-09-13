import type { BookDetail } from './api';
import type { ChapterVersion } from './Playback';
import { all, change, deviceChanged, get } from './device-db';
import { downloadChapter, isDownloading, readDownload } from './downloads';

export interface DownloadBatch {
  book: BookDetail; versions: ChapterVersion[]; state: 'running' | 'completed' | 'partial' | 'cancelled';
  completed: string[]; errors: Record<string, string>; sizes: Record<string, number>; error?: string;
}
let activeBook: string | null = null;
export const batchRunning = (bookId: string) => activeBook === bookId;
export const listBatches = () => all<DownloadBatch>('download_batches');
const write = async (bookId: string, update: (old: DownloadBatch) => DownloadBatch) => {
  const result = await change<DownloadBatch>('download_batches', bookId, (old) => update(old!));
  deviceChanged(); return result;
};
export function readyBookVersions(book: BookDetail, versions: ChapterVersion[]) {
  // API returns newest versions first. Choose one ready version per ordered section.
  return book.sections.flatMap((section) => {
    const version = versions.find((v) => v.section_id === section.id && v.state === 'ready' && v.audio_url);
    return version ? [version] : [];
  });
}
export async function cancelBatch(bookId: string) {
  await write(bookId, (old) => ({ ...old, state: 'cancelled' }));
}
export async function startBatch(book: BookDetail, versions: ChapterVersion[]) {
  return exclusive(async () => {
    const previous = await get<DownloadBatch>('download_batches', book.id);
    if (previous?.state === 'running') throw new Error('Continue or cancel the existing download plan first. It keeps its original audio versions.');
    const snapshot = readyBookVersions(book, versions);
    if (!snapshot.length) throw new Error('No ready chapter audio is available.');
    await write(book.id, () => ({ book, versions: snapshot, state: 'running', completed: [], errors: {}, sizes: {} }));
    await run(book.id);
  });
}
export async function continueBatch(bookId: string) { return exclusive(() => run(bookId)); }
async function exclusive(work: () => Promise<void>) {
  if (activeBook !== null) throw new Error('A download batch is already running. Wait or cancel it first.');
  activeBook = 'reserving';
  try {
    // Modern secure-origin browsers coordinate tabs without a new server service.
    if (navigator.locks) return await navigator.locks.request('reader-audio-download-batch', { ifAvailable: true }, async (lock) => {
      if (!lock) throw new Error('A download batch is running in another tab. Use that tab or close it before continuing.');
      await work();
    });
    await work(); // Per-page guard for browsers without Web Locks; documented limitation.
  } finally { activeBook = null; deviceChanged(); }
}

async function run(bookId: string) {
  activeBook = bookId; deviceChanged();
  try {
    let batch = await get<DownloadBatch>('download_batches', bookId);
    if (!batch) throw new Error('Download plan is missing. Start a new download from the book.');
    await write(bookId, (old) => ({ ...old, state: 'running', error: undefined, errors: {}, completed: [] }));
    // Validate existing copies one at a time; never collect their audio Blobs.
    for (const version of batch.versions) {
      if ((await get<DownloadBatch>('download_batches', bookId))?.state === 'cancelled') return;
      try {
        await readDownload(version.id);
        await write(bookId, (old) => ({ ...old, completed: [...old.completed, version.id] }));
      } catch {
        try {
          const response = await fetch(version.audio_url!, { method: 'HEAD', signal: AbortSignal.timeout(5000), cache: 'no-store' });
          const bytes = Number(response.headers.get('Content-Length'));
          if (response.ok && !response.headers.get('Content-Encoding') && Number.isFinite(bytes) && bytes > 0)
            await write(bookId, (old) => ({ ...old, sizes: { ...old.sizes, [version.id]: bytes } }));
        } catch { /* Unknown sizes do not block explicit downloading. */ }
      }
    }
    batch = (await get<DownloadBatch>('download_batches', bookId))!;
    if (batch.state === 'cancelled') return;
    const remaining = batch.versions.filter((v) => !batch!.completed.includes(v.id));
    const knownBytes = remaining.reduce((total, v) => total + (batch!.sizes[v.id] ?? 0), 0);
    const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
    if (estimate?.quota && knownBytes > estimate.quota - (estimate.usage ?? 0)) throw new Error('Not enough device storage for the remaining known audio size. Remove a device download, then Continue download.');
    for (const version of remaining) {
      if ((await get<DownloadBatch>('download_batches', bookId))?.state === 'cancelled') return;
      try {
        // Wait for a single-chapter operation already owned by this page, without cancelling it.
        while (isDownloading(version.id)) {
          if ((await get<DownloadBatch>('download_batches', bookId))?.state === 'cancelled') return;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        await downloadChapter(batch.book, version);
        await readDownload(version.id); // Removal/cancellation must never count as a completed copy.
        await write(bookId, (old) => ({ ...old, completed: [...old.completed, version.id] }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Chapter download failed.';
        await write(bookId, (old) => ({ ...old, errors: { ...old.errors, [version.id]: message } }));
        if (navigator.onLine === false || /storage|quota/i.test(message)) break;
      }
    }
    await write(bookId, (old) => old.state === 'cancelled' ? old : {
      ...old, state: old.completed.length === old.versions.length ? 'completed' : 'partial',
    });
  } catch (error) {
    if (!await get<DownloadBatch>('download_batches', bookId)) throw error;
    await write(bookId, (old) => ({ ...old, state: old.state === 'cancelled' ? 'cancelled' : 'partial', error: error instanceof Error ? error.message : 'Batch failed.' }));
  } finally { activeBook = null; deviceChanged(); }
}
