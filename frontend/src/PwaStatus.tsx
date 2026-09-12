import { useEffect, useState } from 'react';
export default function PwaStatus() {
  const [status, setStatus] = useState(import.meta.env.PROD ? 'Preparing offline app…' : 'Offline startup is available in the production preview, not the development server.');
  const [update, setUpdate] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    if (!isSecureContext || !('serviceWorker' in navigator)) { setStatus('Offline startup requires a supported browser and trusted HTTPS (or localhost on this computer).'); return; }
    let stopped = false;
    let registration: ServiceWorkerRegistration | undefined;
    const check = () => { if (!stopped && registration?.waiting) setUpdate(true); };
    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).then(async (value) => {
      registration = value;
      check();
      value.addEventListener('updatefound', () => { value.installing?.addEventListener('statechange', check); });
      await navigator.serviceWorker.ready;
      if (!stopped) setStatus('Offline app shell ready. Only chapters marked Ready on device can be read or heard offline.');
    }).catch(() => { if (!stopped) setStatus('Could not prepare offline startup. Check trusted HTTPS, storage permissions, and connection, then reopen.'); });
    const refresh = () => { if (document.visibilityState === 'visible') void registration?.update().catch(() => {}); check(); };
    document.addEventListener('visibilitychange', refresh);
    return () => { stopped = true; document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return <details className="pwa-help"><summary>Install / offline setup{update ? ' · Update available' : ''}</summary>
    <p role="status">{status}</p>
    {update && <p>A new app version is ready. Finish listening and close every reader tab/window, then reopen to update. Playback is never automatically reloaded.</p>}
    <p>On iPhone/iPad, use Safari’s Share menu → Add to Home Screen (Open as Web App if offered). On Android, use the browser’s Install app or Add to Home screen menu if available. Installation options vary by browser; there is no universal install prompt.</p>
    <p>Open this production app online once and wait for “Offline app shell ready,” then explicitly download chapters. Device storage can be cleared or evicted. Keep the laptop’s original library as your backup.</p>
  </details>;
}
