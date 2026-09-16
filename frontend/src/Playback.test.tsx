// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PlaybackProvider, { chapterTrack, usePlayback, type ChapterVersion } from './Playback';
import type { BookDetail } from './api';
const book: BookDetail = { id: 'book', title: 'Test book', author: 'Author', section_count: 2,
  sections: [{ id: 'a', title: 'First', position: 0, spine_position: 0 }, { id: 'b', title: 'Second', position: 1, spine_position: 1 }] };
const version: ChapterVersion = { id: 'v1', section_id: 'a', profile_id: 'voice', profile_name: 'Voice', model_name: 'model', state: 'ready', audio_url: '/api/chapter-audio/audio1' };
const nextVersion = { ...version, id: 'v2', section_id: 'b', audio_url: '/api/chapter-audio/audio2' };
let root: Root, host: HTMLDivElement, playback: ReturnType<typeof usePlayback>;
const fetchMock = vi.fn<(url: string, options?: RequestInit) => Promise<{ ok: boolean; json: () => Promise<unknown> }>>();
const playMock = vi.fn<() => Promise<void>>();
const pauseMock = vi.fn();
function Consumer({ page }: { page: string }) { playback = usePlayback(); return <div>{page}</div>; }
async function render(page = 'reader') { await act(async () => root.render(<PlaybackProvider><Consumer key={page} page={page} /></PlaybackProvider>)); }
async function fire(element: EventTarget, name: string) { await act(async () => { element.dispatchEvent(new Event(name, { bubbles: true })); }); }
function player() { return host.querySelector('audio')!; }
async function load() { await render(); await act(async () => playback.load(chapterTrack(book, version))); await fire(player(), 'loadedmetadata'); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  localStorage.clear(); window.location.hash = '';
  fetchMock.mockReset().mockResolvedValue({ ok: true, json: async () => null });
  playMock.mockReset().mockResolvedValue(); pauseMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pauseMock);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(playMock);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(1);
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(120);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('lists server-ready chapters when reachable and falls back to device downloads when the server is unreachable', async () => {
  vi.useFakeTimers();
  try {
  const serverVersion = { ...version, id: 'v3', section_id: 'b', audio_url: '/api/chapter-audio/audio3' };
  fetchMock.mockImplementation(async (url) => ({ ok: true, json: async () => url.includes('chapters?') ? [version, nextVersion, serverVersion] : null }));
  await load(); await act(async () => {});
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Chapters for playing book"]')!;
  const options = Array.from(select.options).map((option) => option.textContent);
  expect(options).toEqual(['First', 'Second', 'Second']);
  await act(async () => { select.value = serverVersion.id; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => {});
  expect(player().getAttribute('src')).toBe(serverVersion.audio_url);
  // Server unreachable: only device downloads remain (none exist in this jsdom run).
  fetchMock.mockRejectedValue(new TypeError('offline'));
  await act(async () => { await vi.advanceTimersByTimeAsync(5500); });
  const select2 = host.querySelector<HTMLSelectElement>('select[aria-label="Chapters for playing book"]')!;
  expect(Array.from(select2.options).map((o) => o.textContent)).toEqual(['Choose a chapter']);
  } finally { vi.useRealTimers(); }
});
it('keeps the single audio element and active source while the server list refreshes', async () => {
  fetchMock.mockImplementation(async (url) => ({ ok: true, json: async () => url.includes('chapters?') ? [version] : null }));
  await load(); const audio = player();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(host.querySelector('audio')).toBe(audio);
  expect(audio.getAttribute('src')).toBe(version.audio_url);
  expect(host.querySelectorAll('audio')).toHaveLength(1);
});
it('keeps the same player and source across page navigation', async () => {
  await load(); const original = player(); await fire(original, 'play');
  await render('bookshelf'); await render('another book');
  expect(player()).toBe(original); expect(player().getAttribute('src')).toBe(version.audio_url);
  expect(pauseMock).not.toHaveBeenCalled();
});
it('pauses for explicit replacement and ignores background restoration while audio is selected', async () => {
  await load(); await act(async () => playback.load(chapterTrack(book, { ...version, id: 'replacement', audio_url: '/api/chapter-audio/replacement' })));
  expect(host.querySelectorAll('audio')).toHaveLength(1); expect(pauseMock).toHaveBeenCalledTimes(1);
  await act(async () => playback.load(chapterTrack(book, version), true));
  expect(player().getAttribute('src')).toBe('/api/chapter-audio/replacement');
});
it('restores saved version, position and speed without autoplay or writing untouched progress', async () => {
  localStorage.setItem('reader-listening-book', book.id);
  fetchMock.mockImplementation(async (url) => ({ ok: true, json: async () => url.includes('listening-progress') ? { version_id: 'v1', section_id: 'a', offset: 31, speed: 1.5 } : url.includes('chapters?') ? [version] : book }));
  await render(); await fire(player(), 'loadedmetadata'); await fire(player(), 'seeked');
  expect(player().currentTime).toBe(31); expect(player().playbackRate).toBe(1.5); expect(playMock).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(0);
});
it('saves the exact version, offset and speed on seek, pause and page exit', async () => {
  await load(); await fire(player(), 'pointerdown'); player().currentTime = 18; player().playbackRate = 1.25;
  await fire(player(), 'seeked'); await fire(player(), 'pause'); await fire(window, 'pagehide');
  const saves = fetchMock.mock.calls.filter((call) => call[1]?.method === 'PUT');
  expect(saves).toHaveLength(3);
  const payload = (index: number) => JSON.parse(saves[index][1]!.body as string);
  expect(payload(2)).toMatchObject({ version_id: 'v1', offset: 18, speed: 1.25 });
  expect(payload(2).updated_at_ms).toBeGreaterThan(payload(0).updated_at_ms);
});
it('continues in order and explains a rejected automatic playback request', async () => {
  fetchMock.mockImplementation(async (url) => ({ ok: true, json: async () => url.includes('chapters?') ? [version, nextVersion] : null }));
  await load(); await fire(player(), 'play'); await fire(player(), 'ended');
  expect(player().getAttribute('src')).toBe(nextVersion.audio_url);
  playMock.mockRejectedValueOnce(new Error('NotAllowedError')); await fire(player(), 'loadedmetadata');
  expect(host.textContent).toContain('Press Play to continue');
});
it('explains missing next audio without submitting generation', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => [version] });
  await load(); await fire(player(), 'play'); await fire(player(), 'ended');
  expect(host.textContent).toContain('no ready audio'); expect(player().getAttribute('src')).toBe(version.audio_url);
  expect(fetchMock.mock.calls.some((call) => call[1]?.method === 'POST')).toBe(false);
});
it('ignores a delayed next-chapter response after the user selects a different chapter version', async () => {
  let resolve!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
  fetchMock.mockImplementation((url) => url.includes('chapters?') ? new Promise((done) => { resolve = done; }) : Promise.resolve({ ok: true, json: async () => null }));
  await load(); await fire(player(), 'play'); await fire(player(), 'ended');
  await act(async () => playback.load(chapterTrack(book, { ...version, id: 'replacement', audio_url: '/api/chapter-audio/replacement' })));
  await act(async () => resolve({ ok: true, json: async () => [nextVersion] }));
  expect(player().getAttribute('src')).toBe('/api/chapter-audio/replacement'); expect(playMock).not.toHaveBeenCalled();
});
it('reports a failed progress save and retries against the same audio version', async () => {
  await load(); await fire(player(), 'pointerdown'); player().currentTime = 12;
  fetchMock.mockRejectedValueOnce(new TypeError('offline')); await fire(player(), 'pause');
  expect(host.textContent).toContain('Position could not be saved');
  const retry = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Retry save')!;
  await fire(retry, 'click');
  expect(host.textContent).not.toContain('Position could not be saved');
  const last = fetchMock.mock.calls.at(-1)!;
  expect(JSON.parse(last[1]!.body as string)).toMatchObject({ version_id: 'v1', offset: 12 });
});
async function sizeButton() { return Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Minimize' || button.textContent === 'Expand')!; }
it('minimizes to a compact bar without touching the audio element and restores all controls on expand', async () => {
  await load(); const audio = player(); const src = audio.getAttribute('src');
  const pausedMock = vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
  try {
  await fire(audio, 'play'); audio.currentTime = 42; audio.playbackRate = 1.5;
  let button = await sizeButton();
  expect(button.getAttribute('aria-expanded')).toBe('true'); expect(button.getAttribute('aria-controls')).toBe('playback-controls');
  await fire(button, 'click');
  expect(host.querySelector('audio')).toBe(audio); expect(audio.getAttribute('src')).toBe(src);
  expect(audio.paused).toBe(false); expect(audio.currentTime).toBe(42); expect(audio.playbackRate).toBe(1.5);
  expect(host.querySelector('.playback-dock')!.className).toContain('compact');
  expect((host.querySelector('#playback-controls') as HTMLElement)!.hidden).toBe(true);
  for (const selector of ['select[aria-label="Chapters for playing book"]', 'select[aria-label="Playback speed"]', 'button[aria-label="Next audio chapter"]', 'button[aria-label="Previous audio chapter"]'])
    expect((host.querySelector(selector)!.closest('#playback-controls') as HTMLElement)!.hidden).toBe(true);
  expect(pauseMock).not.toHaveBeenCalled(); expect(playMock).not.toHaveBeenCalled(); expect(audio.getAttribute('src')).toBe(src);
  button = await sizeButton(); expect(button.textContent).toBe('Expand'); expect(button.getAttribute('aria-expanded')).toBe('false');
  await fire(button, 'click');
  expect(host.querySelector('.playback-dock')!.className).not.toContain('compact');
  expect((host.querySelector('#playback-controls') as HTMLElement)!.hidden).toBe(false);
  expect(host.querySelector('audio')).toBe(audio); expect(audio.getAttribute('src')).toBe(src);
  expect(audio.paused).toBe(false); expect(audio.currentTime).toBe(42); expect(audio.playbackRate).toBe(1.5);
  expect(pauseMock).not.toHaveBeenCalled(); expect(playMock).not.toHaveBeenCalled();
  } finally { pausedMock.mockRestore(); }
});
it('keeps the compact view across page navigation and keeps playback errors visible while minimized', async () => {
  fetchMock.mockImplementation(async (url) => ({ ok: true, json: async () => url.includes('chapters?') ? [version, nextVersion] : null }));
  const pausedMock = vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockReturnValue(false);
  try {
  await load(); const audio = player(); await fire(audio, 'play');
  await fire(await sizeButton(), 'click');
  await render('bookshelf'); await render('reader');
  expect(host.querySelector('.playback-dock')!.className).toContain('compact');
  expect((await sizeButton()).textContent).toBe('Expand');
  expect(host.querySelector('audio')).toBe(audio); expect(audio.paused).toBe(false); expect(audio.getAttribute('src')).toBe(version.audio_url);
  playMock.mockRejectedValueOnce(new Error('NotAllowedError'));
  await fire(audio, 'ended'); await fire(player(), 'loadedmetadata');
  expect(host.querySelector('.playback-dock')!.className).toContain('compact');
  expect(host.querySelector('.playback-dock p[role="status"]')!.textContent).toContain('Press Play to continue');
  } finally { pausedMock.mockRestore(); }
});
