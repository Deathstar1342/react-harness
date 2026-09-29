# STARK formatting probe

From the repository folder in WSL, with Node 24+ and your existing .env:

```bash
node --env-file=.env scripts/stark-probe.mjs
```

No npm install or running app is needed. The script tests the configured architect using two synthetic user-message-only prompts (simple JSON and an action-shaped JSON object), with up to three attempts each. It always disables streaming. It sends no native tools or response_format, reads no project files, and executes no generated actions. Requests time out after 120 seconds; HTTP/transport errors stop the probe. Output-token limit comes from .env (default 16384).

Attach `.harness/stark-probe-architect.json` to the chat after reviewing the response text for unexpected internal information. Known API keys and URLs are redacted; arbitrary model text still needs your review. Do not share .env or commit reports. .harness is already ignored. Repeating the command replaces that role's report.

Append `coder` or `critic` to test another configured model. Exact JSON matching and normally completed replies are reported separately. These minimal tests do not prove the full agent prompts work.

Offline checks: `node --test scripts/stark-probe.test.mjs`.

## Compare minimal and app prompts

After the simple probes pass, run all three roles with:

```bash
node --env-file=.env --import tsx scripts/stark-prompt-probe.mjs
```

This needs the app's existing npm dependencies (`npm ci` if not installed). It imports the checked-out protocol prompt, strict parser, project-guidance policy and non-streaming provider. Each role receives the same README read task with (1) minimal instructions, (2) actual role/protocol instructions, (3) role/protocol plus synthetic runtime state and absent project guidance. Unlike the first probe, the model must select an action rather than copy a complete answer. No actions are executed.

Up to nine initial requests and one formatting retry per variant (18 maximum), sequentially, using identical configured output limits and 120-second request deadlines. These direct probes do not use the running app's scheduler. Expect several minutes. HTTP/provider failures stop the run. The report is checkpointed before/after attempts; a pending row means it was interrupted. Optional final argument `architect`, `coder`, or `critic` narrows the run; default is all. Each invocation replaces the report.

Attach `.harness/stark-prompt-comparison.json` after reviewing it. It contains synthetic prompts, model responses, hashes, timing and separate format/task results. Known keys and URLs are redacted. It excludes actual projects, AGENTS.md, chat history, custom prompt files and compaction. This is a controlled synthetic comparison, not replay of the failing live chat; passing it means we next need to inspect the omitted context. No production prompts, parser, retries, settings or permissions are changed.

Offline checks: `node --import tsx --test scripts/stark-prompt-probe.test.mjs`.

Validation for this probe: five offline comparison tests passed; typecheck and production build passed. Full init_test app suite: 357 passed, 13 platform skips, two failures in settings-api.test.ts because the branch's diagnostic formatting retry sends four requests while those existing tests expect three. The new scripts are outside the app test include pattern and change no application behavior. Live prompt comparison still needs work-provider access.
