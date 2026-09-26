# Milestone 7 — seamless dark workspace

## Delivery

Branch: `codex/milestone-7`, based on `af1dfde18be07716da5d66978690f6f1d46cd5a2`.

The client now uses muted charcoal surfaces, flat project/chat navigation, subtle separators, icon file actions, quieter branding and an integrated composer. Chat remains the primary surface; plans, approvals, diffs, files, activity and structured test reports retain their existing behaviors. Test runs and individual cases now show green checks for passed, red X marks for failed, alert icons for errors and minus icons for skipped/cancelled, alongside textual status.

New projects require only a name. The client sends no path for create; the backend selects a unique destination under the saved default workspace. Import immediately opens a backend directory explorer with shortcuts, clickable ancestors, Up navigation, folder rows and explicit folder confirmation. Settings uses the same explorer to choose a default workspace drive/folder and explicitly saves the preference for future projects.

The explorer encodes backend paths, cancels superseded requests, ignores stale responses and disables confirmation during loading or after a failed request. Failures offer retry/Home recovery. Empty and truncated listings are explained. Linux, Windows drive and UNC ancestors are supported, including legal backslashes in Linux folder names. Native modal dialogs provide focus containment/restoration; nested Escape handling stops propagation. Responsive directory layouts and reduced-motion support are retained.

## Ownership and interface assumptions

Only `client/**`, `tests/ui-*.test.ts`, and this report changed. No dependencies or shared/backend contracts changed. Editor lease/version/dirty-buffer logic and local Monaco worker loading remain intact; Monaco colors match the charcoal surfaces. Importing/creating a project still passes through the existing dirty-buffer project-switch guard.

Depends on the coordinator's M7 backend delivery:

- GET/PATCH `/api/workspace`: `WorkspaceSettings`; PATCH body `{workspaceRoot}`.
- GET `/api/directories?path=...`: `DirectoryListing`; omitted path opens Home. Root labels/paths are taken from the backend, not hardcoded drive discovery.
- POST `/api/projects`: create `{name,mode:'create'}`; import `{name,path,mode:'import'}`.

Workspace changes affect future projects only. This explorer browses the backend filesystem; it is not a browser upload or native Windows picker. No automatic navigation/selection writes settings or imports a project.

## Validation

Windows, Node 24.16.0; isolated managed worktree with existing lockfile dependencies installed using `npm ci --ignore-scripts`.

- `npm run typecheck`: passed on final code.
- `npm test`: 223 passed, 10 skipped (Linux PTY cases and opt-in browser fixture).
- `npm run build`: passed; local Monaco editor/JSON/CSS/HTML/TypeScript workers bundled. Existing large Monaco chunk warnings remain.
- Focused UI checks: 24 passed across API, panel and workspace tests. Cover exact create/import payloads, workspace preference writes, rejected operations, encoded browsing paths, cancellation propagation, platform-specific ancestors, escaped folder names, empty/truncated states, single-input new-project form, settings chooser semantics, test-result icons and preserved approval/report semantics.

## Remaining acceptance / blocker

Automated browser access remains blocked by the previously reported saved-permission verification failure. No alternate browser automation or security workaround was used. Rendered desktop/mobile appearance, native-dialog keyboard/focus behavior, click-through navigation races and integrated browser workflows still need browser/human acceptance. Static component/transport tests are not visual or interactive acceptance.

Local Linux/real PTY checks and live STARK credentials were not available or used. No live-provider execution is claimed. The isolated base predates coordinator backend implementation, so the coordinator must run integrated checks after combining these changes. No demo conversations were added to the product.

Coordinator was notified of the browser blocker and requested to keep the heartbeat paused while user assistance is required. Integration into main and milestone closure remain coordinator-owned.

## Coordinator integration

Integrated into main at f96049c with backend workspace/directory APIs from 7b94cd3. Coordinator matched the name input limit to the API's 100 characters and starts Settings browsing at Home, avoiding an error when the initial default workspace has not been created. Existing Workspace shortcuts navigate directly to a saved, existing workspace. Full integrated Windows suite: 237 passed, ten skips; typecheck/build pass. Preview runs locally; rendered/interaction acceptance remains pending user feedback or restored browser automation. No live-provider claim.
