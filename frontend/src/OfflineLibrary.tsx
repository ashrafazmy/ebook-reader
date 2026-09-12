import { createElement, useEffect, useState } from 'react';
import type { BookDetail } from './api';
import { usePlayback, type ChapterVersion } from './Playback';
import { downloadChapter, isDownloading, readDownload, removeDownload, type Download } from './downloads';
import { useDownloads } from './useDownloads';
import { useOnline } from './useOnline';

function size(bytes: number) { return `${bytes.toLocaleString()} bytes`; }
export function TransferProgress({ item }: { item: Download }) {
  const received = item.receivedBytes ?? 0;
  return <div className="transfer-progress">
    <span>{item.phase === 'saving' ? 'Saving offline copy…' : item.phase === 'verifying' ? 'Verifying offline copy…' : 'Downloading audio…'} {size(received)}{item.totalBytes ? ` / ${size(item.totalBytes)} (${Math.floor(received / item.totalBytes * 100)}%)` : ' · total size unknown'}</span>
    <progress aria-label="Audio download progress" max={item.totalBytes || 1} value={item.phase === 'transferring' && item.totalBytes ? received : undefined} />
  </div>;
}
export function DownloadActivity() {
  const { items } = useDownloads();
  if (!items.some((item) => item.state === 'downloading' || item.state === 'failed')) return null;
  return <section aria-label="Device download activity">{items.filter((item) => item.state === 'downloading' || item.state === 'failed').map((item) =>
    <div key={item.id}><a href="#downloads">{item.book.title} · {item.book.sections.find((s) => s.id === item.version.section_id)?.title}</a>
      {isDownloading(item.id) ? <TransferProgress item={item} /> : <p>{item.state === 'failed' ? 'Download failed.' : 'Download interrupted.'} Open Device downloads to retry.</p>}
    </div>)}</section>;
}
export function DownloadControl({ book, version }: { book: BookDetail; version: ChapterVersion }) {
  const { items, error: storageError } = useDownloads();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const online = useOnline();
  const item = items.find((row) => row.id === version.id);
  async function download() { setBusy(true); setError(''); try { await downloadChapter(book, version); } catch (error) { setError(error instanceof Error ? error.message : 'Download failed.'); } finally { setBusy(false); } }
  async function remove() { setError(''); try { await removeDownload(version.id); } catch { setError('Could not remove the device download. Try again.'); } }
  const working = busy || isDownloading(version.id);
  return <div className="download-controls">
    <p>{item?.state === 'ready' ? 'Available offline' : item?.state === 'removed' ? 'Removed from device' : item?.state === 'failed' ? 'Download failed' : item?.state === 'downloading' ? working ? 'Downloading…' : 'Download interrupted — retry to finish' : 'Not downloaded to this device'}{item?.state === 'ready' && item.bytes ? ` · ${size(item.bytes)}` : ''} · version {version.id.slice(0, 8)}</p>
    {item?.state === 'downloading' && working && <TransferProgress item={item} />}
    {item?.state !== 'ready' && <button className="secondary" disabled={working || !online || !!storageError} onClick={() => void download()}>{item ? 'Retry device download' : 'Download for offline'}</button>}
    {item && item.state !== 'removed' && <button className="secondary" onClick={() => void remove()}>{working ? 'Cancel device download' : 'Remove device download'}</button>}
    {item?.state === 'ready' && <a href={`#download=${version.id}`}>Open downloaded chapter</a>}
    {(error || storageError || item?.error) && <p className="error" role="alert">{error || storageError || item?.error}</p>}
  </div>;
}

export default function OfflineLibrary({ downloadId }: { downloadId?: string | null }) {
  const { items, error } = useDownloads();
  const [selected, setSelected] = useState<Download | null>(null);
  const [readError, setReadError] = useState('');
  const [fontSize, setFontSize] = useState(16);
  const [persistence, setPersistence] = useState('');
  const playback = usePlayback();
  const ready = items.filter((row) => row.state === 'ready').sort((a, b) => a.book.title.localeCompare(b.book.title) || (a.section?.position ?? 0) - (b.section?.position ?? 0));
  useEffect(() => {
    let stopped = false; setSelected((old) => old?.id === downloadId ? old : null); setReadError('');
    if (downloadId) void readDownload(downloadId).then(({ item }) => { if (!stopped) setSelected(item); }).catch((error: unknown) => { if (!stopped) { setSelected(null); setReadError(error instanceof Error ? error.message : 'Download unavailable.'); } });
    return () => { stopped = true; };
  }, [downloadId, items]);
  const position = selected?.book.sections.findIndex((row) => row.id === selected.version.section_id) ?? -1;
  function openAdjacent(delta: number) {
    const section = selected?.book.sections[position + delta];
    if (!section) return;
    const choices = ready.filter((row) => row.book.id === selected?.book.id && row.version.section_id === section.id);
    const next = choices.find((row) => row.version.profile_id === selected?.version.profile_id && row.version.model_name === selected?.version.model_name) ?? choices[0];
    if (next) window.location.hash = `download=${next.id}`;
    else setReadError(`Chapter ${position + delta + 1}: ${section.title} is not downloaded. Connect and download it first.`);
  }
  async function protect() {
    try { setPersistence(await navigator.storage?.persist?.() ? 'Persistent storage granted. You can still clear downloads in browser settings.' : 'Persistent storage was not granted. Keep your server copies; the browser may evict downloads.'); }
    catch { setPersistence('Persistent storage is unavailable. Keep your server copies.'); }
  }
  return <>
    <h1 className="reader-title">Device downloads</h1>
    <p>Only explicitly downloaded chapters are available here. Downloads belong to this browser/device and this site address.</p>
    <button className="secondary" onClick={() => void protect()}>Request persistent device storage</button>
    {persistence && <p role="status">{persistence}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {readError && <p className="error" role="alert">{readError}</p>}
    {downloadId && !selected && !readError && !error && <p role="status">Opening downloaded chapter…</p>}
    {selected?.section && <>
      <a className="back-link" href="#downloads">← All device downloads</a>
      <h2>{selected.book.title} · {selected.section.title}</h2>
      <p>{selected.version.profile_name} · {selected.version.model_name} · audio version {selected.id.slice(0, 8)}</p>
      <button onClick={() => void playback.loadChapter(selected.book, selected.version, true)}>Load downloaded chapter in player</button>
      <p>Generation is unavailable in the device library. Connect to your laptop and open the server bookshelf to generate more audio.</p>
      <label>Font size: {fontSize}px<input type="range" min="16" max="32" value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} /></label>
      <nav className="section-navigation" aria-label="Downloaded chapters">
        <button disabled={position <= 0} onClick={() => openAdjacent(-1)}>← Previous chapter</button>
        <button disabled={position >= selected.book.sections.length - 1} onClick={() => openAdjacent(1)}>Next chapter →</button>
      </nav>
      <article className="reading-content" style={{ fontSize }} aria-label={selected.section.title}>
        {selected.section.blocks.map((block) => createElement(block.kind === 'heading' ? `h${Math.max(1, Math.min(6, block.heading_level ?? 2))}` : 'p', { key: block.id, id: `block-${block.id}`, 'data-block-id': block.id }, block.text))}
      </article>
    </>}
    {!downloadId && <>
      {!items.some((row) => row.state !== 'removed') && <p>No chapters downloaded. Connect to your laptop, open a ready chapter audio version, and choose Download for offline. If downloads disappeared, browser storage may have been cleared or evicted.</p>}
      {items.filter((row) => row.state !== 'removed').sort((a, b) => a.book.title.localeCompare(b.book.title) || (a.section?.position ?? 0) - (b.section?.position ?? 0)).map((item) => <section key={item.id}>
        <h2>{item.book.title} · {item.book.sections.find((s) => s.id === item.version.section_id)?.title}</h2>
        <p>{item.version.profile_name} · {item.version.model_name}</p>
        <DownloadControl book={item.book} version={item.version} />
      </section>)}
    </>}
  </>;
}
