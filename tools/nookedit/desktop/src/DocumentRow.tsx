import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { DocumentRecord } from './lib/api';
import { badgeFor, formatDate, formatSize } from './lib/format';

type Props = {
  record: DocumentRecord;
  busy: boolean;
  onDelete: (record: DocumentRecord) => void;
  onRename: (id: string, name: string) => Promise<boolean>;
};

export function DocumentRow({ record, busy, onDelete, onRename }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(record.name);
  }, [editing, record.name]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  function startEditing() {
    setDraft(record.name);
    setEditing(true);
  }

  function cancelEditing() {
    setDraft(record.name);
    setEditing(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();

    const name = draft.trim();
    if (!name || name === record.name) {
      cancelEditing();
      return;
    }

    if (await onRename(record.id, name)) setEditing(false);
  }

  return (
    <li className="doc-row">
      <span className="doc-badge" aria-hidden="true">
        {badgeFor(record)}
      </span>

      <div className="doc-main">
        {editing ? (
          <form className="rename-form" onSubmit={submit}>
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') cancelEditing();
              }}
              aria-label={`New name for ${record.name}`}
              disabled={busy}
            />
            <button type="submit" className="primary" disabled={busy}>
              Save
            </button>
            <button type="button" className="ghost" onClick={cancelEditing} disabled={busy}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className="doc-name" title={record.name}>
              {record.name}
            </span>
            <span className="doc-meta">
              {formatSize(record.size)}
              <span aria-hidden="true"> · </span>
              {formatDate(record.updatedAt)}
            </span>
          </>
        )}
      </div>

      {!editing && (
        <div className="doc-actions">
          <button type="button" className="ghost" onClick={startEditing} disabled={busy}>
            Rename
          </button>
          <button
            type="button"
            className="ghost danger"
            onClick={() => onDelete(record)}
            disabled={busy}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
