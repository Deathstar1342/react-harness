# Working agreement

This branch is a local web application. Run it with `npm start` and use Node.js 24 or newer, React, TypeScript and `node:sqlite`. Follow [setup](docs/setup.md), [architecture](docs/architecture.md), and [status](docs/STATUS.md).

On `non-tools`, providers receive text-only Chat Completions requests. Parse one complete JSON reply with strict action and argument validation before using the existing internal approval and result protocol. Preserve bounded retries, request accounting, role and plan restrictions, file versions, leases, guidance and skill freshness, human goal provenance, durable claims and uncertainty.

Commands run through the local executor from a canonical workspace root or a checked child directory. Keep path checks and approval reinspection at dispatch. System installs follow their separate selected policy. Provider secrets must stay out of browser DTOs and command environments.

Use physical D: paths for source, Git metadata, dependencies, temporary files, caches and validation receipts. Preserve existing user state, projects and other worktrees. Never silently initialize replacement data when established state is missing.

The user authorizes commits and pushes to Deathstar1342/react-harness. Keep changes on `non-tools` for this task. Never publish credentials, .env files, databases, user projects or generated output.

Run `npm run typecheck`, `npm test`, `npm run build`, and relevant local startup checks. Report platform and live-provider validation accurately.
