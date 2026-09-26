import { useEffect, useState } from "react";
import { Folder, FolderOpen } from "lucide-react";
import type { Project, WorkspaceSettings } from "../shared/types";
import { errorText } from "./api";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { Modal } from "./Modal";
import { createProject, folderName, saveWorkspace, workspaceSettings } from "./workspace";

function useWorkspaceSettings() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    void workspaceSettings().then((next) => { if (active) setSettings(next); })
      .catch((e) => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [revision]);
  return { settings, error, retry: () => setRevision((old) => old + 1) };
}

export function ProjectDialog({ onCreated, onClose }: { onCreated: (project: Project) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"create" | "import">("create");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const workspace = useWorkspaceSettings();
  const ready = name.trim() && (mode === "create" ? workspace.settings : path);
  return <Modal title="Add project" titleId="project-dialog-title" onClose={onClose} busy={busy}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (busy || !ready) return;
      setBusy(true); setError("");
      void createProject(name, mode, path).then(onCreated).catch((e) => { setError(errorText(e)); setBusy(false); });
    }}>
      <div className="mode-selector" aria-label="Project source">
        <button type="button" aria-pressed={mode === "create"} disabled={busy} onClick={() => { setMode("create"); setError(""); }}>New project</button>
        <button type="button" aria-pressed={mode === "import"} disabled={busy} onClick={() => { setMode("import"); setError(""); setBrowse(true); }}>Import existing</button>
      </div>
      <label>Project name<input autoFocus required maxLength={120} value={name} disabled={busy}
        onChange={(event) => setName(event.target.value)} placeholder="My project" /></label>
      {mode === "create" ? <div className="project-destination">
        <span className="field-help">Create in</span>
        {workspace.settings ? <code><Folder size={15} />{workspace.settings.workspaceRoot}</code> : !workspace.error && <p role="status">Loading workspace…</p>}
        <p className="field-help">A new folder and Git repository will be created here. Change the default folder in Settings.</p>
        {workspace.error && <p className="inline-error" role="alert">{workspace.error} <button type="button" className="text-button" onClick={workspace.retry}>Retry</button></p>}
      </div> : <div className="project-destination">
        <span className="field-help">Project folder</span>
        {path && <code>{path}</code>}
        <button type="button" className="navigation-row" disabled={busy} onClick={() => setBrowse(true)}><FolderOpen size={17} />{path ? "Choose another folder" : "Choose folder…"}</button>
        <p className="field-help">Existing files and Git history are preserved.</p>
      </div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="button primary" disabled={busy || !ready}>{busy ? "Opening project…" : mode === "create" ? "Create project" : "Import project"}</button></div>
    </form>
    {browse && <DirectoryBrowser title="Choose project folder" initialPath={path || undefined} onClose={() => setBrowse(false)}
      onSelect={(selected) => { setPath(selected); setName((old) => old || folderName(selected)); setBrowse(false); }} />}
  </Modal>;
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const workspace = useWorkspaceSettings();
  const [selected, setSelected] = useState<string | null>(null);
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = selected ?? workspace.settings?.workspaceRoot;
  return <Modal title="Settings" titleId="settings-dialog-title" onClose={onClose} busy={busy}>
    <h3>Default workspace</h3>
    <p className="field-help">New projects are created inside this folder. Existing projects stay where they are.</p>
    <div className="project-destination"><code>{path ?? "Loading workspace…"}</code>
      <button type="button" className="navigation-row" disabled={busy || !workspace.settings} onClick={() => setBrowse(true)}><FolderOpen size={17} />Change folder…</button></div>
    {workspace.settings && workspace.settings.workspaceRoot !== workspace.settings.defaultWorkspaceRoot && <button type="button" className="text-button" disabled={busy}
      onClick={() => { setSelected(workspace.settings!.defaultWorkspaceRoot); setError(""); }}>Use default folder</button>}
    {(workspace.error || error) && <p className="inline-error" role="alert">{error || workspace.error}
      {workspace.error && <button type="button" className="text-button" onClick={workspace.retry}>Retry</button>}</p>}
    <div className="dialog-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="button primary" disabled={busy || !path || path === workspace.settings?.workspaceRoot} onClick={() => {
        if (busy || !path) return;
        setBusy(true); setError("");
        void saveWorkspace(path).then(onClose).catch((e) => { setError(errorText(e)); setBusy(false); });
      }}>{busy ? "Saving…" : "Save"}</button></div>
    {browse && <DirectoryBrowser title="Choose workspace folder" initialPath={path} onClose={() => setBrowse(false)}
      onSelect={(next) => { setSelected(next); setError(""); setBrowse(false); }} />}
  </Modal>;
}
