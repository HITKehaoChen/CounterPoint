import { useCallback, useEffect, useState } from 'react';
import type { HumanView } from '../../../../src/human-view.ts';
import { api } from '../api.ts';

export function useDeliberation(id: string | undefined): {
  view: HumanView | null;
  error: string | null;
  refresh: () => void;
} {
  const [view, setView] = useState<HumanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!id) return;
    let disposed = false;
    let eventSource: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const load = async () => {
      try {
        const result = await api.getDeliberation(id);
        if (!disposed) {
          setView(result);
          setError(null);
        }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();

    const startPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => void load(), 5000);
    };

    if (typeof EventSource !== 'undefined') {
      try {
        eventSource = new EventSource(`/api/stream?deliberationId=${encodeURIComponent(id)}`);
        eventSource.addEventListener('event', () => void load());
        eventSource.addEventListener('run.update', () => void load());
        eventSource.onerror = () => {
          eventSource?.close();
          startPolling();
        };
      } catch {
        startPolling();
      }
    } else {
      startPolling();
    }

    return () => {
      disposed = true;
      eventSource?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [id, version]);

  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  return { view, error, refresh };
}
