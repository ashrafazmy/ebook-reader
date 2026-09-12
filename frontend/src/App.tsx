import { useEffect, useState } from 'react';
import HealthStatus from './HealthStatus';
import Bookshelf from './Bookshelf';
import Reader from './Reader';
import PlaybackProvider from './Playback';
import OfflineLibrary, { DownloadActivity } from './OfflineLibrary';
import DeviceStatus from './DeviceStatus';
import PwaStatus from './PwaStatus';

function selectedRoute() { return window.location.hash.slice(1); }

export default function App() {
  const [route, setRoute] = useState(selectedRoute);
  const params = new URLSearchParams(route);
  const bookId = params.get('book');
  const downloadId = params.get('download');

  useEffect(() => {
    const onNavigation = () => setRoute(selectedRoute());
    window.addEventListener('hashchange', onNavigation);
    return () => window.removeEventListener('hashchange', onNavigation);
  }, []);

  return (
    <PlaybackProvider><main>
      <header className="app-header">
        <a className="brand" href="#">EPUB Reader</a>
        <a className="back-link" href="#downloads">Device downloads</a>
        <HealthStatus />
      </header>
      <DeviceStatus />
      <DownloadActivity />
      <PwaStatus />
      {route === 'downloads' || downloadId ? <OfflineLibrary downloadId={downloadId} /> : bookId ? <Reader key={bookId} bookId={bookId} requestedSection={params.get('section')} /> : <Bookshelf />}
      <footer>Server books stay on your laptop. Explicit device downloads can be read and heard offline.</footer>
    </main></PlaybackProvider>
  );
}
