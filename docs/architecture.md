# Architecture

`npm start` launches the Node.js backend and serves the built React application on a loopback address. Browser access uses Host, Origin and request-content checks. The checkout’s private `.env` supplies provider configuration and model assignments. SQLite stores chats, plans, goals, approvals, file changes, skills, checkpoints, request observations and queued tasks in the established state location.

The provider adapter sends text messages through OpenAI-compatible Chat Completions. Each action reply is one complete JSON object with `message`, `action` and `parameters`. A bounded format correction loop allows three attempts per turn. Parsing rejects duplicate keys, partial data, unsupported actions and invalid arguments before the existing typed internal action protocol handles them. Each attempt uses the shared scheduler budget.

The architect plans and delegates to one coder at a time. The critic evaluates changes and verification evidence. Role, mode, task, plan-step and human-provenance checks constrain actions. Model text cannot approve its own work or establish completion.

Workspace tools validate canonical project roots and relative file paths. File writes require current versions, honor editor leases and record bounded change evidence. Command execution starts from the root or a checked child directory with sanitized environment variables. Literal file commands validate operands before modifying files. External programs run with the backend user’s OS permissions.

Workspace approval supports per-action human review, balanced handling, full workspace autonomy and AI command review. AI command review receives the command, workspace root and current working directory, and rejects outside scope or requests human review when uncertain. System installs use a separate policy and a narrowly scoped Linux package helper.

Durable command claims precede dispatch. Cancellation targets the owned command. Failed cleanup and lost results preserve uncertainty, and restart does not replay commands. Mutation reservations coordinate commands, editor changes, checkpoint restore and removal.

Recovery and request inspection expose bounded read-only projections of original evidence. Checkpoint restore requires an explicit preview and fresh claim, and interrupted restore remains uncertain. The sequential queue admits one human-authored task at a time after explicit Start, stops at approval or uncertainty, and restores paused after restart.

See the [API contract](api-contract.md) for the active HTTP and internal boundaries, and the [setup guide](setup.md) for running the app.
