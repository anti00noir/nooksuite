type Props = {
  available: boolean;
  busy: boolean;
  defaultPath: string | null;
  error: string | null;
  onChoose: () => void;
  onUseDefault: () => void;
};

export function SetupView({
  available,
  busy,
  defaultPath,
  error,
  onChoose,
  onUseDefault,
}: Props) {
  return (
    <main className="setup">
      <section className="setup-card">
        <p className="eyebrow">NookEdit</p>
        <h1>Choose a library</h1>
        <p className="setup-copy">
          Documents live in a folder you pick. NookBin will read the same library
          once the native host is available.
        </p>

        {defaultPath && (
          <p className="setup-default">
            Default location: <code>{defaultPath}</code>
          </p>
        )}

        <div className="setup-actions">
          <button
            type="button"
            className="primary"
            onClick={onChoose}
            disabled={!available || busy}
          >
            {busy ? 'Opening…' : 'Choose folder…'}
          </button>
          <button
            type="button"
            onClick={onUseDefault}
            disabled={!available || busy || !defaultPath}
          >
            Use default location
          </button>
        </div>

        {error && (
          <p className="status error" role="alert">
            {error}
          </p>
        )}

        {!available && (
          <p className="setup-note">
            This screen needs the desktop app. Run <code>npm run tauri dev</code>{' '}
            to open a library.
          </p>
        )}
      </section>
    </main>
  );
}
