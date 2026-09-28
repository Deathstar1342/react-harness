import { Suspense, useState } from "react";
import {
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  LoaderCircle,
  Minus,
  ShieldCheck,
  Terminal,
  TestTube2,
  X,
} from "lucide-react";
import type { Approval, Plan, RunEvent, TestReport } from "../shared/types";
import {
  ApiError,
  errorText,
  eventText,
  formatTime,
  id,
  languageFor,
  post,
  terminalEvents,
} from "./api";
import { Diff } from "./FilePanel";

export function PlanPanel({ plan }: { plan: Plan }) {
  if (!plan.phases.length) return null;
  const steps = plan.phases.flatMap((phase) => phase.steps);
  return (
    <details className="plan-card">
      <summary>
        <span>
          <ChevronDown size={15} /> Plan
        </span>
        <span className="muted">
          {steps.filter((step) => step.status === "done").length} /{" "}
          {steps.length} steps
        </span>
      </summary>
      <div className="plan-body">
        {plan.phases.map((phase) => (
          <section key={phase.id}>
            <h3>{phase.title}</h3>
            <ul>
              {phase.steps.map((step) => (
                <li key={step.id} className={`step ${step.status}`}>
                  {step.status === "done" ? (
                    <Check size={14} />
                  ) : step.status === "in_progress" ? (
                    <LoaderCircle size={14} />
                  ) : step.status === "blocked" ? (
                    <CircleAlert size={14} />
                  ) : (
                    <Circle size={14} />
                  )}
                  <span>{step.title}</span>
                  <span className="status-label">
                    {step.status.replaceAll("_", " ")}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </details>
  );
}

export function ApprovalCard({
  approval,
  refresh,
}: {
  approval: Approval;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inspection = approval.inspection;
  const pending = approval.status === "pending" && !invalid;
  const decision = async (value: "approve" | "deny") => {
    if (busy || !pending) return;
    setBusy(true);
    setError("");
    try {
      await post(`/approvals/${id(approval.id)}`, { decision: value });
      await refresh();
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.status === 409) {
        setInvalid(true);
        await refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const hasComparison =
    typeof inspection.before === "string" &&
    typeof inspection.after === "string";
  return (
    <section
      className={`approval-card ${pending ? "pending" : ""}`}
      aria-label={`Approval: ${inspection.description}`}
    >
      <div className="approval-heading">
        <span>
          <ShieldCheck size={17} />
          {pending
            ? "Your approval is needed"
            : `Approval ${invalid ? "stale" : approval.status}`}
        </span>
        <span className="badge">
          {inspection.risk} · {inspection.effect}
        </span>
      </div>
      <p>{inspection.description}</p>
      {inspection.path && <code className="file-path">{inspection.path}</code>}
      {inspection.effect === "execute" && (
        <p className="muted">
          This command may modify files. Its resulting changes cannot be
          predicted from the command alone.
        </p>
      )}
      <details className="action-details">
        <summary>Exact action · {approval.action.name}</summary>
        <pre>{JSON.stringify(approval.action.args, null, 2)}</pre>
        <p className="muted">Proposal ID: {approval.id}</p>
      </details>
      {hasComparison ? (
        <details className="approval-diff" open>
          <summary>Review proposed changes · current → proposed</summary>
          <div className="diff-surface">
            <Suspense
              fallback={
                <p className="compact muted">Loading local diff viewer…</p>
              }
            >
              <Diff
                theme="harness"
                language={languageFor(inspection.path ?? "")}
                original={inspection.before}
                modified={inspection.after}
                options={{
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: false,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  fontSize: 12,
                }}
              />
            </Suspense>
          </div>
        </details>
      ) : inspection.diff ? (
        <pre className="plain-diff">{inspection.diff}</pre>
      ) : null}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <div className="approval-actions">
          <span className="muted">Applies only to this exact proposal.</span>
          <button
            className="button small"
            disabled={busy}
            onClick={() => void decision("deny")}
          >
            <X size={14} />
            Deny
          </button>
          <button
            className="button small primary"
            disabled={busy}
            onClick={() => void decision("approve")}
          >
            <Check size={14} />
            {busy ? "Submitting…" : "Approve"}
          </button>
        </div>
      )}
    </section>
  );
}

function TestStatusIcon({ status }: { status: string }) {
  const Icon = status === "passed" ? Check
    : status === "failed" ? X
      : status === "error" ? CircleAlert
        : status === "running" ? LoaderCircle : Minus;
  return <Icon size={15} className={`test-status-icon ${status}`} aria-hidden="true" />;
}

export function TestRun({ report }: { report: TestReport }) {
  const counts = { passed: 0, failed: 0, skipped: 0, error: 0 };
  report.tests.forEach((test) => counts[test.status]++);
  return (
    <details className="test-run" open={report.status !== "passed"}>
      <summary>
        <TestStatusIcon status={report.status} />
        <strong>{report.runner}</strong>
        <span className={`test-status ${report.status}`}>{report.status}</span>
        <span className="muted">{formatTime(report.createdAt)}</span>
      </summary>
      <div className="test-run-body">
        <code>{report.command}</code>
        <p className="test-counts">
          {counts.passed} passed · {counts.failed} failed · {counts.error}{" "}
          errors · {counts.skipped} skipped
          {report.exitCode !== undefined && ` · exit ${report.exitCode}`}
        </p>
        {report.tests.map((test, index) => (
          <details
            className={`test-case ${test.status}`}
            key={`${test.classname}-${test.name}-${index}`}
          >
            <summary>
              <TestStatusIcon status={test.status} />
              <span>
                {test.classname && (
                  <span className="muted">{test.classname} / </span>
                )}
                {test.name}
              </span>
              <span className="test-status">{test.status}</span>
              {test.duration !== undefined && (
                <span className="muted">{test.duration.toFixed(3)}s</span>
              )}
            </summary>
            {test.error && <pre className="traceback">{test.error}</pre>}
            {test.output && <pre>{test.output}</pre>}
            {!test.error && !test.output && (
              <p className="muted compact">No captured output.</p>
            )}
          </details>
        ))}
        {report.tests.length === 0 && (
          <p className="muted">
            No test cases were reported. Check runner output for collection or
            execution errors.
          </p>
        )}
        {report.output && (
          <details>
            <summary>Runner output</summary>
            <pre>{report.output}</pre>
          </details>
        )}
      </div>
    </details>
  );
}

export function TestReports({ reports }: { reports: TestReport[] }) {
  const runners = new Map<string,TestReport[]>();
  for (const report of reports) runners.set(report.runner,[...(runners.get(report.runner) ?? []),report]);
  return <>{[...runners].map(([runner,runs])=><details className="test-runner" key={runner}>
    <summary><TestTube2 size={15} /><strong>{runner}</strong><span className="muted">{runs.length} {runs.length===1?'run':'runs'}</span></summary>
    <div className="test-runner-body">{runs.map(report=><TestRun key={report.id} report={report} />)}</div>
  </details>)}</>;
}

export function ActivityDrawer({
  events,
  tests,
  debug = false,
}: {
  events: RunEvent[];
  tests: TestReport[];
  debug?: boolean;
}) {
  const [selectedTab, setTab] = useState<"terminal" | "tests">("tests");
  const tab = debug ? selectedTab : 'tests';
  const [open, setOpen] = useState(false);
  const output = terminalEvents(events);
  return (
    <section
      className={`activity-drawer ${open ? "open" : ""}`}
      aria-label="Execution evidence"
    >
      <div className="drawer-tabs">
        {debug && <button
          className={tab === "terminal" && open ? "active" : ""}
          onClick={() => {
            setTab("terminal");
            setOpen(tab !== "terminal" || !open);
          }}
          aria-expanded={open && tab === "terminal"}
        >
          <Terminal size={15} />
          Activity <span>{output.length}</span>
        </button>}
        <button
          className={tab === "tests" && open ? "active" : ""}
          onClick={() => {
            setTab("tests");
            setOpen(tab !== "tests" || !open);
          }}
          aria-expanded={open && tab === "tests"}
        >
          <TestTube2 size={15} />
          Tests <span>{tests.length}</span>
          {tests.some(test => test.status !== 'passed') && <span className="test-status failed">Review results</span>}
        </button>
        {open && (
          <button
            className="icon-button drawer-close"
            onClick={() => setOpen(false)}
            aria-label="Collapse execution evidence"
          >
            <X size={15} />
          </button>
        )}
      </div>
      {open && (
        <div className="drawer-content">
          {tab === "tests" ? (
            tests.length ? (
              <TestReports reports={tests} />
            ) : (
              <p className="muted compact">
                No structured test results yet. Results appear when a runner
                produces a report.
              </p>
            )
          ) : output.length ? (
            output.map((event) => (
              <div className={`terminal-event ${event.type}`} key={event.id}>
                <div className="terminal-meta">
                  {formatTime(event.createdAt)} ·{" "}
                  {event.type.replaceAll("_", " ")}
                </div>
                <pre>
                  {eventText(event.data) || JSON.stringify(event.data, null, 2)}
                </pre>
              </div>
            ))
          ) : (
            <p className="muted compact">
              Tool calls and terminal output will appear here when work begins.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
