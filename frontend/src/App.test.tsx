// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';

const book = { id: 'book', title: 'Synthetic book', author: 'Test author', section_count: 1,
  sections: [{ id: 'section', title: 'First chapter', position: 0, spine_position: 0 }] };
const blocks = [
  { id: 'heading', kind: 'heading', heading_level: 2, position: 0, text: 'First chapter' },
  { id: 'paragraph-1', kind: 'paragraph', heading_level: null, position: 1, text: 'The little boat crossed the quiet lake.' },
  { id: 'paragraph-2', kind: 'paragraph', heading_level: null, position: 2, text: 'Nobody changed these words.' },
];
const baseJob = { id: 'chapter-job', section_id: 'section', profile_id: 'voice', profile_name: 'Test voice', model_name: 'model',
  state: 'queued', completed: 0, total: 2, error: null, audio_url: null as string | null, duration: null as number | null };
let jobs: typeof baseJob[], offline: boolean, host: HTMLDivElement, root: Root;
let progress: { version_id: string; section_id: string; offset: number; speed: number } | null;
const fetchMock = vi.fn();
function button(label: string) { return Array.from(host.querySelectorAll('button')).find((el) => el.textContent === label)!; }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function navigate(hash: string) {
  await act(async () => { history.replaceState(null, '', hash || location.pathname); window.dispatchEvent(new HashChangeEvent('hashchange')); });
}
async function mount() { await act(async () => root.render(<App />)); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(1);
  vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(120);
  localStorage.clear(); history.replaceState(null, '', location.pathname);
  jobs = []; progress = null; offline = false;
  fetchMock.mockReset().mockImplementation(async (url: string, options?: RequestInit) => {
    let value: unknown;
    if (url === '/api/health') value = { status: 'ok' };
    else if (url === '/api/books') value = [book];
    else if (url === '/api/books/book') value = book;
    else if (url === '/api/books/book/sections/section') value = { ...book.sections[0], blocks };
    else if (url === '/api/books/book/listening-progress') {
      if (options?.method === 'PUT') progress = { ...JSON.parse(options.body as string), section_id: 'section' };
      value = progress;
    } else if (url === '/api/chapters?book_id=book') value = [...jobs];
    else if (url === '/api/voicebox/profiles') {
      if (offline) throw new TypeError('Voicebox offline');
      value = { profiles: [{ id: 'voice', name: 'Test voice', models: [{ id: 'model', name: 'Model', downloaded: true }] }] };
    } else if (url === '/api/chapters' && options?.method === 'POST') { jobs = [{ ...baseJob }]; value = jobs[0]; }
    else if (url === '/api/chapters/chapter-job/cancel') { jobs = [{ ...jobs[0], state: 'cancelled' }]; value = jobs[0]; }
    else if (url === '/api/chapters/chapter-job/retry') { jobs = [{ ...jobs[0], state: 'queued' }]; value = jobs[0]; }
    else throw new Error(`Unexpected API call: ${url}`);
    return { ok: true, json: async () => value };
  });
  vi.stubGlobal('fetch', fetchMock);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([360, 1280])('renders chapter-only bookshelf/reader controls at a %ipx window width (DOM check)', async (width) => {
  vi.stubGlobal('innerWidth', width);
  await mount(); expect(host.textContent).not.toMatch(/Paragraph narration|Narrate this paragraph|Generate narration/);
  await navigate('#book=book');
  expect(button('Generate chapter')).toBeTruthy(); expect(host.querySelector('summary')?.textContent).toContain('Chapter audio');
  expect(host.textContent).not.toMatch(/Paragraph narration|Narrate this paragraph|Generate narration/);
  expect(host.querySelectorAll('article button, article audio, [aria-pressed]')).toHaveLength(0);
  expect(Array.from(host.querySelectorAll('article p')).map((p) => p.textContent)).toEqual(blocks.slice(1).map((p) => p.text));
  const paragraph = host.querySelector('#block-paragraph-1')!;
  expect(paragraph.getAttribute('data-block-id')).toBe('paragraph-1');
  const range = document.createRange(); range.selectNodeContents(paragraph);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  expect(window.getSelection()!.toString()).toBe(blocks[1].text);
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/narrations'))).toBe(false);
});

it('keeps chapter generation, queued status, cancellation and retry wired to chapter APIs', async () => {
  await mount(); await navigate('#book=book');
  expect(button('Generate chapter').disabled).toBe(false); await click(button('Generate chapter'));
  const create = fetchMock.mock.calls.find(([url, options]) => url === '/api/chapters' && options?.method === 'POST')!;
  expect(JSON.parse(create[1].body)).toEqual({ section_id: 'section', profile_id: 'voice', model_name: 'model', replace: false });
  expect(host.querySelector('summary')?.textContent).toContain('queued · 0 of 2');
  expect(button('Generate chapter').disabled).toBe(true);
  await click(button('Cancel remaining work')); expect(host.textContent).toContain('cancelled');
  await click(button('Retry / resume remaining work')); expect(host.querySelector('summary')?.textContent).toContain('queued');
});

it('restores one cached chapter player with Voicebox offline and retains it across real app navigation', async () => {
  offline = true; jobs = [{ ...baseJob, state: 'ready', completed: 2, audio_url: '/api/chapter-audio/saved', duration: 120 }];
  progress = { version_id: baseJob.id, section_id: 'section', offset: 23, speed: 1.5 };
  await mount(); await navigate('#book=book');
  const player = host.querySelector('audio')!;
  expect(player.getAttribute('src')).toBe('/api/chapter-audio/saved'); expect(player.controls).toBe(true);
  await act(async () => player.dispatchEvent(new Event('loadedmetadata')));
  expect(player.currentTime).toBe(23); expect(player.playbackRate).toBe(1.5);
  await navigate(''); expect(host.querySelector('audio')).toBe(player);
  await navigate('#book=book'); expect(host.querySelector('audio')).toBe(player);
  expect(host.querySelectorAll('audio')).toHaveLength(1);
  expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});
