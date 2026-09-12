import { useEffect, useState } from 'react';
import { all } from './device-db';
import { resolveProgress, syncPending, type DeviceProgress } from './progress';
import { useOnline } from './useOnline';
export default function DeviceStatus() {
  const online = useOnline();
  const [rows, setRows] = useState<DeviceProgress[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    const refresh = () => { if (globalThis.indexedDB) void all<DeviceProgress>('progress').then((items) => { if (!disposed) setRows(items.filter((p) => p.pending)); }).catch(() => {}); };
    const sync = () => { if (document.visibilityState !== 'hidden') void syncPending().catch(() => {}).finally(refresh); };
    refresh(); sync();
    const timer = window.setInterval(sync, 30000);
    window.addEventListener('online', sync); document.addEventListener('visibilitychange', sync); window.addEventListener('device-library-change', refresh);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('online', sync); document.removeEventListener('visibilitychange', sync); window.removeEventListener('device-library-change', refresh); };
  }, []);
  async function resolve(id: string, choice: 'device' | 'server') {
    setError(''); try { await resolveProgress(id, choice); } catch { setError('Cannot sync now. Your device position is retained; reconnect and retry.'); }
  }
  return <aside className="device-status" aria-label="Device connection and progress">
    {!online && <p role="status">Offline. Open <a href="#downloads">Device downloads</a> to read or listen. New generation requires a connection.</p>}
    {rows.length > 0 && <p>{rows.length} listening position(s) waiting to sync. <button className="secondary" disabled={!online} onClick={() => void syncPending().catch(() => setError('Device storage is unavailable. Your unsynced position may not be saved.'))}>Retry sync</button></p>}
    {rows.map((row) => row.conflict ? <div key={row.book_id} className="error">
      <p>Different audio versions have listening progress. Device: {row.version_id.slice(0, 8)} at {Math.floor(row.offset)}s; server: {row.conflict.version_id.slice(0, 8)} at {Math.floor(row.conflict.offset)}s. Choose which position to keep. This does not switch the current player.</p>
      <button disabled={!online} onClick={() => void resolve(row.book_id, 'device')}>Keep device position</button>{' '}<button onClick={() => void resolve(row.book_id, 'server')}>Use server position</button>
    </div> : row.syncError && <p key={row.book_id}>Position saved on device; server sync unavailable. {row.syncError}</p>)}
    {error && <p role="alert">{error}</p>}
  </aside>;
}
