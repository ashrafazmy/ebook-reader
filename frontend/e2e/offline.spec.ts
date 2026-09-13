import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, expect, chromium, type BrowserContext } from '@playwright/test';
const book = { id: 'book', title: 'Offline lake', author: 'Synthetic fixture', section_count: 1,
  sections: [{ id: 'section', title: 'The lake', position: 0, spine_position: 0 }] };
const section = { ...book.sections[0], blocks: [{ id: 'block', kind: 'paragraph', heading_level: null, position: 0, text: 'The little boat crossed the quiet lake.' }] };
const job = { id: 'version', section_id: 'section', profile_id: 'voice', profile_name: 'Test voice', model_name: 'model', state: 'ready', completed: 1, total: 1, error: null, audio_url: '/api/chapter-audio/wav', duration: 10 };
function wav() {
  const bytes = Buffer.alloc(480044); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(480000, 40); return bytes;
}
async function fixture(context: BrowserContext) {
  let progress: Record<string, unknown> | null = null;
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/chapter-audio/wav') { await route.fulfill({ status: 200, contentType: 'audio/wav', body: wav() }); return; }
    let body: unknown;
    if (path === '/api/health') body = { status: 'ok' };
    else if (path === '/api/books') body = [book];
    else if (path === '/api/books/book') body = book;
    else if (path === '/api/books/book/sections/section') body = section;
    else if (path === '/api/chapters') body = [job];
    else if (path === '/api/books/book/listening-progress') {
      if (route.request().method() === 'PUT') progress = { ...route.request().postDataJSON(), section_id: 'section' };
      body = progress;
    } else if (path === '/api/voicebox/profiles') body = { profiles: [] };
    else { await route.fulfill({ status: 404, json: { detail: 'Fixture route unavailable' } }); return; }
    await route.fulfill({ status: 200, json: body });
  });
  return () => progress;
}

test('production shell starts offline, downloaded text/audio survive a closed page, seeking and progress sync work', async ({ page, context }, testInfo) => {
  const serverProgress = await fixture(context);
  await page.goto('/#book=book');
  await page.getByText('Install / offline setup', { exact: true }).click();
  await expect(page.getByText(/Offline app shell ready/).first()).toBeVisible();
  await page.locator('.generation-details > summary').click();
  await page.getByRole('button', { name: 'Download for offline', exact: true }).click();
  await expect(page.getByText(/^Available offline/)).toBeVisible();
  // The only cached requests are built shell assets, never API or Vite development modules.
  const cached = await page.evaluate(async () => { const result: string[] = []; for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) result.push(request.url); return result; });
  expect(cached.some((url) => url.includes('/api/') || url.includes('/@vite/') || url.includes('/src/'))).toBe(false);
  await page.close();
  await context.unrouteAll(); await context.setOffline(true);
  const offline = await context.newPage(); await offline.goto('/#download=version');
  await expect(offline.getByRole('article')).toContainText(section.blocks[0].text);
  await offline.getByRole('button', { name: 'Load downloaded chapter in player' }).click();
  const audio = offline.locator('audio'); await expect(audio).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState)).toBeGreaterThan(0);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.duration)).toBe(10);
  await audio.dispatchEvent('pointerdown');
  await audio.evaluate((el: HTMLAudioElement) => { el.currentTime = 4; });
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBe(4);
  await offline.getByLabel('Playback speed', { exact: true }).selectOption('1.5');
  // Native decoding/play promise is exercised; the test WAV is silence, not generated speech.
  await audio.evaluate((el: HTMLAudioElement) => el.play()); await audio.evaluate((el: HTMLAudioElement) => el.pause());
  await expect(offline.getByText(/listening position\(s\) waiting to sync/)).toBeVisible();
  await offline.reload();
  await expect(offline.locator('audio')).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => offline.locator('audio').evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThanOrEqual(4);
  expect(await offline.locator('audio').evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  expect(await offline.locator('audio').evaluate((el: HTMLAudioElement) => el.playbackRate)).toBe(1.5);
  expect(await offline.locator('audio').count()).toBe(1);
  for (const width of [320, 390, 430, 1280]) {
    await offline.setViewportSize({ width, height: 844 });
    expect(await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 320 || width === 1280) await offline.screenshot({ path: testInfo.outputPath(`offline-${width}.png`), fullPage: true });
  }
  await fixture(context); // Reconnect to an empty server progress record.
  await context.setOffline(false); await offline.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(offline.getByText(/listening position\(s\) waiting to sync/)).toHaveCount(0);
  // The original fixture was offline and received no accidental save.
  expect(serverProgress()).toBeNull();
  await offline.goto('/#downloads'); await offline.getByRole('button', { name: 'Remove device download', exact: true }).click();
  await expect(offline.getByText(/No chapters downloaded/)).toBeVisible();
  await offline.goto('/#download=version'); await expect(offline.getByRole('alert').filter({ hasText: 'not available offline' })).toBeVisible();
});

test('a failed download is unavailable offline and can be retried without duplicate audio players', async ({ page, context }) => {
  await fixture(context);
  await context.route('**/api/chapter-audio/wav', (route) => route.fulfill({ status: 503 }));
  await page.goto('/#book=book'); await page.locator('.generation-details > summary').click();
  await page.getByRole('button', { name: 'Download for offline', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Audio download failed' })).toBeVisible();
  await expect(page.getByText(/^Available offline/)).toHaveCount(0);
  await context.unroute('**/api/chapter-audio/wav');
  await page.getByRole('button', { name: 'Retry device download' }).click(); await expect(page.getByText(/^Available offline/)).toBeVisible();
  await page.getByRole('button', { name: 'Load chapter in player', exact: true }).click();
  await expect(page.locator('audio')).toHaveAttribute('src', /^blob:/); await expect(page.locator('audio')).toHaveCount(1);
});


test('an update waits without reloading the active player', async ({ page, context }) => {
  await fixture(context); await page.goto('/#book=book');
  await page.getByText('Install / offline setup', { exact: true }).click();
  await expect(page.getByText(/Offline app shell ready/).first()).toBeVisible();
  await page.locator('.generation-details > summary').click();
  await page.getByRole('button', { name: 'Download for offline', exact: true }).click();
  await expect(page.getByText(/^Available offline/)).toBeVisible();
  await page.getByRole('button', { name: 'Load chapter in player', exact: true }).click();
  await page.locator('audio').evaluate((el: HTMLAudioElement) => el.play());
  await page.evaluate(() => { document.documentElement.dataset.updateProbe = 'same-page'; });
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
  const path = resolve('dist/sw.js'), original = await readFile(path, 'utf8');
  try {
    await writeFile(path, original.replace(/reader-shell-[a-f0-9]+/, 'reader-shell-update-test'));
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect(page.getByText(/A new app version is ready/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.updateProbe)).toBe('same-page');
    expect(await page.locator('audio').evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
    await expect.poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
    await page.close();
    const updated = await context.newPage(); await updated.goto('/#download=version');
    await expect(updated.getByRole('article')).toContainText(section.blocks[0].text);
  } finally { await writeFile(path, original); }
});

test('a fresh browser process reopens downloaded text and audio with its network disabled', async ({}, testInfo) => {
  const profile = testInfo.outputPath('device-profile'); await mkdir(profile, { recursive: true });
  let device = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 320, height: 740 } });
  try {
    await fixture(device); const page = await device.newPage();
    await page.goto('http://127.0.0.1:4175/#book=book');
    await page.getByText('Install / offline setup', { exact: true }).click();
    await expect(page.getByText(/Offline app shell ready/).first()).toBeVisible();
    await page.locator('.generation-details > summary').click();
    await page.getByRole('button', { name: 'Download for offline', exact: true }).click();
    await expect(page.getByText(/^Available offline/)).toBeVisible();
    await device.close();
    device = await chromium.launchPersistentContext(profile, { headless: true, offline: true, viewport: { width: 320, height: 740 } });
    const offline = await device.newPage(); await offline.goto('http://127.0.0.1:4175/#download=version');
    await expect(offline.getByRole('article')).toContainText(section.blocks[0].text);
    await offline.getByRole('button', { name: 'Load downloaded chapter in player' }).click();
    await expect(offline.locator('audio')).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => offline.locator('audio').evaluate((el: HTMLAudioElement) => el.readyState)).toBeGreaterThan(0);
    expect(await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await device.close(); }
});

test('offline player follows adjacent order, exposes gaps and selects exact downloaded versions with matching text and progress', async ({ page, context }, testInfo) => {
  const sections = [0, 1, 2, 3].map((position) => ({ id: `s${position}`, title: `A very long chapter title ${position + 1} ${'across the quiet lake '.repeat(8)}`, position, spine_position: position }));
  const libraryBook = { ...book, title: 'A very long book title '.repeat(12), sections, section_count: 4 };
  const jobs = sections.map((s, i) => ({ ...job, id: `v${i}`, section_id: s.id }));
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/chapter-audio/wav') { await route.fulfill({ contentType: 'audio/wav', body: wav() }); return; }
    const s = sections.find((item) => path.endsWith(`/sections/${item.id}`));
    const body = s ? { ...s, blocks: [{ ...section.blocks[0], text: `Stored wording for chapter ${s.position + 1}.` }] }
      : path === '/api/books/book' ? libraryBook : path === '/api/chapters' ? jobs
      : path.endsWith('/listening-progress') ? null : path.endsWith('/profiles') ? { profiles: [] } : path === '/api/books' ? [libraryBook] : { status: 'ok' };
    await route.fulfill({ json: body });
  });
  await page.goto('/#book=book');
  await page.locator('.generation-details > summary').click();
  // Download 1, 2 and 4, deliberately leaving a gap at chapter 3.
  for (const index of [0, 1, 3]) {
    await page.getByRole('combobox', { name: 'Section', exact: true }).selectOption(String(index));
    await page.getByRole('button', { name: 'Download for offline', exact: true }).click();
    await expect(page.getByText(/^Available offline/)).toBeVisible();
  }
  await page.goto('/#download=v0');
  await context.unrouteAll(); await context.setOffline(true);
  await page.getByRole('button', { name: 'Load downloaded chapter in player' }).click();
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.readyState)).toBeGreaterThan(0);
  await audio.dispatchEvent('pointerdown');
  await audio.evaluate((el: HTMLAudioElement) => { el.currentTime = 3; });
  await page.getByLabel('Playback speed', { exact: true }).selectOption('1.5');
  await expect(page.getByText(/listening position\(s\) waiting to sync/)).toBeVisible();
  await page.getByRole('button', { name: 'Next audio chapter' }).click();
  await expect(page).toHaveURL(/download=v1/);
  await expect(page.getByRole('article')).toHaveText('Stored wording for chapter 2.');
  await expect(page.locator('.playing-title summary strong')).toContainText('Chapter 2:');
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  await page.getByRole('button', { name: 'Next audio chapter' }).click();
  await expect(page.locator('.playback-dock')).toContainText('is not downloaded');
  await expect(page).toHaveURL(/download=v1/);
  await audio.evaluate((el: HTMLAudioElement) => el.play());
  await page.getByLabel('Downloaded chapters for playing book').selectOption('v3');
  await expect(page).toHaveURL(/download=v3/);
  await expect(page.getByRole('article')).toHaveText('Stored wording for chapter 4.');
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(false);
  await audio.evaluate((el: HTMLAudioElement) => el.pause());
  await page.getByLabel('Downloaded chapters for playing book').selectOption('v0');
  await expect(page).toHaveURL(/download=v0/);
  await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBe(3);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.playbackRate)).toBe(1.5);
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
  for (const width of [320, 390, 430, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.playing-title summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`long-title-${width}.png`), fullPage: true });
    await page.locator('.playing-title summary').click();
  }
  // Evict only the next audio Blob: the selector must invalidate it and keep current audio/text.
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('epub-reader-device');
      request.onsuccess = () => { const db = request.result; const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').delete('v1'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
  });
  await page.getByLabel('Downloaded chapters for playing book').selectOption('v1');
  await expect(page.locator('.playback-dock')).toContainText('not available offline');
  await expect(page.getByLabel('Downloaded chapters for playing book').locator('option[value="v1"]')).toHaveCount(0);
  await expect(page).toHaveURL(/download=v0/);
  await expect(audio).toHaveCount(1);
  await audio.evaluate((el: HTMLAudioElement) => el.play());
  await page.evaluate(() => { HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError')); });
  await page.getByLabel('Downloaded chapters for playing book').selectOption('v3');
  await expect(page.locator('.playback-dock')).toContainText('Press Play to continue');
  expect(await audio.evaluate((el: HTMLAudioElement) => el.paused)).toBe(true);
});

test('book actions preserve single downloads and snapshot only currently ready versions across navigation', async ({ page, context }) => {
  const sections = [0, 1, 2].map((position) => ({ ...book.sections[0], id: `batch-s${position}`, title: `Original title ${position}`, position, spine_position: position }));
  const batchBook = { ...book, sections, section_count: 3 };
  const versions = sections.map((s, i) => ({ ...job, id: `batch-v${i}`, section_id: s.id, audio_url: `/api/chapter-audio/batch-${i}`, state: i === 2 ? 'queued' : 'ready' }));
  const downloaded: string[] = [];
  let submitBody: unknown;
  let release: (() => void) | undefined;
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/chapter-audio/')) {
      if (route.request().method() === 'HEAD') { await route.fulfill({ headers: { 'Content-Length': String(wav().length) }, body: '' }); return; }
      downloaded.push(path);
      if (path.endsWith('batch-1')) await new Promise<void>((resolve) => { release = resolve; });
      await route.fulfill({ contentType: 'audio/wav', body: wav() }); return;
    }
    const s = sections.find((s) => path.endsWith(`/sections/${s.id}`));
    let body: unknown = s ? { ...section, ...s } : path === '/api/books/book' ? batchBook : path === '/api/chapters' ? versions
      : path.endsWith('/listening-progress') ? null : path === '/api/books' ? [batchBook] : { status: 'ok' };
    if (path.endsWith('/profiles')) body = { profiles: [{ id: 'voice', name: 'Test voice', models: [{ id: 'model', name: 'Model', downloaded: true }] }] };
    if (path === '/api/books/book/chapters') {
      submitBody = route.request().postDataJSON();
      body = { results: versions.map((job) => ({ section_id: job.section_id, job, error: null })) };
    }
    await route.fulfill({ json: body });
  });
  await page.goto('/#book=book');
  await page.locator('.generation-details > summary').click();
  await page.getByRole('button', { name: 'Download for offline', exact: true }).click();
  await expect(page.getByText(/^Available offline/)).toBeVisible();
  await page.locator('.book-audio-actions > summary').click();
  await page.getByRole('button', { name: 'Generate all chapters', exact: true }).click();
  await expect(page.getByText(/3 chapters queued or already tracked/)).toBeVisible();
  expect(submitBody).toEqual({ profile_id: 'voice', model_name: 'model' });
  await expect(page.getByText(/2 completed · 1 queued/)).toBeVisible();
  await page.getByRole('button', { name: 'Download all available audio', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  versions[2].state = 'ready'; // Not part of the plan already saved on this device.
  await page.goto('/#downloads');
  await expect(page.locator('.batch-downloads > summary')).toContainText('1 / 2 chapters downloaded');
  release!();
  await expect(page.locator('.batch-downloads > summary')).toContainText('2 / 2 chapters downloaded · completed');
  expect(downloaded).toEqual(['/api/chapter-audio/batch-0', '/api/chapter-audio/batch-1']);
  await page.reload(); await expect(page.locator('.batch-downloads > summary')).toContainText('2 / 2');
  await page.goto('/#book=book'); await page.locator('.generation-details > summary').click(); await page.locator('.book-audio-actions > summary').click();
  await page.getByRole('button', { name: 'Download audiobook', exact: true }).click();
  await expect(page.locator('.batch-downloads > summary')).toContainText('3 / 3 chapters downloaded · completed');
  expect(downloaded).toEqual(['/api/chapter-audio/batch-0', '/api/chapter-audio/batch-1', '/api/chapter-audio/batch-2']);
  await context.unrouteAll(); await context.setOffline(true);
  await page.goto('/#download=batch-v2');
  await expect(page.getByRole('article')).toContainText(section.blocks[0].text);
  await page.getByRole('button', { name: 'Load downloaded chapter in player' }).click();
  await expect(page.locator('audio')).toHaveAttribute('src', /^blob:/);
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
