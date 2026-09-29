# STARK formatting probe

From the repository folder in WSL, with Node 24+ and your existing .env:

```bash
node --env-file=.env scripts/stark-probe.mjs
```

No npm install or running app is needed. The script tests the configured architect using two synthetic user-message-only prompts (simple JSON and an action-shaped JSON object), with up to three attempts each. It always disables streaming. It sends no native tools or response_format, reads no project files, and executes no generated actions. Requests time out after 120 seconds; HTTP/transport errors stop the probe. Output-token limit comes from .env (default 16384).

Attach `.harness/stark-probe-architect.json` to the chat after reviewing the response text for unexpected internal information. Known API keys and URLs are redacted; arbitrary model text still needs your review. Do not share .env or commit reports. .harness is already ignored. Repeating the command replaces that role's report.

Append `coder` or `critic` to test another configured model. Exact JSON matching and normally completed replies are reported separately. These minimal tests do not prove the full agent prompts work.

Offline checks: `node --test scripts/stark-probe.test.mjs`.
