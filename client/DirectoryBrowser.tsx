import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronRight, Folder, RefreshCw } from "lucide-react";
import type { DirectoryListing } from "../shared/types";
import { errorText } from "./api";
import { Modal } from "./Modal";
import { directoryCrumbs, listDirectories } from "./workspace";

export function DirectoryContents({ listing, onNavigate, disabled = false }: {
  listing: DirectoryListing; onNavigate: (path: string) => void; disabled?: boolean;
}) {
  return <>
    <nav className="directory-breadcrumbs" aria-label="Folder location">
      <button type="button" className="icon-button" aria-label="Parent folder" disabled={disabled || listing.parentPath === null}
        onClick={() => { if (listing.parentPath !== null) onNavigate(listing.parentPath); }}><ArrowUp size={16} /></button>
      {directoryCrumbs(listing.path).map((crumb, index, crumbs) => <span key={crumb.path}>
        {index > 0 && <ChevronRight size={12} />}
        <button type="button" disabled={disabled} aria-current={index === crumbs.length - 1 ? "location" : undefined}
          onClick={() => onNavigate(crumb.path)} title={crumb.path}>{crumb.name}</button>
      </span>)}
    </nav>
    <div className="directory-contents">
      <nav className="directory-roots" aria-label="Folder shortcuts">
        {listing.roots.map((root) => <button type="button" className="navigation-row" key={`${root.name}:${root.path}`}
          disabled={disabled} onClick={() => onNavigate(root.path)} title={root.path}><Folder size={16} />{root.name}</button>)}
      </nav>
      <div className="directory-entries" aria-label="Folders">
        {listing.entries.length === 0 && <p className="field-help">No subfolders. You can select this folder.</p>}
        {listing.entries.map((entry) => <button type="button" className="navigation-row" key={entry.path}
          disabled={disabled} onClick={() => onNavigate(entry.path)} title={entry.path}>
          <Folder size={17} /><span>{entry.name}</span><ChevronRight size={14} />
        </button>)}
        {listing.truncated && <p className="field-help" role="status">This folder has more entries than can be shown. Open a subfolder or use a shortcut to continue.</p>}
      </div>
    </div>
  </>;
}

export function DirectoryBrowser({ title, initialPath, onSelect, onClose }: {
  title: string; initialPath?: string; onSelect: (path: string) => void; onClose: () => void;
}) {
  const [location, setLocation] = useState({ path: initialPath, revision: 0 });
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const navigate = (path?: string) => {
    // Immediately prevent confirming the previous location while a request is pending.
    sequence.current += 1;
    setLoading(true);
    setError("");
    setLocation((old) => ({ path, revision: old.revision + 1 }));
  };
  useEffect(() => {
    const controller = new AbortController();
    const current = ++sequence.current;
    void listDirectories(location.path, controller.signal).then((next) => {
      if (sequence.current === current && !controller.signal.aborted) setListing(next);
    }).catch((e) => {
      if (sequence.current === current && !controller.signal.aborted) setError(errorText(e));
    }).finally(() => {
      if (sequence.current === current && !controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [location]);
  return <Modal title={title} titleId="directory-title" onClose={onClose} className="directory-dialog">
    <p className="field-help">Browse folders on the backend machine. In WSL, Windows drives appear under /mnt.</p>
    <div aria-busy={loading}>
      {listing && <DirectoryContents listing={listing} onNavigate={navigate} disabled={loading} />}
      {loading && <p className="directory-notice" role="status">Loading folders…</p>}
      {error && <div className="inline-error" role="alert">{error}
        <div className="dialog-actions"><button type="button" className="text-button" onClick={() => navigate(location.path)}><RefreshCw size={14} />Retry</button>
          <button type="button" className="text-button" onClick={() => navigate()}>Open Home</button></div>
      </div>}
    </div>
    <div className="selected-directory"><span className="field-help">Selected folder</span>
      <code>{loading ? "Loading…" : error ? "Choose an accessible folder" : listing?.path ?? "No folder selected"}</code></div>
    <div className="dialog-actions">
      <button type="button" className="button" onClick={onClose}>Cancel</button>
      <button type="button" className="button primary" disabled={loading || !!error || !listing}
        onClick={() => { if (!loading && !error && listing) onSelect(listing.path); }}>Select folder</button>
    </div>
  </Modal>;
}
