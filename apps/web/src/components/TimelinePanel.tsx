import { useEffect, useState } from 'react';
import type { Event } from '../../../../src/schemas.ts';
import type { HumanView } from '../../../../src/human-view.ts';
import { api } from '../api.ts';

export function TimelinePanel({
  view,
  onNotice,
}: {
  view: HumanView;
  onNotice: (message: string) => void;
}) {
  const [events, setEvents] = useState<Event[] | null>(null);

  useEffect(() => {
    let disposed = false;
    void api
      .timeline(view.deliberation.id)
      .then((result) => {
        if (!disposed) setEvents(result.events);
      })
      .catch((error: unknown) => {
        if (!disposed) onNotice(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
    };
  }, [view.deliberation.id]);

  return (
    <section className="panel">
      <h3>不可变事件链（Append-only Timeline）</h3>
      {events === null && <p className="muted">加载中…</p>}
      <ol className="timeline">
        {events?.map((event) => (
          <li key={event.id} className="timeline-item">
            <div className="timeline-head">
              <code>{event.type}</code>
              <span className="muted">{event.actor}</span>
              <span className="muted">{new Date(event.timestamp).toLocaleString()}</span>
            </div>
            {Object.keys(event.payload as Record<string, unknown>).length > 0 && (
              <pre className="timeline-payload">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
