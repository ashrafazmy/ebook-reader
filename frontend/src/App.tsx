import { useEffect, useState } from 'react';

type Connection = 'checking' | 'connected' | 'offline';

export default function App() {
  const [connection, setConnection] = useState<Connection>('checking');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setConnection('checking');
    const timeout = window.setTimeout(() => controller.abort(), 5000);

    async function checkHealth() {
      try {
        const response = await fetch('/api/health', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('Health request failed');
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || !('status' in body) || body.status !== 'ok') {
          throw new Error('Unexpected health response');
        }
        if (!disposed) setConnection('connected');
      } catch {
        if (!disposed) setConnection('offline');
      } finally {
        window.clearTimeout(timeout);
      }
    }

    void checkHealth();
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [attempt]);

  return (
    <main>
      <header><span className="eyebrow">YOUR LOCAL LIBRARY</span><span>Milestone 1</span></header>
      <h1>A quiet place for<br />your next chapter.</h1>
      <p className="intro">EPUB Reader will bring your books and AI narration together, right on your computer.</p>
      <section aria-labelledby="connection-heading">
        <h2 id="connection-heading">Backend connection</h2>
        <p role="status" aria-live="polite" className={`status ${connection}`}>
          <span className="dot" aria-hidden="true" />
          {connection === 'checking' ? 'Checking backend…' : connection === 'connected' ? 'Backend connected' : 'Backend unreachable'}
        </p>
        <p>{connection === 'offline'
          ? 'Start the FastAPI server on port 8000, then check again.'
          : 'This checks the live /api/health endpoint. Use the button to refresh the status.'}</p>
        <button disabled={connection === 'checking'} onClick={() => setAttempt((value) => value + 1)}>Check again</button>
      </section>
      <footer>Foundation ready. Book uploads, chapter reading, narration, and saved progress are planned for future milestones.</footer>
    </main>
  );
}
