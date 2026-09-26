import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsUpDown,
  CircleAlert,
  FileCode2,
  FolderPlus,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  Settings,
  X,
} from "lucide-react";
import type {
  ApprovalMode,
  Chat,
  Project,
  PublicSettings,
} from "../shared/types";
import { errorText, formatTime, id, post, request } from "./api";
import { FilePanel } from "./FilePanel";
import { ActivityDrawer, ApprovalCard, PlanPanel } from "./Panels";
import { ProjectDialog, SettingsDialog } from "./WorkspaceDialogs";
import { useConversation } from "./useConversation";
import { useEditorLayout } from "./useEditorLayout";

const approvalNames: Record<ApprovalMode, string> = {
  balanced: "Balanced",
  review: "Review every change",
  autonomous: "Full workspace autonomy",
};

function Conversation({
  chatId,
  project,
  configured,
  onChange,
  onFiles,
  onFileRevision,
  draft,
  setDraft,
}: {
  chatId: string;
  project: Project;
  configured: boolean;
  onChange: () => void;
  onFiles: () => void;
  onFileRevision: (revision: number) => void;
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
}) {
  const { detail, error, stream, connection, fileRevision, refresh } =
    useConversation(chatId, onChange);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
  const [rename, setRename] = useState(false);
  const [title, setTitle] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    onFileRevision(fileRevision);
  }, [fileRevision, onFileRevision]);
  useEffect(() => {
    if (follow.current)
      scroller.current?.scrollTo({
        top: scroller.current.scrollHeight,
        behavior: "smooth",
      });
  }, [detail?.messages.length, detail?.approvals.length, stream]);
  const act = async (name: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(name);
    setActionError("");
    try {
      await action();
      await refresh();
    } catch (e) {
      setActionError(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const send = async () => {
    const submitted = draft.trim();
    if (!submitted || busy || !configured) return;
    await act("send", async () => {
      await post(`/chats/${id(chatId)}/messages`, { content: submitted });
      setDraft((current) => (current.trim() === submitted ? "" : current));
      follow.current = true;
    });
  };
  if (!detail)
    return (
      <main className="conversation">
        <div className="center-empty">
          {error ? (
            <>
              <CircleAlert size={24} />
              <h2>Could not open this chat</h2>
              <p>{error}</p>
              <button className="button" onClick={() => void refresh()}>
                Retry
              </button>
            </>
          ) : (
            <p className="muted">Opening conversation…</p>
          )}
        </div>
      </main>
    );
  const chat = detail.chat;
  const running = chat.status === "running";
  const pending = detail.approvals.filter(
    (approval) => approval.status === "pending",
  );
  const steering = [...detail.events]
    .reverse()
    .find((event) => event.type === "steering");
  const steeringData = steering?.data as
    { content?: string; delivered?: boolean } | undefined;
  return (
    <main className="conversation" aria-label="Architect conversation">
      <header className="chat-header">
        <div className="chat-title">
          <div className="eyebrow">
            {project.name} <span>/</span> Architect
          </div>
          {rename ? (
            <form
              className="rename-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act("rename", async () => {
                  await request(`/chats/${id(chatId)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ title: title.trim() }),
                  });
                  setRename(false);
                });
              }}
            >
              <input
                aria-label="Chat title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                autoFocus
                required
                maxLength={160}
              />
              <button
                className="icon-button"
                aria-label="Save chat title"
                disabled={!!busy || !title.trim()}
              >
                <Check size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Cancel rename"
                onClick={() => setRename(false)}
              >
                <X size={15} />
              </button>
            </form>
          ) : (
            <button
              className="title-button"
              onClick={() => {
                setTitle(chat.title);
                setRename(true);
              }}
              title="Rename chat"
            >
              <h1>{chat.title}</h1>
              <MoreHorizontal size={16} />
            </button>
          )}
        </div>
        <div className="header-actions">
          <span
            className={`connection ${connection}`}
            title={
              connection === "connected"
                ? "Live updates connected"
                : "Reconnecting to live updates"
            }
          >
            <span />
            {connection === "connected" ? "Live" : "Connecting"}
          </span>
          <button className="icon-button" onClick={onFiles} aria-label="Toggle files" title="Files">
            <FileCode2 size={15} />
          </button>
        </div>
      </header>
      <div
        className="conversation-scroll"
        ref={scroller}
        onScroll={() => {
          const node = scroller.current;
          if (!node) return;
          follow.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 90;
          setShowLatest(!follow.current);
        }}
      >
        <div className="conversation-content">
          <PlanPanel plan={detail.plan} />
          {detail.messages.length === 0 ? (
            <div className="welcome">
              <span className="welcome-mark">
                <Sparkles size={27} />
              </span>
              <div className="eyebrow">Your architect</div>
              <h2>What are we working on?</h2>
              <p>
                Bring a question, a rough idea, or a specific change.
                <br />
                Your architect will help turn it into a plan and working code.
              </p>
              <div className="starter-actions">
                <button
                  onClick={() => {
                    setDraft("/plan ");
                    composer.current?.focus();
                  }}
                >
                  Plan something new <span>↗</span>
                </button>
                <button
                  onClick={() => {
                    setDraft("Help me understand this project.");
                    composer.current?.focus();
                  }}
                >
                  Explore this project <span>↗</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="messages">
              {detail.messages.map((message) =>
                message.role === "tool" ? (
                  <details className="tool-message" key={message.id}>
                    <summary>
                      Tool result <span>{formatTime(message.createdAt)}</span>
                    </summary>
                    <pre>{message.content}</pre>
                  </details>
                ) : (
                  <article
                    className={`message ${message.role}`}
                    key={message.id}
                  >
                    <div className="message-avatar">
                      {message.role === "user" ? (
                        "Y"
                      ) : message.role === "architect" ? (
                        <Sparkles size={17} />
                      ) : (
                        message.role.slice(0, 1).toUpperCase()
                      )}
                    </div>
                    <div className="message-body">
                      <div className="message-meta">
                        <strong>
                          {message.role === "user"
                            ? "You"
                            : message.role.charAt(0).toUpperCase() +
                              message.role.slice(1)}
                        </strong>
                        <time dateTime={message.createdAt}>
                          {formatTime(message.createdAt)}
                        </time>
                      </div>
                      <div className="message-content">{message.content}</div>
                    </div>
                  </article>
                ),
              )}
            </div>
          )}
          {pending.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              refresh={refresh}
            />
          ))}
          {detail.approvals.some(
            (approval) => approval.status !== "pending",
          ) && (
            <details className="approval-history">
              <summary>
                Previous decisions (
                {
                  detail.approvals.filter(
                    (approval) => approval.status !== "pending",
                  ).length
                }
                )
              </summary>
              {detail.approvals
                .filter((approval) => approval.status !== "pending")
                .map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    refresh={refresh}
                  />
                ))}
            </details>
          )}
          {running && (
            <div className="working" role="status">
              <span className="working-dots">
                <i />
                <i />
                <i />
              </span>
              {stream
                ? "Architect is composing a response…"
                : "Work is in progress…"}
              <span className="muted">You can steer or pause at any time.</span>
            </div>
          )}
          {chat.status === "error" && (
            <div className="inline-error" role="alert">
              The run stopped with an error. Inspect Activity for details, then
              resume when ready.
            </div>
          )}
          {chat.status === "interrupted" && (
            <p className="state-notice">
              Interrupted. Completed actions remain saved. Resume to continue
              from the recorded state.
            </p>
          )}
          {chat.status === "paused" && (
            <p className="state-notice">
              Paused. Your conversation and task state are saved.
            </p>
          )}
        </div>
      </div>
      <div className="composer-region">
        {showLatest && (
          <button
            className="latest-button button small"
            onClick={() => {
              follow.current = true;
              setShowLatest(false);
              scroller.current?.scrollTo({
                top: scroller.current.scrollHeight,
                behavior: "smooth",
              });
            }}
          >
            <ArrowDown size={13} />
            Latest messages
          </button>
        )}
        {(error || actionError) && (
          <div className="inline-error" role="alert">
            {actionError || error}
            <button
              className="text-button"
              onClick={() => {
                setActionError("");
                void refresh();
              }}
            >
              Retry connection
            </button>
          </div>
        )}
        {steeringData && (
          <p className="steering-receipt" role="status">
            <Check size={12} />
            {steeringData.delivered
              ? "Guidance delivered at a safe boundary"
              : "Guidance queued for the next safe boundary"}
            {steeringData.content && (
              <span title={steeringData.content}>
                {" "}
                · {steeringData.content}
              </span>
            )}
          </p>
        )}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label className="sr-only" htmlFor="chat-message">
            {running ? "Steer the architect" : "Message the architect"}
          </label>
          <textarea
            id="chat-message"
            ref={composer}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              running
                ? "Add guidance while work continues…"
                : "Describe what you want to build…"
            }
            rows={3}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-toolbar">
            <div className="composer-hints">
              <button
                type="button"
                onClick={() => {
                  setDraft(
                    (old) => `/plan ${old.replace(/^\/(plan|btw)\s*/, "")}`,
                  );
                  composer.current?.focus();
                }}
              >
                /plan
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(
                    (old) => `/btw ${old.replace(/^\/(plan|btw)\s*/, "")}`,
                  );
                  composer.current?.focus();
                }}
              >
                /btw
              </button>
              <span>
                {running
                  ? "Messages steer active work"
                  : "Shift + Enter for a new line"}
              </span>
            </div>
            <button
              className="send-button"
              type="submit"
              aria-label={running ? "Send guidance" : "Send message"}
              disabled={!draft.trim() || !!busy || !configured}
            >
              <ArrowUp size={19} />
            </button>
          </div>
        </form>
        <div className="conversation-controls">
          <label className="approval-mode">
            <span className="sr-only">Approval mode</span>
            <select
              aria-label="Approval mode"
              value={chat.approvalMode}
              disabled={!!busy || running || pending.length > 0}
              onChange={(event) =>
                void act("mode", () =>
                  request(`/chats/${id(chatId)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ approvalMode: event.target.value }),
                  }),
                )
              }
            >
              {Object.entries(approvalNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <div className="run-controls">
            <span className={`status-dot ${chat.status}`} />
            <span className="run-status">
              {chat.status.replaceAll("_", " ")}
            </span>
            {["running", "awaiting_approval", "idle"].includes(chat.status) && (
              <button
                className="text-button"
                disabled={!!busy}
                onClick={() =>
                  void act("pause", () =>
                    post(`/chats/${id(chatId)}/control`, { action: "pause" }),
                  )
                }
              >
                <Pause size={13} />
                Pause
              </button>
            )}
            {["paused", "interrupted", "error"].includes(chat.status) && (
              <button
                className="text-button"
                disabled={!!busy || !configured}
                onClick={() =>
                  void act("resume", () =>
                    post(`/chats/${id(chatId)}/control`, { action: "resume" }),
                  )
                }
              >
                <Play size={13} />
                Resume
              </button>
            )}
            {["running", "awaiting_approval"].includes(chat.status) && (
              <button
                className="text-button interrupt"
                disabled={!!busy}
                onClick={() =>
                  void act("interrupt", () =>
                    post(`/chats/${id(chatId)}/control`, {
                      action: "interrupt",
                    }),
                  )
                }
              >
                <Square size={11} />
                Interrupt
              </button>
            )}
          </div>
        </div>
      </div>
      <ActivityDrawer events={detail.events} tests={detail.tests} />
    </main>
  );
}

export function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [showProject, setShowProject] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [files, setFiles] = useState(false);
  const editorLayout = useEditorLayout();
  const [dirty, setDirty] = useState(false);
  const [fileRevision, setFileRevision] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const project = projects.find((item) => item.id === projectId);
  const mounted = useRef(true);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const refreshChats = useCallback(async () => {
    if (!projectId) return;
    try {
      const next = await request<Chat[]>(`/projects/${id(projectId)}/chats`);
      if (mounted.current && projectRef.current === projectId) setChats(next);
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    }
  }, [projectId]);
  const initialize = useCallback(async () => {
    setLoading(true);
    setError("");
    const [config, list] = await Promise.allSettled([
      request<PublicSettings>("/settings"),
      request<Project[]>("/projects"),
    ]);
    if (!mounted.current) return;
    if (config.status === "fulfilled") setSettings(config.value);
    else setError(errorText(config.reason));
    if (list.status === "fulfilled") {
      setProjects(list.value);
      setProjectId((current) => current || list.value[0]?.id || "");
    } else setError(errorText(list.reason));
    setLoading(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void initialize();
    return () => {
      mounted.current = false;
    };
  }, [initialize]);
  useEffect(() => {
    setChats([]);
    setChatId("");
    if (!projectId) return;
    let active = true;
    void request<Chat[]>(`/projects/${id(projectId)}/chats`)
      .then((next) => {
        if (active) {
          setChats(next);
          setChatId(next[0]?.id ?? "");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  const newChat = async () => {
    if (!project || creating) return;
    setCreating(true);
    setError("");
    const target = project.id;
    try {
      const chat = await post<Chat>(`/projects/${id(target)}/chats`, {
        approvalMode: settings?.approvalMode ?? "balanced",
      });
      if (projectRef.current === target) {
        setChats((old) => [chat, ...old]);
        setChatId(chat.id);
        setSidebar(false);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setCreating(false);
    }
  };
  const chooseProject = (next: string) => {
    if (dirty && next !== projectId) {
      setError("Save or discard your file edits before switching projects.");
      setFiles(true);
      return;
    }
    setProjectId(next);
    setFiles(false);
    setSidebar(false);
  };
  const updateFileRevision = useCallback((_revision: number) => {
    setFileRevision((old) => old + 1);
  }, []);
  return (
    <div
      className={`app-shell ${sidebar ? "sidebar-open" : ""} ${files ? "files-open" : ""}`}
    >
      <button
        className="mobile-menu icon-button"
        aria-label="Open navigation"
        onClick={() => setSidebar(true)}
      >
        <Menu size={20} />
      </button>
      {sidebar && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className="sidebar" aria-label="Projects and chats">
        <div className="brand">
          <span className="brand-mark">
            <Sparkles size={20} />
          </span>
          <span>
            harness<span className="brand-period">.</span>
          </span>
          <button
            className="icon-button close-sidebar"
            aria-label="Close navigation"
            onClick={() => setSidebar(false)}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <div className="project-select-wrap">
          <select
            aria-label="Select project"
            value={projectId}
            onChange={(event) => chooseProject(event.target.value)}
          >
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <ChevronsUpDown size={14} />
        </div>
        <button
          className="new-chat navigation-row"
          onClick={() => void newChat()}
          disabled={!project || creating}
        >
          <Plus size={16} />
          {creating ? "Creating chat…" : "New chat"}
          <span>↗</span>
        </button>
        <div className="sidebar-section-label">
          Conversations <span>{chats.length}</span>
        </div>
        <nav className="chat-list" aria-label="Conversations">
          {chats.map((chat) => (
            <button
              key={chat.id}
              className={`chat-item ${chat.id === chatId ? "active" : ""}`}
              onClick={() => {
                setChatId(chat.id);
                setSidebar(false);
              }}
              aria-current={chat.id === chatId ? "page" : undefined}
            >
              <MessageSquare size={15} />
              <span>{chat.title}</span>
              {chat.status !== "idle" && (
                <span
                  className={`status-dot ${chat.status}`}
                  aria-label={chat.status.replaceAll("_", " ")}
                />
              )}
            </button>
          ))}
          {chats.length === 0 && (
            <p className="sidebar-hint">
              {project
                ? "Start a conversation to shape your next change."
                : "Add a project to get started."}
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button className="navigation-row" onClick={() => setShowProject(true)}>
            <FolderPlus size={16} />
            Add project
          </button>
          <button className="navigation-row" onClick={() => setShowSettings(true)}>
            <Settings size={16} />Settings
          </button>
          <details className="backend-info">
            <summary>
              <span
                className={`status-dot ${settings?.configured ? "passed" : "paused"}`}
              />
              Backend {settings?.configured ? "configured" : "setup needed"}
            </summary>
            <p>Provider credentials are configured on the backend.</p>
            {settings && (
              <>
                <p>
                  {settings.platform} · {settings.protocol}
                </p>
                <dl>
                  {Object.entries(settings.models).map(([role, model]) => (
                    <div key={role}>
                      <dt>{role}</dt>
                      <dd>{model}</dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
            <button className="text-button" onClick={() => void initialize()}>
              <RefreshCw size={12} />
              Refresh connection
            </button>
          </details>
        </div>
      </aside>
      <div className="main-area">
        {(!settings?.configured || error) && (
          <div
            className={`backend-banner ${error ? "has-error" : ""}`}
            role={error ? "alert" : "status"}
          >
            <CircleAlert size={16} />
            <span>
              {error ||
                (loading
                  ? "Connecting to the backend…"
                  : "Connect your provider to start chatting. Set STARK_BASE_URL and STARK_API_KEY on the backend, then restart it.")}
            </span>
            <button className="text-button" onClick={() => void initialize()}>
              Retry
            </button>
            {error && (
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
        <div
          ref={editorLayout.workspaceRef}
          className={`workspace-main ${files && editorLayout.expanded ? "editor-expanded" : ""} ${editorLayout.resizing ? "editor-resizing" : ""}`}
          style={editorLayout.style}
        >
          {chatId && project ? (
            <Conversation
              key={chatId}
              draft={drafts[chatId] ?? ""}
              setDraft={(value) =>
                setDrafts((current) => ({
                  ...current,
                  [chatId]:
                    typeof value === "function"
                      ? value(current[chatId] ?? "")
                      : value,
                }))
              }
              chatId={chatId}
              project={project}
              configured={!!settings?.configured}
              onChange={() => void refreshChats()}
              onFiles={() => setFiles((old) => !old)}
              onFileRevision={updateFileRevision}
            />
          ) : (
            <main className="conversation">
              <header className="chat-header">
                <div className="chat-title">
                  <div className="eyebrow">Your workspace</div>
                  <h1>{project?.name ?? "Welcome to Harness"}</h1>
                </div>
                {project && (
                  <button
                    className="icon-button"
                    aria-label="Toggle files" title="Files"
                    onClick={() => setFiles((old) => !old)}
                  >
                    <FileCode2 size={15} />
                  </button>
                )}
              </header>
              <div className="center-empty">
                <span className="welcome-mark">
                  <Sparkles size={30} />
                </span>
                <div className="eyebrow">Harness</div>
                <h2>
                  {loading
                    ? "Opening your workspace…"
                    : project
                      ? "A new conversation starts here."
                      : "Your next project starts here."}
                </h2>
                <p>
                  {project
                    ? "Give your architect a goal. Keep the conversation, code, and evidence together."
                    : "Create a workspace or bring an existing project. Then build through conversation."}
                </p>
                <button
                  className="button primary"
                  disabled={loading || creating}
                  onClick={() =>
                    project ? void newChat() : setShowProject(true)
                  }
                >
                  <Plus size={16} />
                  {project ? "Start a conversation" : "Add your first project"}
                </button>
              </div>
            </main>
          )}
          {project && (
            <div id="workspace-file-editor" className={`file-panel-container ${files ? "visible" : ""}`}>
              <div className="editor-resize-handle" {...editorLayout.separatorProps} />
              <FilePanel
                key={project.id}
                projectId={project.id}
                revision={fileRevision}
                onDirty={setDirty}
                onClose={() => setFiles(false)}
                expanded={editorLayout.expanded}
                onToggleExpanded={editorLayout.toggleExpanded}
              />
            </div>
          )}
        </div>
      </div>
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showProject && (
        <ProjectDialog
          onClose={() => setShowProject(false)}
          onCreated={(created) => {
            setProjects((old) => [
              ...old.filter((item) => item.id !== created.id),
              created,
            ]);
            setShowProject(false);
            chooseProject(created.id);
          }}
        />
      )}
    </div>
  );
}
