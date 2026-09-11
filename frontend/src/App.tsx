import { useEffect, useState } from 'react';
import HealthStatus from './HealthStatus';
import Bookshelf from './Bookshelf';
import Reader from './Reader';

function selectedBook(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get('book');
}

export default function App() {
  const [bookId, setBookId] = useState(selectedBook);

  useEffect(() => {
    const onNavigation = () => setBookId(selectedBook());
    window.addEventListener('hashchange', onNavigation);
    return () => window.removeEventListener('hashchange', onNavigation);
  }, []);

  return (
    <main>
      <header className="app-header">
        <a className="brand" href="#">EPUB Reader</a>
        <HealthStatus />
      </header>
      {bookId ? <Reader key={bookId} bookId={bookId} /> : <Bookshelf />}
      <footer>Your books stay on this computer. Paragraph narration uses your local Voicebox service.</footer>
    </main>
  );
}
