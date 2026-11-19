# Project status

The `non-tools` branch runs the web app with `npm start`. Node.js serves the built React UI on loopback. Configuration comes from the checkout’s private `.env`, with process environment overrides. Existing application state reopens automatically.

Models receive ordinary Chat Completions messages. Complete JSON action replies are parsed and validated locally, with at most three model attempts per turn. Runtime approvals, file versions, editor leases, goal evidence, selected skills, request budgets, checkpoints, recovery, usage inspection and the sequential queue remain active.

Commands use the local command executor. Each launch rechecks the canonical workspace root and working directory, literal path arguments, current approvals, guidance and mutation reservations. AI command review receives the proposed action, workspace root and working directory. Optional system installs use their separate Ask, Auto-approve or AI review policy.

See the [setup guide](setup.md) and [API contract](api-contract.md). Historical implementation records are available through Git history.
