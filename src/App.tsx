import { useEffect, useState } from 'react';

type Health = { ok: true; model: string };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Health check failed (${response.status})`);
        return (await response.json()) as Health;
      })
      .then(setHealth)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'Could not reach the server.');
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="scaffold">
      <h1>Deepread</h1>
      <p>Local PDF reader. Chat lives next to the passage you highlight.</p>
      {health && (
        <p className="status ok">
          Server is up. Model: <code>{health.model}</code>
        </p>
      )}
      {error && <p className="status bad">{error}</p>}
      {!health && !error && <p className="status">Checking the server…</p>}
    </main>
  );
}
