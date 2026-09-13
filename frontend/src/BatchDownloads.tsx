import { useEffect, useState } from 'react';
import { batchRunning, cancelBatch, continueBatch, listBatches, type DownloadBatch } from './downloadBatch';
import { useDownloads } from './useDownloads';
import { useOnline } from './useOnline';

export default function BatchDownloads() {
  const [batches, setBatches] = useState<DownloadBatch[]>([]);
  const [error, setError] = useState('');
  const online = useOnline();
  const { items } = useDownloads();
  useEffect(() => {
    let stopped = false;
    const refresh = () => void listBatches().then((rows) => { if (!stopped) setBatches(rows); }).catch(() => {});
    refresh(); window.addEventListener('device-library-change', refresh);
    const timer = window.setInterval(refresh, 2000);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('device-library-change', refresh); };
  }, []);
  async function action(batch: DownloadBatch, cancel: boolean) {
    setError('');
    try { if (cancel) await cancelBatch(batch.book.id); else await continueBatch(batch.book.id); }
    catch (error) { setError(error instanceof Error ? error.message : 'Download action failed.'); }
  }
  return <>{batches.map((batch) => {
    const completed = batch.completed.filter((id) => items.some((item) => item.id === id && item.state === 'ready'));
    const remaining = batch.versions.filter((v) => !completed.includes(v.id));
    const known = remaining.reduce((sum, v) => sum + (batch.sizes[v.id] ?? 0), 0);
    const unknown = remaining.filter((v) => !batch.sizes[v.id]).length;
    const running = batchRunning(batch.book.id);
    return <details key={batch.book.id} className="batch-downloads">
      <summary>{batch.book.title} · {completed.length} / {batch.versions.length} chapters downloaded · {batch.state === 'running' && !running ? 'Continue available' : batch.state}</summary>
      <p>{known.toLocaleString()} bytes remaining{unknown ? ` known; size unknown for ${unknown} chapters` : ' (estimate)'}. Chapters ready after this plan started are not added.</p>
      <p>Downloads require this app to remain open. Closing it or phone suspension may interrupt transfers. Continue checks saved copies before retrying.</p>
      {(batch.state !== 'completed' || remaining.length > 0) && <button disabled={!online || running} onClick={() => void action(batch, false)}>Continue download</button>}
      {batch.state === 'running' && <button className="secondary" onClick={() => void action(batch, true)}>Cancel after current chapter</button>}
      {batch.state === 'cancelled' && running && <p>Finishing the current operation before stopping. Completed copies are retained.</p>}
      {batch.error && <p role="alert" className="error">{batch.error}</p>}
      {Object.entries(batch.errors).map(([id, message]) => <p className="error" key={id}>{batch.book.sections.find((s) => s.id === batch.versions.find((v) => v.id === id)?.section_id)?.title}: {message}</p>)}
      <a href="#downloads">Open device downloads</a>
    </details>;
  })}{error && <p role="alert" className="error">{error}</p>}</>;
}
