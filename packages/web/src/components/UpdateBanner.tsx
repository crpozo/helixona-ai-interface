/** Shown when the server runs a newer version than this page: reloading gets the new features. */
export function UpdateBanner({ onReload }: { onReload: () => void }) {
  return (
    <div className="update-banner" role="status">
      <span>A new version of the assistant is ready. Reload to use it; your conversations are kept.</span>
      <button type="button" className="btn btn-small btn-primary" onClick={onReload}>
        Reload
      </button>
    </div>
  );
}
