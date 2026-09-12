import { useEffect, useState } from 'react';
import { listDownloads, type Download } from './downloads';
export function useDownloads() {
  const [items, setItems] = useState<Download[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    const refresh = () => void listDownloads().then((rows) => { if (!stopped) setItems(rows); }).catch((error: unknown) => { if (!stopped) setError(error instanceof Error ? error.message : 'Device storage unavailable.'); });
    refresh(); window.addEventListener('device-library-change', refresh);
    return () => { stopped = true; window.removeEventListener('device-library-change', refresh); };
  }, []);
  return { items, error };
}
