# Working agreement

Build the application described in docs/architecture.md and docs/milestones.md. Read docs/STATUS.md before starting milestone work.

The user explicitly authorizes commits and pushes to the public GitHub repository Deathstar1342/react-harness from the coordinator and child tasks. Never publish credentials, .env files, local databases, or user project contents. GitHub is the only project hosting service for this work.

Use Node.js 24+, TypeScript, React, and a backend designed to run inside WSL. Native Windows development is allowed for portable tests; report Linux/PTY checks honestly. Use node:sqlite rather than adding a native SQLite binding.

Child tasks work on isolated codex/ branches and own only the paths assigned in their task. Do not merge to main or overwrite another milestone's work. Commit your milestone and report the commit SHA, tests, limitations, and changed interface assumptions to the coordinator. The coordinator reviews, integrates, tests, and pushes main. User authorization for pushes persists.

Keep shared/types.ts and docs/api-contract.md compatible. Propose interface changes explicitly to the coordinator. No fake successful execution, hard-coded demo conversations, or implied live-provider validation without credentials.

Validate every side effect in code. Never execute incomplete JSON, accept stale file versions, replay uncertain shell actions on restart, or trust model prose as an approval. Treat shell execution as potentially modifying. Model API secrets must not reach frontend payloads or child shell environments.

Meaningful checks: npm run typecheck, npm test, npm run build, and targeted integration/browser tests where applicable. Do not commit generated build artifacts.

If blocked on user assistance, record the exact blocker in your milestone report and notify the coordinator immediately. The coordinator must pause the 15-minute heartbeat rather than leave it consuming tokens while awaiting the user.
