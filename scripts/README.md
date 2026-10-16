# Source setup and diagnostics

Supported source launchers are root setup.sh/start.sh and setup.ps1/start.ps1. They use source-desktop.sh/source-desktop.ps1 and the native bootstrap helper to select an external runtime, build exact container payloads, verify the complete target closure and open the native desktop. See [setup](../docs/setup.md), [acceptance](../docs/m32-acceptance.md) and [packaging delta](../docs/m32-packaging-handoff.md).

container-source.sh, source-common.sh and source-setup.ts are historical direct/browser regression surfaces; they are not a supported production fallback. stage-support-runtime.py and source-payload.py are trusted build-time producers, not generic model/renderer tools. Source bootstraps accept no provider secret input.

# Bounded native provider diagnostic

Run the reviewed redesigned checkout with Node 24+. No npm install or running app is needed. Put `STARK_BASE_URL`, `STARK_API_KEY` and `M27_MODEL` in a private environment file **outside the checkout**. The base URL must be your authorized HTTPS API base and the model must be an exact catalog ID. There is no default, alias, 3.5/3.8 substitution or migration.

```bash
node --env-file=/private/probe.env scripts/native-provider-probe.mjs
```

PowerShell also accepts `--env-file=D:/private/probe.env`. Node environment variables take precedence over the env file. Never put a key on the command line or share the env file. Run one explicitly selected model at a time. Keep the private slot-to-ID association locally: the shareable report deliberately omits model IDs and raw catalog metadata. Obtain IDs through your provider's authorized catalog information; this script does not dump the catalog.

One `/models` request precedes at most six sequential `/chat/completions` requests: ordinary reply, native echo call/result/acknowledgement, independent streaming reply and streaming native echo round trip. Bounds: seven requests, 30 seconds each/210 seconds total, 256 output tokens per completion, 256 KiB per response, 1000 catalog entries, no pagination or retries. These direct requests are outside the app scheduler; account for other concurrent provider work. Rate/credit/auth/key-lock errors stop further requests. Any `Retry-After`, or explicit zero remaining request/token/credit header, also stops requests. No automatic wait/retry, link following or redirect is allowed. Unknown vendor messages/headers remain unknown.

Exactly one `diagnostic_echo` call with a bounded ID, complete duplicate-key-safe fixed-value arguments, correlated tool result and exact follow-up acknowledgement is required. Its only handler returns a fixed in-memory literal. There is no application tool, arbitrary function, shell, file action, install, source write, default change or commit. Tool prose cannot pass. Streaming assembles split bytes/arguments and requires normal finish plus `[DONE]`; partial data never reaches the echo round trip.

The JSON report contains fixed categories, booleans and bounded counts/status codes. It omits endpoint, keys, model/request IDs, prompts, arguments, raw replies/errors, catalog metadata, account data, URLs and work content. Header evidence contains only presence/zero flags from a fixed allowlist. Do not add private annotations before sharing. The script writes only stdout; choose a private output file yourself if desired. Exit 0 means all five catalog/capability rows verified; exit 2 means an incomplete/failed check; exit 1 means no report could be produced.

`responseIdMatch` is independent: `matched` requires exact configured identity on both initial/follow-up responses; `unknown` means at least one omitted identity; `mismatch` means a conflicting or different identity failed the probe. Capability success with unknown identity is **not** verified model identity. Declared catalog capabilities remain `unknown`; declarations cannot grant execution authority. Argument validation, call-ID validity, result correlation and acknowledgement have separate fields. Refusal, missing tool, invalid schema, malformed payload/SSE, truncation, unsupported, retired, rate/credit/key-lock/auth gates, timeout, transport failure and unexpected replies remain distinct. Error prose never determines retirement or account authority.

This probes small synthetic prompts against the configured endpoint, not real STARK task quality or release readiness. Work-only endpoint acceptance stays deferred until the user runs it there; credentials are unnecessary for independent development. App settings/capability gating are unchanged.

```bash
node --test scripts/native-provider-probe.test.mjs
```

Required Validate CI runs these real local HTTP/SSE fixtures, explicitly labelled `synthetic`. Loopback HTTP is permitted only with `M27_SYNTHETIC=1` and host `127.0.0.1`; work probes require HTTPS. M27 removes the obsolete JSON-format/repair scripts with no compatibility fallback.
