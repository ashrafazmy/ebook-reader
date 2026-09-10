import { useEffect, useState } from 'react';

type Connection = 'checking' | 'connected' | 'offline';

export default function HealthStatus() {
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
    <aside className="health" aria-label="Backend connection">
        <p role="status" aria-live="polite" className={`status ${connection}`}>
          <span className="dot" aria-hidden="true" />
          {connection === 'checking' ? 'Checking backend…' : connection === 'connected' ? 'Backend connected' : 'Backend unreachable'}
        </p>
        {connection === 'offline' && <p>Start FastAPI on port 8000, then check again.</p>}
        <button disabled={connection === 'checking'} onClick={() => setAttempt((value) => value + 1)}>Check again</button>
    </aside>
  );
}
