import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityDrawer, ApprovalCard, PlanPanel } from "../client/Panels";
import type { Approval } from "../shared/types";

const proposal: Approval = {
  id: "exact-proposal",
  chatId: "c",
  agentId: "coder",
  status: "pending",
  createdAt: "2026-09-26T00:00:00Z",
  action: {
    name: "write_file",
    args: {
      path: "hello.txt",
      baseHash: "opened-version",
      content: "<script>do not execute</script>",
    },
  },
  inspection: {
    effect: "write",
    risk: "routine",
    description: "Review this exact file change",
    path: "hello.txt",
    diff: "-before\n+<script>do not execute</script>",
  },
};

describe("server-rendered UI semantics", () => {
  it("shows exact action and version while escaping model-controlled markup", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, {
        approval: proposal,
        refresh: async () => {},
      }),
    );
    expect(html).toContain("opened-version");
    expect(html).toContain("exact-proposal");
    expect(html).toContain("&lt;script&gt;do not execute&lt;/script&gt;");
    expect(html).not.toContain("<script>do not execute</script>");
    expect(html).toContain(">Approve</button>");
    expect(html).toContain(">Deny</button>");
  });
  it("does not offer execution for stale proposals", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, {
        approval: { ...proposal, status: "stale" },
        refresh: async () => {},
      }),
    );
    expect(html).toContain("Approval stale");
    expect(html).not.toContain(">Approve</button>");
    expect(html).not.toContain(">Deny</button>");
  });
  it("labels potentially modifying command approvals honestly", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalCard, {
        approval: {
          ...proposal,
          action: { name: "run_shell", args: { command: "npm test" } },
          inspection: {
            effect: "execute",
            risk: "elevated",
            description: "Run checks",
          },
        },
        refresh: async () => {},
      }),
    );
    expect(html).toContain("This command may modify files.");
    expect(html).toContain("npm test");
  });
  it("shows blocked steps and counts only completed steps", () => {
    const html = renderToStaticMarkup(
      createElement(PlanPanel, {
        plan: {
          phases: [
            {
              id: "p",
              title: "Review",
              steps: [
                { id: "a", title: "Read", status: "done" },
                { id: "b", title: "Await input", status: "blocked" },
              ],
            },
          ],
        },
      }),
    );
    expect(html).toContain("1 / 2 steps");
    expect(html).toContain("Await input");
    expect(html).toContain("blocked");
  });
  it("keeps execution evidence collapsed initially without inventing output", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityDrawer, { events: [], tests: [] }),
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("test-run");
    expect(html).not.toContain("terminal-event");
  });
});

it("renders runner cancellation, collection errors, skipped cases and tracebacks distinctly", async () => {
  const { TestRun } = await import("../client/Panels");
  const html = renderToStaticMarkup(
    createElement(TestRun, {
      report: {
        id: "report",
        runner: "pytest",
        command: "pytest",
        createdAt: "2026-09-26T00:00:00Z",
        status: "cancelled",
        exitCode: 2,
        tests: [
          {
            name: "collection",
            status: "error",
            error: "ImportError: missing module",
            output: "captured output",
          },
          { name: "optional", status: "skipped" },
        ],
        output: "Runner was cancelled",
      },
    }),
  );
  expect(html).toContain("cancelled");
  expect(html).toContain("0 passed · 0 failed · 1 errors · 1 skipped · exit 2");
  expect(html).toContain("ImportError: missing module");
  expect(html).toContain("captured output");
  expect(html).toContain("Runner was cancelled");
});

it("uses distinct pass, failure and error icons while retaining text and case disclosure", async () => {
  const { TestRun } = await import("../client/Panels");
  const html = renderToStaticMarkup(createElement(TestRun, {
    report: {
      id: "icons", runner: "pytest", command: "pytest", status: "failed", output: "",
      createdAt: "2026-09-26T00:00:00Z",
      tests: [
        { name: "passes", status: "passed" },
        { name: "fails", status: "failed", error: "AssertionError" },
        { name: "collection", status: "error" },
        { name: "optional", status: "skipped" },
      ],
    },
  }));
  expect(html).toMatch(/lucide-check[^>]*test-status-icon passed/);
  expect(html).toMatch(/lucide-x[^>]*test-status-icon failed/);
  expect(html).toMatch(/lucide-circle-alert[^>]*test-status-icon error/);
  expect(html).toMatch(/lucide-minus[^>]*test-status-icon skipped/);
  expect(html).toContain('<details class="test-case passed">');
  expect(html).toContain('<span class="test-status">failed</span>');
  expect(html).toContain("AssertionError");
});
