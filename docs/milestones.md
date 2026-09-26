# Delivery milestones

| ID | Milestone | Acceptance |
| --- | --- | --- |
| M0 | Foundation and coordination | Reproducible Node/React scaffold, shared interfaces, CI, GitHub milestones, persistent coordination record |
| M1 | STARK provider and JSON protocol | Model discovery, text streaming, complete validated actions, cancellation, bounded retries, mock-provider tests |
| M2 | Durable conversations and orchestration | SQLite projects/chats/events, architect delegation, approval/resume, restart recovery, steering |
| M3 | Workspace tools and persistent shells | Confined file tools, hashes and stale-write checks, diffs, editor leases, PTY state, Git, structured test artifacts |
| M4 | Chat workspace interface | Project/chat navigation, real API chat, plans, editable syntax-highlighted files, diffs, approvals, test results |
| M5 | Reviews and context management | Critic checkpoints, bounded repairs, summaries with durable state retained, configurable budgets |
| M6 | Integrated release validation | Reviewed integration, meaningful automated/browser/Linux tests, setup docs, honest remaining live-provider acceptance |
| M7 | Seamless dark workspace | Codex-inspired dark chat interface with less button chrome, folder explorer for import, automatic new-project workspace, and Settings to choose its drive/folder |

Milestones may develop concurrently after interfaces are established. Integration remains coordinator-owned. Implement the single-coder loop before attempting parallel coder execution.

## Release scope

The first release must support all requested core user flows with one coder. Parallel coders and isolated integration are an extension only after that baseline is verified. Do not imply parallel execution is implemented just because the architecture permits it.

## Public tracker

Milestones and their delivery issues are tracked in the repository's GitHub tracker. Close them only when the stated acceptance is actually met; record deferred and environment-dependent checks explicitly.
