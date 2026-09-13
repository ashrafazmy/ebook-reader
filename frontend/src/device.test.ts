import { startBatch, continueBatch, cancelBatch, readyBookVersions, type DownloadBatch } from './downloadBatch';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { all, change, get, transaction } from './device-db';
import { downloadChapter, readDownload, removeDownload, type Download } from './downloads';
import { readProgress, readVersionProgress, resolveProgress, saveLocalProgress, syncBook, type DeviceProgress } from './progress';
import type { BookDetail } from './api';
import type { ChapterVersion, Progress } from './Playback';

const book: BookDetail = { id: 'book', title: 'Synthetic', author: 'Author', section_count: 1, sections: [{ id: 'section', title: 'Chapter', position: 0, spine_position: 0 }] };
const section = { ...book.sections[0], blocks: [{ id: 'block', kind: 'paragraph', heading_level: null, position: 0, text: 'Exact original wording.' }] };
const version: ChapterVersion = { id: 'version', section_id: 'section', profile_id: 'voice', profile_name: 'Voice', model_name: 'model', state: 'ready', audio_url: '/api/chapter-audio/audio' };
function wav() {
  const bytes = new Uint8Array(244); const data = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0); data.setUint32(4, bytes.length - 8, true); bytes.set(new TextEncoder().encode('WAVEfmt '), 8);
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, 24000, true); data.setUint32(28, 48000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  bytes.set(new TextEncoder().encode('data'), 36); data.setUint32(40, 200, true); return bytes;
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { onLine: false, storage: { estimate: async () => ({ quota: 100000, usage: 0 }) } });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockImplementation(async (url: string) => url.endsWith('/sections/section') ? json(section) : new Response(wav(), { headers: { 'Content-Length': '244', 'Content-Type': 'audio/wav' } }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('publishes text, exact version and audio atomically; repeated downloads reuse it', async () => {
  await downloadChapter(book, version); const saved = await readDownload(version.id);
  expect(saved.item.state).toBe('ready'); expect(saved.item.section).toEqual(section); expect(saved.item.version.id).toBe('version');
  expect(saved.audio.size).toBe(244); expect(saved.audio.type).toBe('audio/wav');
  expect(new Uint8Array(await saved.audio.slice(100, 120).arrayBuffer())).toEqual(wav().slice(100, 120));
  await downloadChapter(book, version); expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('never marks truncated audio ready and retries a failed download', async () => {
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/sections/section') ? json(section) : new Response(wav(), { headers: { 'Content-Length': '300' } }));
  await expect(downloadChapter(book, version)).rejects.toThrow('incomplete');
  expect((await get<Download>('downloads', version.id))?.state).toBe('failed'); expect(await get('audio', version.id)).toBeUndefined();
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/sections/section') ? json(section) : new Response(wav()));
  await downloadChapter(book, version); expect((await readDownload(version.id)).item.state).toBe('ready');
});
it('reports insufficient quota and keeps a failed state', async () => {
  vi.stubGlobal('navigator', { storage: { estimate: async () => ({ quota: 100, usage: 0 }) } });
  await expect(downloadChapter(book, version)).rejects.toThrow('Not enough device storage');
  expect((await get<Download>('downloads', version.id))?.state).toBe('failed');
});
it('rolls back audio and ready metadata together if the final storage transaction aborts', async () => {
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = original.call(this, value, key);
    if (this.name === 'audio') queueMicrotask(() => this.transaction.abort());
    return request;
  });
  await expect(downloadChapter(book, version)).rejects.toThrow();
  expect((await get<Download>('downloads', version.id))?.state).toBe('failed'); expect(await get('audio', version.id)).toBeUndefined();
});
it('device removal deletes only its audio and allows redownload of the same version', async () => {
  await downloadChapter(book, version); await removeDownload(version.id);
  expect((await get<Download>('downloads', version.id))?.state).toBe('removed'); expect(await get('audio', version.id)).toBeUndefined();
  expect(fetchMock.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  await downloadChapter(book, version); expect((await readDownload(version.id)).item.state).toBe('ready');
});
it('detects an evicted asset and refuses incomplete offline content', async () => {
  await downloadChapter(book, version);
  await transaction(['audio'], 'readwrite', (tx, done) => { tx.objectStore('audio').delete(version.id); done(undefined); });
  await expect(readDownload(version.id)).rejects.toThrow('not available offline'); expect((await get<Download>('downloads', version.id))?.state).toBe('failed');
});
it('an interrupted downloading record is not readable and can be explicitly retried', async () => {
  await change<Download>('downloads', version.id, () => ({ id: version.id, book, version, state: 'downloading', bytes: 0, token: 'dead-tab', updatedAt: 0 }));
  await expect(readDownload(version.id)).rejects.toThrow(); await downloadChapter(book, version); expect((await readDownload(version.id)).item.state).toBe('ready');
});
const position = { version_id: version.id, section_id: 'section', offset: 2, speed: 1.25, updated_at_ms: 200 };
function serverMock(initial: Progress | null) {
  let server = initial;
  fetchMock.mockImplementation(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'PUT') server = { ...JSON.parse(options.body as string), section_id: 'section' };
    return json(server);
  }); return () => server;
}
it('saves offline progress and syncs an intentional rewind using edit time, never furthest offset', async () => {
  const server = serverMock({ ...position, offset: 90, updated_at_ms: 100 });
  await saveLocalProgress(book.id, position); expect(fetchMock).not.toHaveBeenCalled();
  expect((await readProgress(book.id))?.offset).toBe(2);
  Object.defineProperty(navigator, 'onLine', { value: true }); await syncBook(book.id);
  expect(server()?.offset).toBe(2); expect((await get<DeviceProgress>('progress', book.id))?.pending).toBe(false);
});
it('newer server edit wins for the same version, even when it is a rewind', async () => {
  serverMock({ ...position, offset: 1, updated_at_ms: 300 }); await saveLocalProgress(book.id, { ...position, offset: 80 });
  Object.defineProperty(navigator, 'onLine', { value: true }); await syncBook(book.id);
  expect((await get<DeviceProgress>('progress', book.id))?.offset).toBe(1);
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
});
it('holds different-version conflicts until the user explicitly chooses', async () => {
  const server = serverMock({ ...position, version_id: 'replacement', offset: 50 });
  await saveLocalProgress(book.id, position); Object.defineProperty(navigator, 'onLine', { value: true }); await syncBook(book.id);
  expect((await get<DeviceProgress>('progress', book.id))?.conflict?.version_id).toBe('replacement');
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
  await resolveProgress(book.id, 'device'); expect(server()?.version_id).toBe(version.id); expect((await get<DeviceProgress>('progress', book.id))?.pending).toBe(false);
});
it('does not let a stale server response erase a newer local edit', async () => {
  await saveLocalProgress(book.id, position);
  let respond!: (response: Response) => void; fetchMock.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
  Object.defineProperty(navigator, 'onLine', { value: true }); const pending = syncBook(book.id);
  await vi.waitFor(() => expect(respond).toBeDefined());
  await saveLocalProgress(book.id, { ...position, offset: 5, updated_at_ms: 400 });
  respond(json({ ...position, offset: 90, updated_at_ms: 300 })); await pending;
  expect((await get<DeviceProgress>('progress', book.id))?.offset).toBe(5); expect((await get<DeviceProgress>('progress', book.id))?.pending).toBe(true);
});
it('keeps pending position when the server is unavailable', async () => {
  fetchMock.mockRejectedValue(new TypeError('offline')); await saveLocalProgress(book.id, position);
  Object.defineProperty(navigator, 'onLine', { value: true }); await syncBook(book.id);
  expect((await all<DeviceProgress>('progress'))[0]).toMatchObject({ offset: 2, pending: true });
});
it('duplicate clicks share work and removal prevents an in-flight download publishing later', async () => {
  let release!: (value: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const first = downloadChapter(book, version); await vi.waitFor(() => expect(release).toBeDefined());
  await downloadChapter(book, version); expect(fetchMock).toHaveBeenCalledTimes(1);
  await removeDownload(version.id); release(json(section)); await first;
  expect((await get<Download>('downloads', version.id))?.state).toBe('removed'); expect(await get('audio', version.id)).toBeUndefined();
});
it('an intentional next-version selection syncs normally if the known server baseline is unchanged', async () => {
  const old = { ...position, version_id: 'previous', updated_at_ms: 100 };
  const server = serverMock(old);
  await change<DeviceProgress>('progress', book.id, () => ({ ...old, book_id: book.id, pending: false }));
  await saveLocalProgress(book.id, position); Object.defineProperty(navigator, 'onLine', { value: true }); await syncBook(book.id);
  expect(server()?.version_id).toBe(version.id); expect((await get<DeviceProgress>('progress', book.id))?.conflict).toBeUndefined();
});
it('choosing server progress for a version conflict retains its exact version and offset', async () => {
  serverMock({ ...position, version_id: 'replacement', offset: 6 });
  await saveLocalProgress(book.id, position); Object.defineProperty(navigator, 'onLine', { value: true }); await syncBook(book.id);
  await resolveProgress(book.id, 'server');
  expect(await get<DeviceProgress>('progress', book.id)).toMatchObject({ version_id: 'replacement', offset: 6, pending: false });
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
});

it.each([true, false])('reports actual streamed bytes before completion (known total: %s)', async (known) => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/sections/section') ? json(section) : new Response(body, { headers: known ? { 'Content-Length': '244' } : {} }));
  const pending = downloadChapter(book, version);
  stream.enqueue(wav().slice(0, 100));
  await vi.waitFor(async () => expect(await get<Download>('downloads', version.id)).toMatchObject({ state: 'downloading', phase: 'transferring', receivedBytes: 100, totalBytes: known ? 244 : undefined }));
  expect(await get('audio', version.id)).toBeUndefined();
  stream.enqueue(wav().slice(100)); stream.close(); await pending;
  expect((await readDownload(version.id)).audio.size).toBe(244);
});
it('retains transferred bytes on stream failure and starts a fresh explicit retry', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/sections/section') ? json(section) : new Response(body));
  const pending = downloadChapter(book, version);
  const failure = expect(pending).rejects.toThrow('Connection interrupted');
  stream.enqueue(wav().slice(0, 100));
  await vi.waitFor(async () => expect((await get<Download>('downloads', version.id))?.receivedBytes).toBe(100));
  stream.error(new Error('Connection interrupted')); await failure;
  expect(await get<Download>('downloads', version.id)).toMatchObject({ state: 'failed', receivedBytes: 100 });
  expect(await get('audio', version.id)).toBeUndefined();
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/sections/section') ? json(section) : new Response(wav()));
  await downloadChapter(book, version); expect((await readDownload(version.id)).item.state).toBe('ready');
});
it('restores individual version history when the latest book position belongs to another chapter', async () => {
  await saveLocalProgress(book.id, position);
  await saveLocalProgress(book.id, { ...position, version_id: 'second', offset: 7, updated_at_ms: 300 });
  expect((await readVersionProgress(book.id, version.id, true))?.offset).toBe(2);
  expect((await readVersionProgress(book.id, 'second', true))?.offset).toBe(7);
  expect(await readVersionProgress(book.id, 'regenerated', true)).toBeNull();
});

const batchBook: BookDetail = { ...book, section_count: 3, sections: [0, 1, 2].map((position) => ({ ...book.sections[0], id: `section-${position}`, position, title: `Stored title ${position}` })) };
const batchVersions = batchBook.sections.map((s, i) => ({ ...version, id: `version-${i}`, section_id: s.id, audio_url: `/api/chapter-audio/audio-${i}` }));
function batchFetch() {
  fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
    const s = batchBook.sections.find((s) => url.endsWith(`/sections/${s.id}`));
    return s ? json({ ...section, ...s }) : new Response(options?.method === 'HEAD' ? null : wav(), { headers: { 'Content-Length': '244' } });
  });
}
const audioGets = () => fetchMock.mock.calls.filter(([url, options]) => url.includes('/chapter-audio/') && options?.method !== 'HEAD').map(([url]) => url);
it('batch chooses newest ready versions in book order and skips valid exact copies', async () => {
  batchFetch();
  expect(readyBookVersions(batchBook, [...batchVersions].reverse()).map((v) => v.id)).toEqual(batchVersions.map((v) => v.id));
  await downloadChapter(batchBook, batchVersions[0]); fetchMock.mockClear();
  await startBatch(batchBook, [...batchVersions].reverse());
  expect(audioGets()).toEqual(batchVersions.slice(1).map((v) => v.audio_url));
  expect(await get<DownloadBatch>('download_batches', book.id)).toMatchObject({ state: 'completed', completed: batchVersions.map((v) => v.id) });
});
it('batch cancellation completes the current chapter, then resumes remaining work without duplicates', async () => {
  batchFetch(); const original = fetchMock.getMockImplementation()!;
  let release!: (response: Response) => void;
  fetchMock.mockImplementation((url, options) => url === batchVersions[0].audio_url && options?.method !== 'HEAD'
    ? new Promise((resolve) => { release = resolve; }) : original(url, options));
  const pending = startBatch(batchBook, batchVersions);
  await vi.waitFor(() => expect(release).toBeDefined());
  await expect(startBatch(batchBook, batchVersions)).rejects.toThrow('already running');
  await cancelBatch(book.id); release(new Response(wav(), { headers: { 'Content-Length': '244' } })); await pending;
  expect(audioGets()).toEqual([batchVersions[0].audio_url]);
  expect(await get<DownloadBatch>('download_batches', book.id)).toMatchObject({ state: 'cancelled', completed: [batchVersions[0].id] });
  batchFetch(); fetchMock.mockClear(); await continueBatch(book.id);
  expect(audioGets()).toEqual(batchVersions.slice(1).map((v) => v.audio_url));
});
it('batch retains partial successes and retries only failed chapters', async () => {
  batchFetch(); Object.defineProperty(navigator, 'onLine', { value: true }); const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((url, options) => url === batchVersions[1].audio_url && options?.method !== 'HEAD' ? Promise.resolve(new Response('', { status: 503 })) : original(url, options));
  await startBatch(batchBook, batchVersions);
  expect(await get<DownloadBatch>('download_batches', book.id)).toMatchObject({ state: 'partial', completed: [batchVersions[0].id, batchVersions[2].id] });
  batchFetch(); fetchMock.mockClear(); await continueBatch(book.id);
  expect(audioGets()).toEqual([batchVersions[1].audio_url]);
  expect((await get<DownloadBatch>('download_batches', book.id))?.state).toBe('completed');
});
it('reopening reconstructs unfinished work from its fixed persisted versions', async () => {
  batchFetch(); await downloadChapter(batchBook, batchVersions[0]);
  await change<DownloadBatch>('download_batches', book.id, () => ({ book: batchBook, versions: batchVersions.slice(0, 2), state: 'running', completed: [], errors: {}, sizes: {} }));
  fetchMock.mockClear(); await continueBatch(book.id);
  expect(audioGets()).toEqual([batchVersions[1].audio_url]);
  expect((await get<DownloadBatch>('download_batches', book.id))?.versions).toHaveLength(2);
});
it('batch size preflight rejects insufficient storage and continuation can recover', async () => {
  batchFetch(); vi.stubGlobal('navigator', { onLine: false, storage: { estimate: async () => ({ quota: 400, usage: 0 }) } });
  await startBatch(batchBook, batchVersions);
  expect(audioGets()).toHaveLength(0);
  expect((await get<DownloadBatch>('download_batches', book.id))?.error).toMatch(/Not enough device storage/);
  vi.stubGlobal('navigator', { onLine: false, storage: { estimate: async () => ({ quota: 10000, usage: 0 }) } });
  await continueBatch(book.id); expect((await get<DownloadBatch>('download_batches', book.id))?.state).toBe('completed');
});
it('a changed audio version is downloaded separately and preserves the old device version', async () => {
  batchFetch(); await startBatch(batchBook, [batchVersions[0]]);
  const replacement = { ...batchVersions[0], id: 'replacement' };
  fetchMock.mockClear(); await startBatch(batchBook, [replacement, ...batchVersions]);
  expect((await readDownload(batchVersions[0].id)).item.state).toBe('ready');
  expect((await readDownload(replacement.id)).item.state).toBe('ready');
  expect((await get<DownloadBatch>('download_batches', book.id))?.versions[0].id).toBe('replacement');
});
it('a quota error after successful preflight preserves completed downloads', async () => {
  batchFetch(); const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'audio' && key === batchVersions[1].id) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    return original.call(this, value, key);
  });
  await startBatch(batchBook, batchVersions);
  expect((await readDownload(batchVersions[0].id)).item.state).toBe('ready');
  expect((await get<DownloadBatch>('download_batches', book.id))?.state).toBe('partial');
  expect((await get<DownloadBatch>('download_batches', book.id))?.errors[batchVersions[1].id]).toMatch(/storage|transaction/i);
});
it('a batch held in another tab cannot be submitted again', async () => {
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: null) => Promise<void>) => work(null) } });
  await expect(startBatch(batchBook, batchVersions)).rejects.toThrow('another tab');
  expect(await get<DownloadBatch>('download_batches', book.id)).toBeUndefined();
});
