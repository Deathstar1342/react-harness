# Working agreement

On the non-tools branch, providers receive text-only requests. Validate one complete JSON action locally before using the existing internal approval and result protocol.

The user selected CLI source operation on 2026-11-18. `npm start` is the supported application launch. Keep setup and start wrappers aligned with the [setup guide](docs/setup.md). Use one local web runtime and the checkout’s private .env. Preserve existing state, native approvals, canonical workspace command checks, and system-install policy. Do not provision the workstation. M21 packaging, prior milestone evidence, and worktrees remain paused and preserved.

Build the application described in docs/architecture.md and docs/milestones.md. Read docs/STATUS.md before starting milestone work.

The user explicitly authorizes commits and pushes to the public GitHub repository Deathstar1342/react-harness from the coordinator and child tasks. Never publish credentials, .env files, local databases, or user project contents. GitHub is the only project hosting service for this work.

Use Node.js 24+, TypeScript, React, and a backend designed to run inside WSL. Native Windows development is allowed for portable tests; report Linux/PTY checks honestly. Use node:sqlite rather than adding a native SQLite binding.

Child tasks work on isolated codex/ branches and own only the paths assigned in their task. Do not merge to main or overwrite another milestone's work. Commit your milestone and report the commit SHA, tests, limitations, and changed interface assumptions to the coordinator. The coordinator reviews, integrates, tests, and pushes main. User authorization for pushes persists.

The approved M22–M27 native-tool redesign supersedes legacy JSON-protocol and old-profile compatibility requirements. Read docs/native-tool-redesign.md. Remove prose-to-action extraction and legacy response adapters; native tool arguments still require complete schema validation. Old-profile migration is out of scope; never silently erase user directories. Preserve approval, command and file-path checks, file versions, secrets and uncertain-operation protections. Keep M21 packaging and its worktree paused until the redesign is delivered.

Keep shared/types.ts and docs/api-contract.md coherent with the active milestone. Native-message and registry changes within M22 are preapproved subject to coordinator review; propose concrete interface assumptions early. Preserve user-facing APIs where practical, but do not add legacy compatibility scaffolding. No fake successful execution, hard-coded demo conversations, or implied live-provider validation without credentials.

Validate every side effect in code. Never execute incomplete JSON, accept stale file versions, replay uncertain shell actions on restart, or trust model prose as an approval. Treat shell execution as potentially modifying. Model API secrets must not reach frontend payloads or child shell environments.

Meaningful checks: npm run typecheck, npm test, npm run build, and targeted integration/browser tests where applicable. Do not commit generated build artifacts.

If blocked on user assistance, record the exact blocker in your milestone report and notify the coordinator immediately. The coordinator must pause the 15-minute heartbeat rather than leave it consuming tokens while awaiting the user.
