# React Harness

A chat-centric coding workspace for models served through an OpenAI-compatible Chat Completions API.

The architect owns the conversation and delegates bounded work to coder agents. A critic reviews changes and verification evidence at meaningful checkpoints. The application manages execution, permissions, file versions, and durable task state.

## Status

**Planning stage. No runnable application has been implemented yet.** See [the architecture and implementation plan](docs/architecture.md).

## Planned capabilities

- Create, import, and select local projects with Git support.
- Persistent chats, plans, task history, and execution records.
- File browsing, syntax highlighting, editing, and diff review.
- Version-checked edits that protect manual changes from stale agent patches.
- Configurable approval modes, including review before every change.
- Persistent WSL shell sessions and streamed command output.
- Collapsible test reports with individual results and failure details.
- Always-present architect, delegated coders, and critic checkpoints.
- Mid-task steering, interruption, pause, and resume.
- Model-written context summaries with searchable original history.

## Intended stack

React and TypeScript in the browser; a Node.js/TypeScript backend running in WSL; SQLite for durable state; Monaco for editing; PTYs for persistent shells.

## Provider configuration

The application will use `/models` and `/chat/completions`. Native tool calling, `response_format`, and the Responses API are not required. Complete JSON action proposals will be validated and authorized before execution.

Copy `.env.example` to `.env` when configuring the future backend. Keep API credentials local. The real `.env` is ignored by Git and must never be bundled into the frontend.

The default roles are:

| Role | Model |
| --- | --- |
| Architect | `gemini-3.1-pro-preview` |
| Coder | `gemini-3.8-flash` |
| Critic | `gemini-3.6-flash` |

Model identifiers, provider settings, prompts, and limits will be configurable.

## Development

The initial milestone is an end-to-end persistent chat: architect delegation, one coder, an approved file change, a returned result, and successful recovery after reopening the application. Setup and run commands will be added with the implementation.
