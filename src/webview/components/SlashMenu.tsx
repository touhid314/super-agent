import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

interface Command {
  name: string;
  description?: string;
  hint?: string;
  source: 'cli' | 'super-agent';
}

interface Catalog {
  threadId: string | null;
  label?: string;
  list: Command[];
}

const MAX_SHOWN = 80;

/**
 * The / menu: while the draft is just "/name", the lead's slash commands (and Super Agent's own) to pick from.
 * Arrows move, Tab or Enter completes, Enter on a complete name sends it, Escape closes.
 */
export function useSlashMenu(draft: string, setDraft: (d: string) => void, threadId: string | undefined, send: (m: unknown) => void) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const query = /^\/(\S*)$/.exec(draft)?.[1];
  const open = query !== undefined && dismissed !== draft;

  useEffect(() => {
    const on = (e: MessageEvent) => e.data?.type === 'commands' && setCatalog({ threadId: e.data.threadId, label: e.data.label, list: e.data.list ?? [] });
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  // Asked for each time the menu opens (the lead, its skills or the thread's agent may have changed meanwhile).
  useEffect(() => {
    if (open) send({ type: 'listCommands', threadId });
  }, [open, threadId]);

  const items = useMemo(() => {
    if (!catalog || query === undefined) return [];
    const q = query.toLowerCase();
    const starts = catalog.list.filter((c) => c.name.toLowerCase().startsWith(q));
    const contains = catalog.list.filter((c) => !c.name.toLowerCase().startsWith(q) && `${c.name} ${c.description ?? ''}`.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, MAX_SHOWN);
  }, [catalog, query]);
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const pick = (c: Command) => setDraft(`/${c.name} `);

  /** True when the key was the menu's (the textarea then does nothing else with it). */
  const onKeyDown = (e: KeyboardEvent): boolean => {
    if (!open || !items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(draft);
      return true;
    }
    const c = items[Math.min(index, items.length - 1)];
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.altKey && `/${c.name}` !== draft)) {
      e.preventDefault();
      pick(c);
      return true;
    }
    return false;
  };

  const loading = open && (!catalog || catalog.threadId !== (threadId ?? null));
  const menu: ReactNode = open ? (
    <div className="overlay slash-menu" ref={list}>
      {loading && !items.length ? (
        <div className="muted">Loading commands…</div>
      ) : !items.length ? (
        <div className="muted">No command matches /{query}</div>
      ) : (
        <>
          {catalog?.label && <div className="slash-head muted">Commands for {catalog.label}</div>}
          {items.map((c, i) => (
            <div
              key={c.name}
              className={`slash-item${i === index ? ' sel' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the focus in the box
                pick(c);
              }}
            >
              <span className="slash-name">
                /{c.name}
                {c.hint && <span className="muted"> {c.hint}</span>}
              </span>
              {c.source === 'super-agent' && <span className="slash-tag">Super Agent</span>}
              {c.description && <span className="slash-desc muted">{c.description}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  ) : null;

  return { menu, onKeyDown };
}
