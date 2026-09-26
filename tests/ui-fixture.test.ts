// Opt-in, disposable browser fixture. Never imported by the application.
// Run: HARNESS_UI_FIXTURE=1 npx vitest run tests/ui-fixture.test.ts
import { test } from "vitest";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import {
  createServer as createHttpServer,
  type ServerResponse,
} from "node:http";
import type {
  Approval,
  Chat,
  ChatDetail,
  Project,
  RunEvent,
} from "../shared/types";

test.skipIf(process.env.HARNESS_UI_FIXTURE !== "1")(
  "serve labeled, disposable M4 browser fixture",
  async () => {
    const stamp = new Date().toISOString();
    const projects: Project[] = [
      {
        id: "fixture-project",
        name: "UI fixture · Sample workspace",
        path: "/fixture/sample",
        createdAt: stamp,
      },
    ];
    const baseChat: Chat = {
      id: "fixture-chat",
      projectId: projects[0].id,
      title: "UI fixture · Review a change",
      status: "awaiting_approval",
      approvalMode: "balanced",
      createdAt: stamp,
      updatedAt: stamp,
    };
    const approval: Approval = {
      id: "fixture-approval",
      chatId: baseChat.id,
      agentId: "coder-1",
      status: "pending",
      createdAt: stamp,
      action: {
        name: "write_file",
        args: {
          path: "hello.ts",
          content: 'export const greeting = "Hello, team!";\n',
          baseHash: "fixture-v1",
        },
      },
      inspection: {
        effect: "write",
        risk: "routine",
        description: "Update the greeting in hello.ts (test fixture)",
        path: "hello.ts",
        before: 'export const greeting = "Hello";\n',
        after: 'export const greeting = "Hello, team!";\n',
      },
    };
    const details = new Map<string, ChatDetail>([
      [
        baseChat.id,
        {
          chat: baseChat,
          messages: [
            {
              id: "system",
              chatId: baseChat.id,
              role: "system",
              content:
                "UI TEST FIXTURE — synthetic state for interface validation. No provider, shell, or user files are used.",
              createdAt: stamp,
            },
            {
              id: "user",
              chatId: baseChat.id,
              role: "user",
              content:
                "Update the greeting and show me the verification results.",
              createdAt: stamp,
            },
            {
              id: "architect",
              chatId: baseChat.id,
              role: "architect",
              content:
                "The proposed greeting is ready for your review. The fixture includes a failed test so you can inspect captured output and traceback.",
              createdAt: stamp,
            },
          ],
          plan: {
            phases: [
              {
                id: "p1",
                title: "Make the greeting clear",
                steps: [
                  { id: "s1", title: "Read the current file", status: "done" },
                  {
                    id: "s2",
                    title: "Review the proposed greeting",
                    status: "in_progress",
                  },
                  { id: "s3", title: "Verify the change", status: "blocked" },
                ],
              },
            ],
          },
          approvals: [approval],
          tests: [
            {
              id: "test-fixture",
              runner: "pytest (fixture)",
              command: "pytest --junitxml=results.xml",
              createdAt: stamp,
              status: "failed",
              exitCode: 1,
              tests: [
                {
                  name: "test_greeting",
                  classname: "tests.greeting",
                  status: "failed",
                  duration: 0.004,
                  error: "AssertionError: expected a team greeting",
                  output: "Captured stdout: Hello",
                },
                { name: "test_config", status: "passed", duration: 0.002 },
                { name: "test_optional", status: "skipped" },
              ],
              output: "1 failed, 1 passed, 1 skipped (fixture)",
            },
          ],
          events: [
            {
              id: 1,
              chatId: baseChat.id,
              type: "tool_output",
              data: {
                agentId: "coder-1",
                output:
                  "$ pytest --junitxml=results.xml\n1 failed, 1 passed, 1 skipped (fixture)",
              },
              createdAt: stamp,
            },
          ],
        },
      ],
    ]);
    let eventId = 1;
    let file = {
      path: "hello.ts",
      content: 'export const greeting = "Hello";\n',
      hash: "fixture-v1",
    };
    let forceConflict = true;
    const streams = new Map<string, Set<ServerResponse>>();
    const recorded: unknown[] = [];
    const emit = (chatId: string, type: string, data: unknown) => {
      const event: RunEvent = {
        id: ++eventId,
        chatId,
        type,
        data,
        createdAt: new Date().toISOString(),
      };
      details.get(chatId)?.events.push(event);
      streams
        .get(chatId)
        ?.forEach((response) =>
          response.write(
            `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`,
          ),
        );
    };
    const vite = await createServer({
      configFile: false,
      plugins: [react()],
      root: process.cwd(),
      server: { middlewareMode: true },
      appType: "spa",
    });
    const server = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1:5174");
      if (!url.pathname.startsWith("/api")) {
        vite.middlewares(req, res);
        return;
      }
      const route = url.pathname.slice(4);
      let body: any = {};
      for await (const chunk of req)
        body.raw = (body.raw ?? "") + chunk.toString();
      if (body.raw) body = JSON.parse(body.raw);
      recorded.push({ method: req.method, route, body });
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (route === "/__fixture/requests") {
        json(recorded);
        return;
      }
      if (route === "/settings") {
        json({
          configured: true,
          models: {
            architect: "fixture-architect",
            coder: "fixture-coder",
            critic: "fixture-critic",
          },
          approvalMode: "balanced",
          maxParallelCoders: 1,
          platform: "UI fixture",
          protocol: "json",
          limits: {
            requestsPerMinute: 120,
            tokensPerMinute: 1500000,
            tokensPerDay: 150000000,
          },
          contextLimits: { architect: 1000, coder: 1000, critic: 1000 },
        });
        return;
      }
      if (route === "/projects") {
        if (req.method === "POST") {
          const p = {
            id: `project-${projects.length}`,
            name: `UI fixture · ${body.name}`,
            path: body.path,
            createdAt: stamp,
          };
          projects.push(p);
          json(p);
        } else json(projects);
        return;
      }
      const chatList = /^\/projects\/([^/]+)\/chats$/.exec(route);
      if (chatList) {
        if (req.method === "POST") {
          const chat: Chat = {
            ...baseChat,
            id: `chat-${details.size}`,
            projectId: chatList[1],
            title: "UI fixture · New chat",
            status: "idle",
            approvalMode: body.approvalMode,
          };
          details.set(chat.id, {
            chat,
            messages: [],
            events: [],
            approvals: [],
            plan: { phases: [] },
            tests: [],
          });
          json(chat);
        } else
          json(
            [...details.values()]
              .map((d) => d.chat)
              .filter((c) => c.projectId === chatList[1]),
          );
        return;
      }
      const match = /^\/chats\/([^/]+)(?:\/(.*))?$/.exec(route);
      if (match) {
        const detail = details.get(match[1]);
        if (!detail) {
          json({ error: "Missing fixture chat" }, 404);
          return;
        }
        if (match[2] === "events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write(": fixture connected\n\n");
          const set = streams.get(match[1]) ?? new Set();
          set.add(res);
          streams.set(match[1], set);
          req.on("close", () => set.delete(res));
          return;
        }
        if (match[2] === "messages") {
          if (body.content === "[fail]") {
            json({ error: "Simulated message failure" }, 503);
            return;
          }
          const message = {
            id: `m${++eventId}`,
            chatId: match[1],
            role: "user" as const,
            content: body.content,
            createdAt: stamp,
          };
          detail.messages.push(message);
          emit(match[1], "message", message);
          emit(match[1], "steering", {
            content: body.content,
            delivered: false,
          });
          json({ accepted: true });
          return;
        }
        if (match[2] === "control") {
          detail.chat.status =
            body.action === "pause"
              ? "paused"
              : body.action === "interrupt"
                ? "interrupted"
                : "running";
          emit(match[1], "status", detail.chat);
          json({ ok: true });
          return;
        }
        if (!match[2]) {
          if (req.method === "PATCH") Object.assign(detail.chat, body);
          json(detail);
          return;
        }
      }
      if (route.startsWith("/approvals/")) {
        approval.status = body.decision === "approve" ? "approved" : "denied";
        baseChat.status = "idle";
        emit(baseChat.id, "approval", approval);
        json({ ok: true });
        return;
      }
      if (route.endsWith("/files")) {
        json([
          {
            path: file.path,
            name: file.path,
            type: "file",
            size: file.content.length,
          },
        ]);
        return;
      }
      if (route.endsWith("/file")) {
        if (req.method === "PUT") {
          if (forceConflict) {
            forceConflict = false;
            file = {
              ...file,
              content: 'export const greeting = "Changed externally";\n',
              hash: "fixture-v2",
            };
            json({ error: "Fixture version conflict: disk changed" }, 409);
            return;
          }
          if (body.baseHash !== file.hash) {
            json({ error: "Stale fixture version" }, 409);
            return;
          }
          file = { ...file, content: body.content, hash: "fixture-v3" };
          emit(baseChat.id, "file_changed", {
            path: file.path,
            source: "editor",
          });
        }
        json(file);
        return;
      }
      if (route.endsWith("/editor")) {
        json({ ok: true });
        return;
      }
      json({ error: "Unknown fixture route" }, 404);
    });
    await new Promise<void>((resolve) =>
      server.listen(5174, "127.0.0.1", resolve),
    );
    console.log(
      "UI TEST FIXTURE at http://127.0.0.1:5174 — no provider or user file effects",
    );
    try {
      await new Promise<void>((resolve) => process.once("SIGTERM", resolve));
    } finally {
      server.closeAllConnections();
      server.close();
      await vite.close();
    }
  },
  3600000,
);
