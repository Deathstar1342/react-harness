import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  FileCode2,
  Folder,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import type { FileEntry, FileSnapshot } from "../shared/types";
import { ApiError, errorText, id, languageFor, post, request } from "./api";
const Editor = lazy(() =>
  import("./monaco").then((module) => ({ default: module.Editor })),
);
export const Diff = lazy(() =>
  import("./monaco").then((module) => ({ default: module.DiffEditor })),
);
const editorOptions = {
  minimap: { enabled: false },
  fontSize: 13,
  padding: { top: 16 },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  tabSize: 2,
};

export function FilePanel({
  projectId,
  revision,
  onDirty,
  onClose,
}: {
  projectId: string;
  revision: number;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
}) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [snapshot, setSnapshot] = useState<FileSnapshot | null>(null);
  const [content, setContent] = useState("");
  const [disk, setDisk] = useState<FileSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lease, setLease] = useState<"clean" | "pending" | "held" | "lost">(
    "clean",
  );
  const [view, setView] = useState<"edit" | "diff">("edit");
  const [owner] = useState(() => `editor-${crypto.randomUUID()}`);
  const dirty = snapshot !== null && content !== snapshot.content;
  const state = useRef({ snapshot, content, dirty });
  state.current = { snapshot, content, dirty };
  const mounted = useRef(true);
  const directoryRef = useRef(directory);
  directoryRef.current = directory;
  const loadSequence = useRef(0);
  const leaseQueue = useRef<Promise<unknown>>(Promise.resolve());
  const list = useCallback(async () => {
    try {
      const next = await request<FileEntry[]>(
        `/projects/${id(projectId)}/files?path=${id(directory)}`,
      );
      if (mounted.current && directoryRef.current === directory)
        setEntries(next);
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    }
  }, [projectId, directory]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadSequence.current++;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setEntries([]);
    void request<FileEntry[]>(
      `/projects/${id(projectId)}/files?path=${id(directory)}`,
    )
      .then((next) => {
        if (active) setEntries(next);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [projectId, directory, revision]);
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const leaseRequest = useCallback(
    (path: string, value: boolean) => {
      const operation = leaseQueue.current
        .catch(() => {})
        .then(() =>
          post(`/projects/${id(projectId)}/editor`, {
            path,
            owner,
            dirty: value,
          }),
        );
      leaseQueue.current = operation;
      return operation;
    },
    [owner, projectId],
  );
  useEffect(() => {
    if (!snapshot || !dirty) {
      setLease("clean");
      return;
    }
    let active = true;
    const path = snapshot.path;
    let renewing = false;
    const renew = async () => {
      if (renewing) return;
      renewing = true;
      try {
        await leaseRequest(path, true);
        if (active) setLease("held");
      } catch (e) {
        if (active) {
          setLease("lost");
          setError(
            `Editor protection could not be renewed: ${errorText(e)}. Your text is kept here.`,
          );
        }
      } finally {
        renewing = false;
      }
    };
    setLease("pending");
    void renew();
    const timer = setInterval(() => {
      void renew();
    }, 10000);
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("beforeunload", guard);
      void leaseRequest(path, false).catch(() => {});
    };
  }, [dirty, snapshot?.path, leaseRequest]);
  useEffect(() => {
    const original = state.current.snapshot;
    if (!original) return;
    let active = true;
    void request<FileSnapshot>(
      `/projects/${id(projectId)}/file?path=${id(original.path)}`,
    )
      .then((next) => {
        if (
          !active ||
          state.current.snapshot?.path !== next.path ||
          state.current.snapshot.hash !== original.hash ||
          state.current.snapshot.hash === next.hash
        )
          return;
        if (state.current.dirty) {
          setDisk(next);
          setView("diff");
        } else {
          setSnapshot(next);
          setContent(next.content);
          setDisk(null);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [projectId, revision]);
  const openFile = async (path: string) => {
    if (dirty || saving) {
      setError(
        "Save or discard your current edits before opening another file.",
      );
      return;
    }
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await request<FileSnapshot>(
        `/projects/${id(projectId)}/file?path=${id(path)}`,
      );
      if (
        mounted.current &&
        sequence === loadSequence.current &&
        state.current.dirty
      ) {
        setError(
          "Your current file has unsaved edits. Save or discard them before switching.",
        );
        return;
      }
      if (mounted.current && sequence === loadSequence.current) {
        setSnapshot(next);
        setContent(next.content);
        setDisk(null);
        setView("edit");
      }
    } catch (e) {
      if (mounted.current && sequence === loadSequence.current)
        setError(errorText(e));
    } finally {
      if (mounted.current && sequence === loadSequence.current)
        setLoading(false);
    }
  };
  const save = async () => {
    if (!snapshot || !dirty || disk || saving || lease !== "held") return;
    const submitted = content;
    setSaving(true);
    setError("");
    try {
      await leaseRequest(snapshot.path, true);
      const saved = await request<FileSnapshot>(
        `/projects/${id(projectId)}/file`,
        {
          method: "PUT",
          body: JSON.stringify({
            path: snapshot.path,
            content: submitted,
            baseHash: snapshot.hash,
            owner,
          }),
        },
      );
      if (mounted.current) {
        setSnapshot(saved);
        setDisk(null);
        void list();
      }
    } catch (e) {
      if (mounted.current) {
        setError(errorText(e));
        if (e instanceof ApiError && e.status === 409) {
          try {
            const current = await request<FileSnapshot>(
              `/projects/${id(projectId)}/file?path=${id(snapshot.path)}`,
            );
            if (mounted.current) {
              setDisk(current);
              setView("diff");
            }
          } catch (readError) {
            setError(
              `Save conflicted. Could not load the current file: ${errorText(readError)}. Your edits are preserved.`,
            );
          }
        }
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const discard = () => {
    if (!snapshot || saving) return;
    const next = disk ?? snapshot;
    setSnapshot(next);
    setContent(next.content);
    setDisk(null);
    setError("");
  };
  return (
    <aside className="file-panel" aria-label="Project files and editor">
      <div className="panel-heading">
        <span>
          <FileCode2 size={16} /> Workspace
        </span>
        <button
          className="icon-button"
          aria-label="Close files panel"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </div>
      <div className="file-navigation">
        <button
          className="icon-button"
          disabled={!directory}
          aria-label="Parent directory"
          onClick={() =>
            setDirectory(directory.split("/").slice(0, -1).join("/"))
          }
        >
          <ArrowLeft size={15} />
        </button>
        <span title={directory}>/{directory}</span>
        <button
          className="icon-button"
          onClick={() => void list()}
          aria-label="Refresh file list"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="file-list" aria-label="Files">
        {entries.length === 0 ? (
          <p className="muted compact">No visible files in this directory.</p>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.path}
              className={`file-entry ${entry.path === snapshot?.path ? "selected" : ""}`}
              onClick={() =>
                entry.type === "directory"
                  ? setDirectory(entry.path)
                  : void openFile(entry.path)
              }
            >
              {entry.type === "directory" ? (
                <Folder size={15} />
              ) : (
                <FileCode2 size={15} />
              )}
              <span>{entry.name}</span>
              {entry.type === "directory" && <ChevronRight size={13} />}
            </button>
          ))
        )}
      </div>
      {error && (
        <div className="inline-error" role="alert">
          {error}
          <button className="text-button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      {loading && (
        <p className="muted compact" role="status">
          Reading file…
        </p>
      )}
      {snapshot ? (
        <>
          <div className="editor-heading">
            <span title={snapshot.path}>
              {snapshot.path}
              {dirty && (
                <span className="unsaved" aria-label="Unsaved changes">
                  {" "}
                  •
                </span>
              )}
            </span>
            <span className="badge">
              {dirty
                ? lease === "held"
                  ? "Protected edits"
                  : lease === "lost"
                    ? "Protection lost"
                    : "Protecting…"
                : "Saved"}
            </span>
          </div>
          <div className="editor-toolbar">
            <div className="segmented">
              <button
                className={view === "edit" ? "active" : ""}
                onClick={() => setView("edit")}
              >
                Editor
              </button>
              <button
                className={view === "diff" ? "active" : ""}
                onClick={() => setView("diff")}
              >
                Changes
              </button>
            </div>
            <button
              className="text-button"
              disabled={!dirty || saving}
              onClick={discard}
            >
              Discard edits
            </button>
            <button
              className="button small primary"
              onClick={() => void save()}
              disabled={!dirty || !!disk || saving || lease !== "held"}
            >
              <Save size={13} />
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          {disk && (
            <div className="conflict" role="alert">
              <strong>This file changed on disk.</strong>
              <p>
                Your edits are preserved. Compare the current disk version on
                the left with your text on the right. Resolve your text in the
                editor, then acknowledge this version before saving.
              </p>
              <button
                className="button small"
                onClick={() => {
                  setSnapshot(disk);
                  setDisk(null);
                  setError("");
                }}
              >
                <Check size={13} />
                Use reviewed disk version as base
              </button>
            </div>
          )}
          <div className="editor-surface">
            <Suspense
              fallback={<p className="muted compact">Loading local editor…</p>}
            >
              {view === "edit" ? (
                <Editor
                  theme="harness"
                  language={languageFor(snapshot.path)}
                  value={content}
                  onChange={(value) => setContent(value ?? "")}
                  options={{
                    ...editorOptions,
                    ariaLabel: `Edit ${snapshot.path}`,
                  }}
                />
              ) : (
                <Diff
                  theme="harness"
                  language={languageFor(snapshot.path)}
                  original={disk?.content ?? snapshot.content}
                  modified={content}
                  options={{
                    ...editorOptions,
                    readOnly: true,
                    renderSideBySide: false,
                    originalEditable: false,
                  }}
                />
              )}
            </Suspense>
          </div>
          <div className="editor-footer">
            {view === "diff"
              ? "Read-only comparison · Edit text in the Editor tab"
              : "Changes save with the exact file version you opened."}
          </div>
        </>
      ) : (
        <div className="panel-empty">
          <FileCode2 size={28} />
          <h3>A little context, close at hand.</h3>
          <p>Open a file to read, edit, or compare changes.</p>
        </div>
      )}
    </aside>
  );
}
