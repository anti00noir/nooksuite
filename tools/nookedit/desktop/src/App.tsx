import { lazy, Suspense, useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

import { LibraryView } from './LibraryView';
import { SetupView } from './SetupView';
import { runHeadless } from './headless';
import { api, type DocumentRecord, type HeadlessConfig, type LibrarySnapshot } from './lib/api';
import { describeError } from './lib/errors';

// The editor, PDF viewer, and Markdown renderer are only needed once a
// document is open. Keeping them out of the boot chunk keeps the library
// screen fast to appear.
const DocumentView = lazy(() =>
  import('./DocumentView').then((module) => ({ default: module.DocumentView })),
);

type Phase = 'loading' | 'setup' | 'library';

// Module scope so a StrictMode double-mount cannot boot twice.
let booted = false;

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [defaultPath, setDefaultPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const available = isTauri();
  const openRecord =
    snapshot?.records.find((record) => record.id === openId) ?? null;

  function updateRecord(updated: DocumentRecord) {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            records: current.records.map((record) =>
              record.id === updated.id ? updated : record,
            ),
          }
        : current,
    );
  }

  async function openLibrary(path: string) {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      const next = await api.openLibrary(path);
      await api.saveSettings({ libraryPath: next.root });
      setSnapshot(next);
      setOpenId(null);
      setPhase('library');
      return true;
    } catch (cause) {
      setError(describeError(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (booted) return;
    booted = true;

    void (async () => {
      let config: HeadlessConfig | null = null;

      try {
        config = await invoke<HeadlessConfig | null>('headless_config');
      } catch {
        // Not in Tauri; the setup screen explains what to run instead.
      }

      if (config) {
        await runHeadless(config);
        return;
      }

      if (!isTauri()) {
        setPhase('setup');
        return;
      }

      try {
        setDefaultPath(await api.defaultLibraryPath());
      } catch (cause) {
        console.warn('Could not resolve the default library path', cause);
      }

      try {
        const settings = await api.loadSettings();

        if (settings.libraryPath && (await openLibrary(settings.libraryPath))) {
          return;
        }
      } catch (cause) {
        setError(describeError(cause));
      }

      setPhase('setup');
    })().catch((cause) => {
      setError(describeError(cause));
      setPhase('setup');
    });
  }, []);

  useEffect(() => {
    if (!notice) return;

    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  async function chooseLibrary() {
    if (!available) return;

    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Choose a library folder',
    });

    if (typeof selected === 'string') await openLibrary(selected);
  }

  async function useDefaultLibrary() {
    if (defaultPath) await openLibrary(defaultPath);
  }

  if (phase === 'loading') {
    return <main className="app-loading">Opening library…</main>;
  }

  if (phase === 'setup' || !snapshot) {
    return (
      <SetupView
        available={available}
        busy={busy}
        defaultPath={defaultPath}
        error={error}
        onChoose={() => void chooseLibrary()}
        onUseDefault={() => void useDefaultLibrary()}
      />
    );
  }

  if (openRecord) {
    return (
      <Suspense fallback={<main className="app-loading">Opening document…</main>}>
        <DocumentView
          root={snapshot.root}
          record={openRecord}
          onBack={() => setOpenId(null)}
          onRecordUpdated={updateRecord}
        />
      </Suspense>
    );
  }

  return (
    <LibraryView
      snapshot={snapshot}
      busy={busy}
      error={error}
      notice={notice}
      onSnapshot={setSnapshot}
      onOpenLibrary={openLibrary}
      onOpenDocument={(record) => setOpenId(record.id)}
      onBusy={setBusy}
      onError={setError}
      onNotice={setNotice}
    />
  );
}
