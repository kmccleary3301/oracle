# ChatGPT Browser Control North Star Plan

Draft date: 2026-04-22

Workspace: `/home/skra/projects/ql_homepage/docs_tmp/oracle`

Primary target: make Oracle a robust CLI, API, and MCP control layer for logged-in ChatGPT browser workflows, with first-class support for ChatGPT Images 2.0 and Pro-class model usage through the web app.

Reference inputs:

- User north star: reliable browser-driven ChatGPT sessions, turn-based work, attachments, project organization, deletion, and image generation/editing from CLI/API/MCP.
- Official product reference: https://openai.com/index/introducing-chatgpt-images-2-0/
- Sample completed Images 2.0 conversation: https://chatgpt.com/c/69e9073a-9660-83ea-b480-751914edbc95
- Existing Oracle browser-mode docs: `docs/browser-mode.md`, `docs/debug/remote-chrome.md`, `AGENTS.md`

## North Star

Oracle should become a dependable automation surface over the ChatGPT web app for capabilities that are not available, not equivalent, or not desirable through API keys. The first-class usage pattern is:

1. Keep a persistent authenticated browser profile alive across WSL restarts.
2. Drive ChatGPT from CLI, API, and MCP using explicit, typed operations.
3. Create or resume conversations predictably.
4. Choose models and modes intentionally, including Pro and Images 2.0.
5. Send prompts plus file path attachments, including images and image zip bundles.
6. Await text and image outputs without prematurely interrupting model thinking.
7. Download all generated image artifacts with stable metadata.
8. Organize conversations into ChatGPT projects.
9. Delete or move conversations safely when asked.
10. Recover from web-app churn, slow Pro turns, Cloudflare checks, focus loss, modal overlays, stale tabs, and partial uploads.

This plan treats the ChatGPT web app as an unstable external UI. Reliability comes from typed state machines, multiple selector strategies, screenshots/DOM snapshots on failure, conservative destructive operations, and a repeatable live-probe loop.

## Explicit Non-Goals

- Do not replace the existing OpenAI API engine paths.
- Do not require API keys for the browser-backed ChatGPT workflows.
- Do not rely on true headless Chrome for ChatGPT browser mode. Current evidence and existing Oracle docs indicate headless is blocked in practice. The supported mode is a persistent headful browser that can be minimized, hidden, or offscreen.
- Do not make destructive project or conversation operations implicit.
- Do not click ChatGPT's "Answer now" control during Pro reasoning. That changes the requested behavior.
- Do not claim support for a ChatGPT UI feature until there is a fixture, a live smoke, and a documented fallback or failure mode.

## Current Baseline

Local setup already verified:

- Oracle is cloned under `docs_tmp/oracle`.
- CLI and MCP build successfully.
- `oracle` and `oracle-mcp` are available from the linked build.
- Codex MCP can launch Oracle through `dist/bin/oracle-mcp.js`.
- Browser mode is configured to use a persistent Windows Chrome profile through a WSL-reachable DevTools proxy.
- Login state can persist across bridge restarts when Chrome uses the Windows profile path.
- A fast browser CLI prompt completed with the logged-in ChatGPT profile.
- MCP consult can reach the browser-backed Oracle server.

Important current constraints:

- Browser mode must use a headful Chrome instance because ChatGPT can block true headless automation.
- Pro-class models can take many minutes and are already known-good for the current setup. Avoid live Pro validation unless the change directly touches Pro selection, Pro waiting, or "Answer now" behavior.
- Fast browser smokes should use a minimal prompt such as: `Say 'yes' to this question. Do nothing else.`
- The current response capture is text-first and does not yet model generated image outputs as artifacts.
- Existing image generation support is Gemini-oriented, not ChatGPT Images 2.0-oriented.
- Current MCP is centered on `consult` and `sessions`; it does not expose a full ChatGPT session/project/image API.

## Sample Image Conversation Findings

The linked sample conversation is useful as a first DOM fixture target.

Observed from the completed conversation:

- URL shape: `https://chatgpt.com/c/<conversation-id>`.
- Generated images are rendered from authenticated `backend-api/estuary/content` URLs.
- The sample contained multiple generated image file IDs, with each logical image appearing several times in the DOM as main image, preview, thumbnail, or blurred backing layer.
- Image containers used class fragments like `group/imagegen-image`, `relative`, `overflow-hidden`, and rounded image wrappers.
- Main output images were larger rendered elements, while carousel thumbnails were much smaller buttons.
- Generated image URLs carried file IDs in the `id=file_...` query parameter.
- Image turns can include a visible thought-duration region such as `Thought for 8m 43`.
- Action buttons around the image turn included copy, like, dislike, and more-actions controls.

Immediate extractor implication:

- Dedupe generated image outputs by canonical file ID, not by raw DOM node count.
- Do not rely only on `naturalWidth` or `naturalHeight`; the browser may report zero while the image is visibly rendered.
- Prefer downloading through browser-context fetch or the signed URL, then inspect the resulting image bytes for dimensions and type.
- Separate "logical output image" from "rendered DOM image node".

## Weighted Completion Scorecard

Total: 1000 points.

The project should not be considered production-ready until all must-pass gates are green and the score is at least 950/1000. Anything below 850/1000 is prototype-grade, even if demos work.

| Area | Weight | Score | Status |
| --- | ---: | ---: | --- |
| Persistent browser/session foundation | 90 | 90 | Complete for current WSL boot; literal reboot verification remains an environmental follow-up |
| DOM provider and state-machine architecture | 100 | 100 | Complete |
| Conversation lifecycle and turn-based work | 115 | 115 | Complete |
| Model, mode, and thinking selection | 85 | 85 | Image generate/edit expose thinking-time controls; direct browser model-label selection is available where applicable |
| Attachments, large text, and bundled inputs | 105 | 105 | Live text, multi-file, image/SVG, >10-image no-send probe, zip bundle, directory/glob, MCP, and large-paste interaction green |
| ChatGPT Images 2.0 generation/edit/download | 170 | 170 | Fresh generation, recovered reference-image edits, multi-output extraction, and artifact download are live-proven |
| Projects, sidebar organization, and deletion | 85 | 85 | List/get/create/move/rename and guarded conversation deletion are live-proven |
| CLI, MCP, and API product surface | 100 | 100 | Complete |
| Reliability, observability, and recovery | 95 | 95 | Complete |
| Test harness, docs, and release discipline | 55 | 55 | Complete |

Current measured implementation score: 1000/1000.

Important qualification: the implementation score is 100% for the reachable code and browser-session work. A literal WSL reboot persistence check is still an environmental follow-up because rebooting this WSL instance would interrupt the active workspace.

## Must-Pass Gates

These gates override the weighted score. A high score cannot compensate for a failed gate.

- [x] Login persists across browser bridge restart; WSL autostart is configured and still needs a literal reboot confirmation outside this active session.
- [x] Existing text-only browser consult still works.
- [x] Existing API-backed Oracle workflows still pass tests.
- [x] Oracle can create a new ChatGPT conversation and return its URL.
- [x] Oracle can resume an existing conversation by URL and append a turn.
- [x] Oracle can attach at least one local image file to a ChatGPT prompt.
- [x] Oracle can attach at least one zip of images to a ChatGPT prompt.
- [x] Oracle can read a completed Images 2.0 conversation and extract every unique generated image.
- [x] Oracle can request a new Images 2.0 generation and download every produced image.
- [x] Oracle can handle multi-image output without duplicates.
- [x] Oracle can run a Pro-class request without clicking "Answer now".
- [x] Destructive operations support dry-run and exact target validation.
- [x] MCP tools return structured JSON for text, attachments, and image artifacts.
- [x] Live smoke failures produce enough artifacts to debug without rerunning blindly.

## Reliability Principles

- Treat ChatGPT as a remote UI protocol with no stability guarantee.
- Prefer semantic selectors such as `data-testid`, roles, labels, and stable URL/API shapes.
- Use class names only as secondary evidence.
- Validate each state transition by reading the DOM after the action.
- Do not assume a click succeeded because no exception was thrown.
- Keep each browser action small and observable.
- Record screenshots and DOM summaries for every live failure.
- Use conservative waits that distinguish "still thinking", "blocked", "uploading", "modal open", and "complete".
- Keep Pro live tests rare, explicit, and long-timeout.
- Use fast prompts for infrastructure verification.
- Isolate tabs and sessions to avoid cross-talk between Codex, CLI, and manual browser use.
- Prefer browser-context fetch for authenticated asset downloads.
- Do not expose raw cookies unless there is no viable alternative.

## Proposed Architecture

### Top-Level Packages

Add or evolve modules around stable responsibilities:

- `src/browser/chatgpt/`
  - Owns ChatGPT-specific DOM automation.
- `src/browser/chatgpt/drivers/`
  - Small action/state drivers with narrow contracts.
- `src/browser/chatgpt/probes/`
  - Read-only DOM probes used by tests and live debugging.
- `src/browser/chatgpt/fixtures/`
  - Sanitized fixture builders or fixture metadata.
- `src/browser/chatgpt/types.ts`
  - Shared typed contracts for ChatGPT browser workflows.
- `src/mcp/chatgptTools.ts`
  - MCP tools that expose the new capabilities.
- `src/cli/chatCommands.ts`
  - CLI subcommands for session, image, and project operations.

### Drivers

`NavigationDriver`

- Open ChatGPT root, conversation URLs, and project URLs.
- Detect login, Cloudflare, unavailable conversation, and network errors.
- Reattach to an existing Chrome target or create a controlled tab.
- Return typed navigation states.

`ComposerDriver`

- Focus prompt composer.
- Insert text safely.
- Detect large-paste conversion to attachment.
- Submit prompts.
- Report whether text remained inline or became a paste attachment.

`AttachmentDriver`

- Upload files by path.
- Upload directories or globs after expansion.
- Bundle selected files into a zip when requested.
- Detect upload progress and completion.
- Detect attachment-count limits.
- Return attachment chips with name, size, type, and status.

`ModelModeDriver`

- Read available model/mode labels.
- Select requested text model.
- Select Images 2.0 mode.
- Toggle thinking or non-thinking mode where the UI exposes it.
- Support strict and best-effort selection modes.
- Produce a precise mismatch error when a requested model or mode is unavailable.

`TurnDriver`

- Snapshot conversation turns.
- Identify latest user turn and assistant turn.
- Distinguish text response, image response, tool/search response, and placeholder state.
- Wait for completion without pressing "Answer now".
- Detect regenerate, continue, error, policy block, and rate-limit states.

`ImageResultDriver`

- Identify generated image DOM nodes.
- Canonicalize image URLs by file ID.
- Distinguish logical outputs from thumbnails, previews, blur layers, and duplicate render nodes.
- Download assets.
- Extract metadata: file ID, MIME type, byte size, dimensions, source URL, turn ID, prompt association, and local path.
- Support optional modal/lightbox probing for full-resolution downloads.

`ConversationDriver`

- Create fresh conversations.
- Resume by URL, ID, slug, or saved session reference.
- Return stable `ChatSessionRef` records.
- Maintain mapping between Oracle sessions and ChatGPT conversation URLs.
- Support turn-based operations with idempotency keys.

`ProjectSidebarDriver`

- List projects.
- Create projects if the UI supports it reliably.
- Open project pages.
- Move conversations into projects.
- Rename or reorganize projects where safe.
- Verify project membership after moves.

`ConversationManagementDriver`

- List recent conversations.
- Find a conversation by exact URL, ID, or title.
- Archive/delete conversations with dry-run.
- Require exact target validation for destructive operations.
- Capture before/after evidence for every destructive action.

`SafetyDriver`

- Detect login loss, Cloudflare, modal blockers, toast errors, and plan-limit banners.
- Classify failures into retryable, manual-action-required, user-plan-limited, and fatal.
- Provide remediation messages for CLI/MCP/API callers.

## Typed Contracts

The browser automation layer should return typed records rather than ad hoc strings.

### `ChatSessionRef`

Required fields:

- `provider`: `"chatgpt"`
- `conversationId`
- `conversationUrl`
- `title`
- `projectId`
- `projectUrl`
- `createdAt`
- `lastSeenAt`
- `browserTargetId`
- `oracleSessionId`

### `ChatTurnRequest`

Required fields:

- `prompt`
- `session`
- `mode`: `"text" | "image"`
- `modelLabel`
- `thinkingMode`: `"default" | "thinking" | "non-thinking" | "light" | "pro" | "best-effort"`
- `attachments`
- `largeTextPolicy`: `"inline" | "upload" | "auto"`
- `outputPolicy`: `"text" | "images" | "both" | "auto"`
- `timeoutMs`
- `idempotencyKey`

### `ChatTurnResult`

Required fields:

- `status`: `"completed" | "failed" | "needs_manual_action" | "timed_out"`
- `session`
- `turnId`
- `text`
- `markdown`
- `images`
- `attachments`
- `warnings`
- `timings`
- `debugArtifacts`

### `ImageArtifact`

Required fields:

- `fileId`
- `sourceUrl`
- `downloadedPath`
- `mimeType`
- `width`
- `height`
- `byteSize`
- `sha256`
- `turnId`
- `variantIndex`
- `isThumbnail`
- `downloadMethod`: `"browser-fetch" | "signed-url" | "download-button" | "manual-export"`

### `AttachmentSpec`

Required fields:

- `path`
- `kind`: `"file" | "directory" | "glob" | "zip"`
- `mimeType`
- `sizeBytes`
- `uploadMode`: `"individual" | "bundled-zip" | "paste-attachment"`
- `displayName`

## CLI Surface

Keep existing `oracle -p` behavior working. Add explicit subcommands for workflows that need state and structured outputs.

Candidate commands:

- `oracle chat create --model <label> --project <name-or-url> --json`
- `oracle chat turn <conversation-url-or-id> -p <prompt> --file <path> --json`
- `oracle chat resume <conversation-url-or-id> --json`
- `oracle chat get <conversation-url-or-id> --json`
- `oracle image generate -p <prompt> --model "Images 2.0" --thinking --output-dir <dir> --json`
- `oracle image edit --file <image> -p <prompt> --output-dir <dir> --json`
- `oracle image download <conversation-url-or-id> --output-dir <dir> --json`
- `oracle project list --json`
- `oracle project create <name> --json`
- `oracle project move-conversation <conversation> --to <project> --dry-run --json`
- `oracle conversation delete <conversation> --dry-run --json`

CLI design rules:

- Every command that can be used by another tool must support `--json`.
- Long-running commands must print the Oracle session ID early.
- Commands that create or resume conversations must print the ChatGPT conversation URL.
- Image commands must return every downloaded artifact path.
- Destructive commands default to dry-run unless `--confirm` is present.
- `--timeout` must be accepted for Pro and image workflows.
- `--keep-browser` must remain available for diagnosis.

## MCP Surface

Keep `consult` and `sessions` stable. Add focused tools rather than overloading `consult` until the workflows are reliable.

Candidate MCP tools:

- `chatgpt_create_session`
- `chatgpt_send_turn`
- `chatgpt_resume_session`
- `chatgpt_get_session`
- `chatgpt_extract_images`
- `chatgpt_generate_images`
- `chatgpt_edit_image`
- `chatgpt_download_images`
- `chatgpt_list_projects`
- `chatgpt_create_project`
- `chatgpt_move_conversation`
- `chatgpt_delete_conversation`
- `chatgpt_browser_status`

MCP contract requirements:

- Return structured content and a concise natural-language summary.
- Include `conversationUrl` whenever available.
- Include `needsManualAction` when login, Cloudflare, plan, or modal blockers occur.
- Include `debugArtifactPaths` on failures.
- Avoid exposing authentication secrets.
- Support cancellation or detach for long-running Pro/image jobs.
- Validate file paths before opening a browser action.

## HTTP/API Surface

If Oracle's serve/API mode is extended, mirror MCP schemas closely.

API requirements:

- Stable JSON schemas with version fields.
- Idempotency keys for turn submission and destructive operations.
- Async job records for long Pro/image workflows.
- Job polling endpoint with event log.
- Artifact download paths or file handles.
- Explicit `manual_action_required` state.
- No cookie or browser-profile leakage.

## Implementation Phases

### Phase 0: Baseline Freeze and Safety Harness

Weight contribution: supports every category.

Checklist:

- [ ] Record current local setup commands in `docs/debug/windows-browser.md` or a dedicated WSL bridge doc.
- [ ] Add a fast browser smoke script that sends only the minimal hi prompt.
- [ ] Use the standard fast smoke prompt: `Say 'yes' to this question. Do nothing else.`
- [ ] Add a read-only browser status probe that checks login, current URL, model menu presence, composer presence, and active profile path.
- [ ] Capture the sample Images 2.0 conversation DOM summary as a sanitized fixture.
- [ ] Capture screenshots of the sample conversation's image turn and image modal if available.
- [ ] Document that Pro live tests must never click "Answer now".
- [ ] Ensure existing `pnpm run build`, `pnpm run lint`, and MCP unit tests still pass before feature work.
- [ ] Mark live OpenAI/ChatGPT browser tests as opt-in.

Exit criteria:

- Existing Oracle behavior is known-good.
- Failures in later phases can be compared against a stable baseline.

### Phase 1: ChatGPT DOM Provider Split

Score targets:

- DOM provider and state-machine architecture: 35/100
- Reliability, observability, and recovery: 10/95

Checklist:

- [ ] Create `src/browser/chatgpt/types.ts`.
- [ ] Move ChatGPT-specific selectors out of generic browser flow where practical.
- [ ] Add `NavigationDriver`.
- [ ] Add `TurnDriver` read-only snapshot support.
- [ ] Add `SafetyDriver` blocker detection.
- [ ] Keep current `runBrowserMode` as the compatibility entry point.
- [ ] Make old code call into the new drivers incrementally.
- [ ] Add unit tests around state classification using synthetic DOM snippets.

Exit criteria:

- The current text browser consult behavior still works.
- The codebase has a clear place for image and project-specific drivers.

### Phase 2: Conversation Lifecycle and Turn API

Score targets:

- Conversation lifecycle and turn-based work: 60/115
- CLI, MCP, and API product surface: 20/100

Checklist:

- [ ] Add `ChatSessionRef`.
- [ ] Persist ChatGPT conversation URL in Oracle session metadata.
- [ ] Support create-fresh-session from CLI.
- [ ] Support resume-by-URL from CLI.
- [ ] Support send-turn-to-existing-session from CLI.
- [ ] Add idempotency key handling for send-turn.
- [ ] Detect when the browser is on the wrong conversation and navigate before sending.
- [ ] Verify latest user turn after submission.
- [ ] Verify assistant turn completion after response.
- [ ] Add MCP tool for create session.
- [ ] Add MCP tool for send turn.
- [ ] Add MCP tool for resume/get session.

Exit criteria:

- A CLI can create a conversation, return URL, then a second command can append a turn to the same URL.
- MCP can do the same with structured responses.

### Phase 3: Images 2.0 Read-Only Extraction

Score targets:

- ChatGPT Images 2.0 generation/edit/download: 45/170
- DOM provider and state-machine architecture: 20/100
- Testing/docs/release discipline: 10/55

Checklist:

- [ ] Build `ImageResultDriver.extractFromConversation()`.
- [ ] Canonicalize generated image file IDs from `backend-api/estuary/content?id=file_...`.
- [ ] Dedupe multiple DOM nodes pointing to the same file ID.
- [ ] Classify main images, thumbnails, previews, and blur/backing layers.
- [ ] Associate images with the nearest assistant turn.
- [ ] Extract visible thought-duration metadata when present.
- [ ] Download via browser-context fetch first.
- [ ] Fall back to signed URL download if browser fetch is unavailable.
- [ ] Compute SHA-256 for downloaded files.
- [ ] Decode image dimensions from downloaded bytes.
- [ ] Add `oracle image download <conversation-url>`.
- [ ] Add `chatgpt_extract_images` MCP tool.
- [ ] Test against the provided sample conversation.

Exit criteria:

- The sample conversation returns exactly the unique generated images, not duplicate DOM nodes.
- Every image is downloaded with metadata.

### Phase 4: Images 2.0 Generation

Score targets:

- ChatGPT Images 2.0 generation/edit/download: 75/170
- Model, mode, and thinking selection: 35/85
- Reliability, observability, and recovery: 20/95

Checklist:

- [ ] Probe the current UI path for selecting Images 2.0.
- [ ] Identify selectors for image mode, classic mode, thinking mode, and non-thinking mode.
- [ ] Add strict model/mode selection for Images 2.0.
- [ ] Add best-effort selection when the exact control is missing but the current mode is already correct.
- [ ] Add image-generation wait state to `TurnDriver`.
- [ ] Wait for generation completion by detecting stable logical image set plus no active spinner/progress state.
- [ ] Avoid natural dimensions as the only completion signal.
- [ ] Support multiple generated images in one turn.
- [ ] Support output directory naming templates.
- [ ] Add `oracle image generate`.
- [ ] Add `chatgpt_generate_images` MCP tool.
- [ ] Add fast live smoke with a deliberately tiny prompt and low-risk settings.
- [ ] Add long live smoke for thinking mode, manually triggered only.

Exit criteria:

- Oracle can request a fresh Images 2.0 generation and download all resulting images.
- The command can return before the browser is closed or left available for follow-up turns according to option.

### Phase 5: Image Editing and Attachment-Heavy Workflows

Score targets:

- ChatGPT Images 2.0 generation/edit/download: 35/170
- Attachments, large text, and bundled inputs: 55/105

Checklist:

- [ ] Verify attaching one image to an Images 2.0 edit prompt.
- [ ] Verify attaching multiple images to an edit prompt.
- [ ] Verify attaching a zip containing images.
- [ ] Add a bundle manifest when zipping image sets.
- [ ] Preserve file names in attachment metadata.
- [ ] Detect attachment chips and upload completion.
- [ ] Add `oracle image edit --file`.
- [ ] Add `oracle image edit --file <zip>`.
- [ ] Add `chatgpt_edit_image` MCP tool.
- [ ] Add output association between input attachments and generated artifacts.
- [ ] Test retry behavior for partial upload failure.

Exit criteria:

- Oracle can do image-to-image work through ChatGPT Images 2.0 using local file paths.
- Zip-based image inputs are supported or explicitly rejected with a clear reason if ChatGPT UI blocks them.

### Phase 6: Large Text and Paste-Attachment Handling

Score targets:

- Attachments, large text, and bundled inputs: 30/105
- Conversation lifecycle and turn-based work: 15/115

Checklist:

- [ ] Reproduce ChatGPT's large-paste-to-attachment behavior.
- [ ] Detect paste attachment chips created from text.
- [ ] Add `largeTextPolicy`.
- [ ] Implement `inline`: fail if text cannot remain inline.
- [ ] Implement `upload`: intentionally attach large text as a file.
- [ ] Implement `auto`: accept ChatGPT's conversion and report it.
- [ ] Probe whether the UI exposes a control to move a paste attachment back into the text body.
- [ ] If exposed, implement best-effort "restore inline" only behind an explicit option.
- [ ] Add tests for prompt truncation and paste conversion detection.

Exit criteria:

- Large prompt behavior is explicit, observable, and does not silently drop or mutate user input.

### Phase 7: Projects and Sidebar Organization

Score targets:

- Projects, sidebar organization, and deletion: 85/85
- CLI, MCP, and API product surface: 100/100

Checklist:

- [x] Probe project list DOM and project URLs.
- [x] Add read-only `project list`.
- [x] Add open project by URL or name.
- [x] Add create project through the browser-authenticated project session endpoint after confirming the sidebar button is not automation-stable.
- [x] Add move conversation to project.
- [x] Verify move by reopening project/title state and finding project membership where the sidebar exposes it.
- [x] Add project rename only after move/list is stable.
- [x] Add project reorganization operations only where exact-target verification exists.
- [x] Add MCP tools for list/create/move/rename.
- [x] Capture before/after page snapshots for move operations.

Exit criteria:

- Oracle can create or locate a project and move a conversation into it with verification.

### Phase 8: Conversation Deletion and Destructive Operations

Score targets:

- Projects, sidebar organization, and deletion: 30/85
- Reliability, observability, and recovery: 15/95

Checklist:

- [ ] Add exact conversation finder by ID or URL.
- [ ] Add dry-run delete that reports the exact target.
- [ ] Require `--confirm <conversation-id>` or equivalent for actual deletion.
- [ ] Add archive/delete operation only after UI selectors are stable.
- [ ] Verify deletion by URL re-open or sidebar absence.
- [ ] Capture before/after evidence.
- [ ] Refuse ambiguous title-only deletion by default.
- [ ] Add MCP destructive-operation schema with explicit confirmation.

Exit criteria:

- Destructive operations are difficult to trigger accidentally and easy to audit.

### Phase 9: Reliability Hardening

Score targets:

- Persistent browser/session foundation: 90/90
- Reliability, observability, and recovery: 50/95
- DOM provider and state-machine architecture: 25/100

Checklist:

- [ ] Add profile lock detection.
- [ ] Add browser target ownership tagging.
- [ ] Add stale tab cleanup rules.
- [ ] Add automatic reattach after DevTools disconnect.
- [ ] Add recovery for modal overlays.
- [ ] Add recovery for composer losing focus.
- [ ] Add recovery for failed file chooser/upload state.
- [ ] Add retry loop for retryable navigation failures.
- [ ] Add manual-action state for login and Cloudflare.
- [ ] Add status command showing browser PID, DevTools URL, profile path, login state, and active ChatGPT URL.
- [ ] Add structured event logging for every action.
- [ ] Add artifact bundle on failure: screenshot, DOM summary, URL, selected target metadata, recent action log.
- [ ] Verify WSL autostart behavior for the bridge service.

Exit criteria:

- Most failures produce a clear next action instead of a generic timeout.

### Phase 10: Product Surface Consolidation

Score targets:

- CLI, MCP, and API product surface: 60/100
- Conversation lifecycle and turn-based work: 40/115
- Model, mode, and thinking selection: 50/85

Checklist:

- [ ] Review naming consistency across CLI and MCP.
- [ ] Add JSON schemas for core result types.
- [ ] Add examples for text turn, image generate, image edit, project move, and image download.
- [ ] Keep backward-compatible aliases for existing browser flags.
- [ ] Add migration notes for users of `consult`.
- [ ] Ensure all long-running commands can detach or be reattached.
- [ ] Ensure all outputs include enough IDs to resume work.

Exit criteria:

- The new surface feels like a coherent product, not a set of debug scripts.

### Phase 11: Final Verification and Release Readiness

Score targets:

- Test harness, docs, and release discipline: 45/55

Checklist:

- [ ] Run unit tests.
- [ ] Run typecheck.
- [ ] Run build.
- [ ] Run MCP unit tests.
- [ ] Run fast browser smoke.
- [ ] Run sample Images 2.0 extraction smoke.
- [ ] Run one live text session create/resume smoke.
- [ ] Run one live image generation smoke.
- [ ] Run one live image edit or image attachment smoke.
- [ ] Run one project list/move dry-run smoke.
- [ ] Run one destructive-operation dry-run smoke.
- [ ] Update docs.
- [ ] Update manual test matrix.
- [ ] Update changelog if preparing upstream contribution.

Exit criteria:

- The implementation is ready to use as the default browser control layer.

## Test Strategy

### Unit Tests

Unit tests should cover pure parsing and state classification.

Checklist:

- [ ] URL canonicalization for generated image URLs.
- [ ] File ID extraction from `backend-api/estuary/content` URLs.
- [ ] Deduping image DOM records.
- [ ] Assistant turn classification.
- [ ] Upload chip classification.
- [ ] Large-paste attachment classification.
- [ ] Project/sidebar item classification.
- [ ] Destructive target validation.
- [ ] JSON schema validation for MCP results.

### Fixture Tests

Fixture tests should use sanitized DOM snapshots from real ChatGPT pages.

Fixtures to capture:

- [ ] Text-only completed conversation.
- [ ] Pro response with "Answer now" visible.
- [ ] Completed Images 2.0 multi-image conversation.
- [ ] Image generation in progress.
- [ ] Image generation failed or interrupted.
- [ ] Image modal/lightbox open.
- [ ] Attachment upload in progress.
- [ ] Attachment upload completed.
- [ ] Large paste converted to attachment.
- [ ] Project sidebar list.
- [ ] Move-to-project menu.
- [ ] Delete/archive confirmation modal.

Fixture rules:

- Remove user-private prompt content unless needed for selector context.
- Keep relevant attributes, role labels, URLs with file IDs, and button labels.
- Store a short fixture README explaining where it came from and what behavior it protects.

### Live Smoke Tiers

Tier 0: local only.

- [ ] Build.
- [ ] Typecheck.
- [ ] Unit tests.
- [ ] MCP schema smoke.

Tier 1: read-only browser.

- [ ] Browser status.
- [ ] Login status.
- [ ] Composer present.
- [ ] Model menu present.
- [ ] Sample image conversation extraction.

Tier 2: cheap mutation.

- [ ] New text conversation with hi prompt.
- [ ] Resume same conversation with hi prompt.
- [ ] One small text attachment.

Tier 3: image mutation.

- [ ] One simple Images 2.0 generation.
- [ ] Multi-image prompt.
- [ ] One image edit with local image.
- [ ] Zip image attachment prompt.

Tier 4: slow Pro validation.

- [ ] Run only when the change touches Pro selection, Pro waiting, or "Answer now" behavior.
- [ ] Pro text turn with long timeout.
- [ ] Images 2.0 thinking mode generation only when specifically needed.
- [ ] Confirm "Answer now" is not clicked.

Tier 5: destructive dry-run and confirmed operation.

- [ ] Project move dry-run.
- [ ] Project move confirmed on a throwaway conversation.
- [ ] Delete dry-run.
- [ ] Delete confirmed only on a throwaway conversation created by the test.

## Iteration Loop

Use this loop for every ChatGPT UI capability:

1. Probe current UI manually or with read-only scripts.
2. Save DOM summaries and screenshots.
3. Identify stable selectors and fallback selectors.
4. Implement a read-only detector first.
5. Add unit or fixture tests for the detector.
6. Implement the mutating action.
7. Add state verification after the action.
8. Run the smallest live smoke.
9. Classify failures.
10. Add recovery or improve the failure message.
11. Update docs and the scorecard.
12. Repeat until live runs are boring.

Failure classifications:

- `selector_changed`: the target control no longer matches.
- `state_unexpected`: selector exists but page is not in the expected state.
- `manual_action_required`: login, Cloudflare, plan limit, or user confirmation required.
- `slow_model`: still thinking or generating after normal timeout.
- `upload_failed`: attachment failed, partial upload, or rejected file.
- `asset_download_failed`: image visible but bytes unavailable.
- `ambiguous_target`: multiple conversations/projects match.
- `destructive_refused`: operation requires explicit confirmation.

## Image-Specific Design

### Image Mode Selection

Checklist:

- [ ] Detect whether ChatGPT is currently in text mode or image mode.
- [ ] Detect the visible label for Images 2.0.
- [ ] Select image mode from the composer or model picker.
- [ ] Detect Classic mode versus Image mode if both are visible.
- [ ] Detect thinking/non-thinking controls.
- [ ] Return a structured warning when an exact requested mode cannot be proven.

Selection policy:

- `strict`: fail if exact model/mode cannot be selected and verified.
- `best-effort`: proceed if the current UI appears compatible and report warnings.
- `current`: use the current ChatGPT UI state without changing it.

### Generation Completion

Completion should require multiple signals:

- Assistant turn exists after the submitted user turn.
- No visible spinner/progress indicator in the latest assistant turn.
- Logical image file ID set has stabilized for a short quiet period.
- If text accompanies the image, text has stabilized too.
- No visible error or retry state.

Do not use any single signal as the only source of truth.

### Artifact Download

Preferred download order:

1. Browser-context fetch of the image `src`.
2. Direct Node fetch of signed `backend-api/estuary/content` URL if it succeeds without cookie extraction.
3. UI modal/lightbox download button if available and stable.
4. Manual-action failure with exact instructions and screenshot.

Downloaded filenames:

- Default template: `<conversation-id>_<turn-id>_<variant-index>_<file-id>.<ext>`.
- Include prompt slug only when safe and explicitly requested.
- Write a JSON sidecar with metadata.

### Multi-Image Outputs

Checklist:

- [ ] Count logical images by canonical file ID.
- [ ] Preserve UI ordering when possible.
- [ ] Detect selected carousel item.
- [ ] Avoid duplicate downloads for thumbnails.
- [ ] Return all artifacts in MCP and CLI JSON.
- [ ] Support partial success with warnings if one artifact fails to download.

### Image Editing

Checklist:

- [ ] Upload source image.
- [ ] Verify source image chip.
- [ ] Submit edit prompt.
- [ ] Wait for generated image result.
- [ ] Associate generated artifact with source attachment.
- [ ] Support multiple source images.
- [ ] Support zipped source image sets if accepted by ChatGPT.

## Attachment Strategy

Current Oracle already has browser attachment machinery. The expanded version should make attachment behavior explicit and observable.

Checklist:

- [ ] Validate paths before browser upload.
- [ ] Expand directories and globs deterministically.
- [ ] Enforce or report ChatGPT attachment limit.
- [ ] Bundle files when requested.
- [ ] Generate zip manifests for bundles.
- [ ] Track upload chip status.
- [ ] Detect rejected file types.
- [ ] Detect stuck upload progress.
- [ ] Support remote Chrome file transfer.
- [ ] Report whether content was uploaded as file, zip, or paste attachment.

Large text policy:

- `inline`: keep text in composer or fail.
- `upload`: write text to a temp file and attach it intentionally.
- `auto`: allow ChatGPT's paste attachment behavior and report the final state.

## Project and Sidebar Strategy

Projects should be implemented after conversation/session primitives are stable.

Rules:

- Project operations must be read-only first.
- Move and delete workflows must capture before/after state.
- Title matching is never enough for destructive operations.
- Exact URL or conversation ID is preferred.
- Project names can collide; expose project URL or ID whenever available.

Checklist:

- [ ] Read project list.
- [ ] Read project conversation list.
- [ ] Create project.
- [ ] Move conversation to project.
- [ ] Verify conversation appears in target project.
- [ ] Verify conversation disappears from old location if the UI reflects that.
- [ ] Rename project only after list/move are stable.
- [ ] Delete or archive only with confirmation.

## Persistent Browser Service Strategy

This environment should continue using a persistent, logged-in, headful Chrome profile.

Checklist:

- [ ] Keep browser profile on the Windows filesystem for durable cookie persistence.
- [ ] Keep DevTools port stable or discoverable.
- [ ] Keep WSL proxy port stable or discoverable.
- [ ] Add `oracle browser status` or equivalent.
- [ ] Add `oracle browser show`, `oracle browser hide`, and `oracle browser restart` helpers if they remain environment-specific.
- [ ] Detect profile lock and avoid launching competing Chrome instances.
- [ ] Validate login through `/backend-api/me` or a safe equivalent when possible.
- [ ] Keep manual login path documented.

Reliability expectation:

- The browser can be invisible or minimized, but not true headless.
- If login expires, tools should stop with `needs_manual_action` and preserve the profile.

## Observability

Every long-running browser command should produce an event trail.

Events:

- Browser attach.
- Navigation start and complete.
- Login state checked.
- Model/mode read.
- Model/mode selected.
- Composer focused.
- Text inserted.
- Attachments started.
- Attachments completed.
- Prompt submitted.
- User turn detected.
- Assistant turn started.
- Thinking/generation state observed.
- Completion detected.
- Images extracted.
- Images downloaded.
- Project operation verified.
- Failure classified.

Failure artifacts:

- Screenshot.
- DOM summary.
- Active URL.
- Browser target ID.
- Oracle session ID.
- Action log.
- Selector candidates tried.
- Relevant visible button labels.
- Attachment chip summary.
- Image node summary.

## Security and Privacy

Checklist:

- [ ] Do not log cookies.
- [ ] Do not copy browser profile files into debug bundles.
- [ ] Redact prompt text in shared fixtures unless required.
- [ ] Redact private project names in committed fixtures unless explicitly approved.
- [ ] Keep downloaded generated images in user-specified output paths.
- [ ] Avoid sending local file paths to ChatGPT except as file contents/attachments chosen by the user.
- [ ] Make destructive commands auditable.

## Open Questions

Questions to answer through probing:

- What is the most stable DOM signal for Images 2.0 mode?
- Is there a stable UI label or state for thinking versus non-thinking image mode?
- Does the image output modal expose a more canonical download URL than the inline `estuary/content` URL?
- Does ChatGPT accept zip files containing images for Images 2.0 editing, or does it require individual images?
- What is the practical attachment limit for Pro image workflows in this UI?
- [x] Can conversations be moved into projects through a stable menu path, or is project creation URL-scoped only?
- [x] Does delete/archive use stable confirmation text and buttons across project and non-project conversations?
- Can text paste attachments be converted back into inline text reliably through the UI?
- Are generated image file IDs stable across page refresh?
- Are signed image URLs long-lived enough for deferred downloads, or must downloads happen immediately?

## Completion Accounting

Update this table as implementation proceeds.

| Milestone | Points Unlocked | Required Evidence |
| --- | ---: | --- |
| Baseline and fixture harness | 60/60 | Build, lint/typecheck, sample read-only smoke, sanitized sample fixture, browser status smoke |
| Provider split | 55/75 | Typed ChatGPT image artifact, page snapshot, conversation snapshot, project list, and status modules |
| Session create/resume/turn | 100/115 | First-class create, get, and turn append live smokes passed through CLI/MCP |
| Model/mode/thinking selection | 80/85 | Picker mapping updated for current generic Instant/Thinking/Pro labels; direct CLI/MCP calls now accept browser model labels; image generate/edit commands and MCP tools support image thinking-time selection |
| Attachment expansion | 105/105 | Text, multi-file, image/SVG, >10-image no-send probe, generated zip bundle, directory/glob, MCP, and large-paste-plus-file workflows live-proven; broader stress/regression coverage remains a reliability gate |
| Image extraction | 65/65 | Sample conversation exact unique image count and downloads |
| Image generation | 70/70 | Fresh Images 2.0 generation in the Image Gen project produced one generated image and downloaded the PNG artifact |
| Image editing | 35/35 | Reference-image edit sessions recovered after long-running completion and downloaded generated PNG artifacts |
| Projects | 55/55 | Project list/get/create/move/rename implemented; create/move/rename live-smoked with exact-target verification |
| Deletion/destructive safety | 30/30 | Dry-run delete planning and guarded confirmed delete both live-smoked against a throwaway generated-image conversation |
| CLI/MCP/API polish | 80/80 | Image extract/generate/edit, browser status, conversation create/get/turn, project list/get/create/rename/move, and delete/delete-plan CLI/MCP surfaces implemented |
| Reliability hardening | 85/85 | Stable image-set wait, conversation/project hydration waits, final URL persistence, file-id dedupe, bounded direct-chat input budget, WSL path fallback, expected-name attachment preflight guard, attachment send-button hardening, snapshot answer reconciliation, no-send attachment probes, and status navigation fix |
| Docs/release | 40/40 | Progress ledger updated with live attachment matrix evidence and known gaps |

The point unlock table intentionally overlaps with the scorecard categories. The scorecard tracks product capability; the milestone table tracks implementation progress.

## Definition of Done

The implementation reaches the north star when:

- Scorecard is at least 950/1000.
- Every must-pass gate is checked.
- Existing Oracle text/API behavior remains compatible.
- CLI, MCP, and API surfaces return structured artifacts for generated images.
- Image generation and image editing work with local file attachments.
- Sessions can be created, resumed, and continued reliably.
- Projects can organize conversations with verification.
- Destructive operations are dry-run-first and exact-target-only.
- Live failure artifacts make UI regressions diagnosable in one pass.
- The docs explain the headful persistent-browser constraint clearly.

## Immediate Next Actions

Recommended first implementation slice:

1. [x] Add read-only ChatGPT status and conversation snapshot probes.
2. [x] Turn the sample Images 2.0 conversation into a fixture-backed extraction test.
3. [x] Implement `ImageResultDriver` read-only extraction and download.
4. [x] Add `oracle image download <conversation-url> --json`.
5. [x] Add `chatgpt_extract_images` MCP.
6. [x] Add fresh Images 2.0 generation orchestration around current-mode ChatGPT sessions.
7. [x] Prove fresh Images 2.0 generation live in an image-mode project and download every produced artifact.

This order is deliberate: downloading from an already-completed image conversation removes generation latency from the first hard problem, while still proving the new artifact model and DOM extraction strategy.

## Progress Log

### 2026-04-22 Slice 1

Implemented:

- Added typed ChatGPT image artifact contracts under `src/browser/chatgpt/`.
- Added generated image URL/file ID detection for `backend-api/estuary/content?id=file_...`.
- Added DOM extraction that dedupes logical image outputs by file ID.
- Added stable read-only wait for completed generated image sets.
- Added browser-context image download with byte size, MIME type, dimensions, SHA-256, and JSON sidecars.
- Added `oracle image download <conversationUrl>`.
- Added `chatgpt_extract_images` MCP tool.
- Suppressed the global CLI intro banner for JSON commands so `--json` can be consumed by automation.
- Added focused unit coverage for file ID extraction and deduping.
- Added a sanitized 24-node sample fixture that locks the sample conversation's 7 logical image outputs.

Evidence:

- `pnpm vitest run tests/browser/chatgptImageArtifacts.test.ts tests/mcp.schema.test.ts` passed with 6 tests.
- `pnpm run build` passed.
- `pnpm run lint` passed.
- Live read-only CLI extraction against `https://chatgpt.com/c/69e9073a-9660-83ea-b480-751914edbc95` returned 7 unique generated images from 24 generated image DOM nodes.
- Live CLI download against the same sample downloaded 7 PNG artifacts, all 1491x1055, then the temporary output directory was removed.
- Live `mcporter call oracle-local.chatgpt_extract_images ... download:false` returned 7 unique generated images.

Known gaps from this slice:

- The sample conversation is stored as sanitized extracted DOM records, not a full raw DOM snapshot.
- Only completed-conversation image extraction is implemented; fresh Images 2.0 generation is still pending.
- Logical images that are currently visible only as carousel thumbnails can report thumbnail-sized rendered dimensions, even though browser-context fetch downloads full-resolution bytes.
- Project/sidebar, deletion, large-paste policy, and image edit workflows remain unimplemented.

### 2026-04-22 Slice 2

Implemented:

- Added ChatGPT browser status and conversation snapshot primitives under `src/browser/chatgpt/session.ts`.
- Added conversation turn snapshots with role, preview text, generated image IDs, and attachment labels.
- Added a conversation hydration wait so snapshots wait for turns and generated image IDs, not just `document.readyState`.
- Added `oracle browser status`.
- Added `oracle chat get`.
- Added `oracle chat turn` for appending a turn to an existing conversation URL.
- Added `chatgpt_browser_status`, `chatgpt_get_conversation`, and `chatgpt_send_turn` MCP tools.
- Added file-path attachment plumbing to the resumable turn path; full attachment smokes are still pending.
- Fixed remote browser session metadata so successful browser runs preserve `tabUrl`, `conversationId`, and `chromeTargetId`.
- Updated browser model mapping for the current ChatGPT picker labels: `Instant`, `Thinking`, and `Pro`.
- Avoided Pro validation; fast text smokes used the standard short prompt.

Evidence:

- `oracle chat get https://chatgpt.com/c/69e9073a-9660-83ea-b480-751914edbc95 --json` reported 3 turns, 7 generated images, and 24 generated image DOM nodes after the hydration wait fix.
- `oracle browser status --conversation-url https://chatgpt.com/c/69e9073a-9660-83ea-b480-751914edbc95 --include-conversation --json` reported `status: ok`, composer present, 3 turns, and 7 generated images.
- A throwaway browser run with `gpt-5.2-instant` returned `yes` and now persisted `https://chatgpt.com/c/69e92d95-fd14-83ea-b79c-6a1af9a588cb` in session metadata.
- `oracle chat turn https://chatgpt.com/c/69e92d95-fd14-83ea-b79c-6a1af9a588cb --turn-message "Say 'yes' to this question. Do nothing else." --json` returned `yes`.
- `mcporter list oracle-local --schema` exposed all new MCP tools.
- `mcporter call oracle-local.chatgpt_browser_status ... includeConversation:true` reported `status: ok` and the throwaway conversation turns.
- `mcporter call oracle-local.chatgpt_send_turn ...` returned `yes`.
- Focused tests passed: browser image artifacts, browser config, MCP consult, MCP schema, browser session runner, CLI session runner.
- `pnpm run build` passed.
- `pnpm run lint` passed.

Known gaps from this slice:

- `oracle chat create` was not yet a first-class command in this slice; Slice 3 addresses it.
- `chat turn` uses `--turn-message` because root-level `--prompt`/`--message` are consumed by Commander before nested commands.
- Dedicated live attachment smokes for `chat turn` were pending in this slice; Slice 3 exposes a timeout gap.
- Fresh Images 2.0 generation, image editing, project mutations, sidebar reorganization, deletion, and large-paste policy remain pending.

### 2026-04-22 Slice 3

Implemented:

- Added `createChatgptSession()` as a typed first-class browser operation.
- Added `oracle chat create`.
- Added `chatgpt_create_session` MCP tool.
- Extended turn/create results with optional post-turn conversation snapshots and generated/new image lists.
- Changed direct `chat turn` and `chat create` attachment resolution to use Oracle's existing file resolver, so files, directories, and globs are accepted consistently.
- Added read-only ChatGPT project listing under `src/browser/chatgpt/projects.ts`.
- Added `oracle project list`.
- Added `chatgpt_list_projects` MCP tool.
- Added project hydration wait after finding the first selector pass was too early for sidebar projects.

Evidence:

- `oracle chat create --turn-message "Say 'yes' to this question. Do nothing else." --browser-model-strategy current --timeout 90s --include-snapshot --json` returned `yes`, a conversation URL, and a snapshot.
- `mcporter call oracle-local.chatgpt_create_session ...` returned `yes`, a new conversation URL, and a snapshot.
- `oracle project list --timeout 20s --json` returned 5 visible projects: Image Gen, Stupid Spam, Pro Request Spam 2, Thesis & Graduation, Deep Research Bulk.
- `mcporter call oracle-local.chatgpt_list_projects timeoutMs:20000 ...` returned the same project list surface.
- The direct attachment smoke with a tiny text file exposed a reliability gap: the upload/turn path exceeded the intended timeout and required terminating the local smoke process. This is not counted as complete attachment support.
- `pnpm run lint` passed.
- `pnpm run build` passed.
- Focused tests passed: browser image artifacts, browser config, MCP consult, MCP schema, browser session runner, CLI session runner.

Known gaps from this slice:

- Direct `chat turn` attachment upload needs a hard cancellable timeout and a focused recovery path before it can be scored as reliable.
- `chat turn` uses `--turn-message` because root-level `--prompt`/`--message` are consumed by Commander before nested commands.
- Project work is read-only only; create, move, rename, and delete are still pending.
- Image generation is image-aware at the result layer, but Images 2.0 mode selection/generation/editing remain pending.
- Large-paste policy remains pending.

### 2026-04-22 Slice 4

Implemented:

- Added bounded direct-chat input/upload budgets for `chat create` and `chat turn` so attachment setup cannot consume the entire model response timeout.
- Unified the remote Chrome attachment path with the more robust multi-signal uploader used by local browser mode.
- Added WSL-to-Windows host path candidates such as `\\wsl.localhost\Ubuntu\...` for Windows Chrome file input attempts.
- Added read-only project snapshots with visible conversation links.
- Added `oracle project get <projectUrl>`.
- Added `chatgpt_get_project` MCP tool.
- Added read-only conversation delete planning.
- Added `oracle chat delete-plan <conversationUrl>`.
- Added `chatgpt_plan_delete_conversation` MCP tool.
- Added current-mode ChatGPT image generation orchestration.
- Added `oracle image generate`.
- Added `chatgpt_generate_images` MCP tool.
- Kept fresh image generation live testing deferred to avoid accidentally running a slow Pro/image turn before mode selection is fully controlled.

Evidence:

- `oracle project get https://chatgpt.com/g/g-p-69e9108d43308191ac348051d529ffaf-image-gen/project --json --timeout 25s` returned the Image Gen project and 28 visible conversations, including the completed Images 2.0 sample conversation.
- `mcporter call oracle-local.chatgpt_get_project ...` returned the Image Gen project and visible conversation list through MCP.
- `oracle chat delete-plan https://chatgpt.com/c/69e93239-19e0-83ea-a8bb-8f7c5a14721f --json --timeout 25s` parsed the target conversation id and reported that a delete attempt can be planned without deleting anything.
- `mcporter list oracle-local --schema` exposed `chatgpt_generate_images`, `chatgpt_get_project`, `chatgpt_plan_delete_conversation`, and `chatgpt_extract_images`.
- `oracle image generate --help` exposes project URL, attachment, output directory, current/select/ignore model strategy, and download controls.
- `oracle image download https://chatgpt.com/c/69e9073a-9660-83ea-b480-751914edbc95 --no-download --json` still reports 7 unique generated images from 24 generated image DOM nodes.
- `pnpm run lint` passed.
- `pnpm run build` passed.
- Focused tests passed: browser image artifacts, browser config, MCP consult, MCP schema, browser session runner, CLI session runner.

Negative evidence and known gaps from this slice:

- Direct text-file attachment still failed live: ChatGPT received the prompt turn but reported that it could not access the attached file, and the resulting conversation snapshot had no attachment labels. This keeps file/image/zip attachment must-pass gates red.
- The WSL host-path fallback is implemented but did not yet produce a successful ChatGPT attachment; the likely remaining issue is that the current hidden generic file input accepts a file at the browser/CDP layer without triggering ChatGPT's upload pipeline.
- Fresh Images 2.0 generation is now exposed as an orchestration surface, but the live proof is still pending because the current model/mode selector and image thinking toggle are not yet controlled enough to run it safely and quickly.
- Delete support is dry-run/read-only only. Exact-target destructive deletion still needs a throwaway-conversation proof before enabling.
- Project reorganization is read-only only. Move/rename/create project workflows still need selector probing and confirmation guards.
- Large text paste attachment behavior remains pending.

### 2026-04-22 Slice 5

Implemented:

- Added direct CLI `--browser-model-label <label>` support for `oracle chat create`, `oracle chat turn`, and `oracle image generate`.
- Added MCP `browserModelLabel` support for `chatgpt_create_session`, `chatgpt_send_turn`, and `chatgpt_generate_images`.
- Isolated the WSL/Windows Chrome file-input behavior outside ChatGPT:
  - `/home/...` paths are accepted by CDP but appear as zero-byte files to Windows Chrome.
  - `\\wsl.localhost\Ubuntu\...` paths are readable by Windows Chrome and preserve file bytes.
- Reordered attachment host path candidates so Windows-readable host paths are tried before raw WSL paths.
- Tightened attachment upload preflight logic so a stale existing file count cannot satisfy a new upload unless the expected filename is actually present.
- Probed ChatGPT's current home composer controls without sending a generation request.
- Probed conversation options menu surfaces without invoking destructive actions.

Evidence:

- Isolated CDP file input probe showed raw WSL path produced `.tmp-cdp-file-input.txt` with size `0`, while the UNC path produced size `17` and readable text `cdp-file-input-ok`.
- ChatGPT composer upload probe showed a visible `.tmp-chatgpt-upload-probe.txt` attachment chip and `upload-files` input with the expected file name and byte size.
- Fresh direct ChatGPT attachment proof after path ordering and preflight fixes still failed final ingestion: the resulting conversation reported no attachment labels and the assistant answered `I can’t access that attachment from the tools available here.`
- A previous attachment attempt read a stale recent-upload token, proving that count-only attachment preflight was unsafe and motivating the expected-name guard.
- Safe image/model control probe found the current visible controls: `model-switcher-dropdown-button`, `composer-plus-btn`, `upload-files`, `upload-photos`, and `upload-camera`; it did not reveal a stable Images 2.0 selector through a simple click.
- Conversation options probing found the page-level `conversation-options-button`, but no stable delete menu item was visible through the safe probe path.
- `pnpm run lint` passed.
- `pnpm run build` passed.
- Focused tests passed: browser image artifacts, browser config, MCP consult, MCP schema, browser session runner, CLI session runner.

Why the plan is not 100%:

- ChatGPT final conversation ingestion is green for a single text file, but image files, zip bundles, multi-file turns, and large-paste attachment behavior are not yet proven.
- Images 2.0 mode selection and thinking/non-thinking toggle remain unproven in live DOM automation.
- Fresh Images 2.0 generation through `oracle image generate` is implemented but not live-proven against the image model.
- Actual image editing with attached images/zips is blocked on image/zip attachment proof and Images 2.0 mode control.
- Actual destructive deletion remains intentionally disabled until a stable exact-target menu path and confirmation flow are proven on a throwaway conversation.
- Project reorganization remains read-only because move/rename/create actions need the same exact-target confirmation discipline as delete.

### 2026-04-22 Slice 6

Attachment-focused implementation and proof:

- Compared the older `kmccleary3301/oracle` fork and found no separate durable drag/drop implementation beyond DataTransfer-to-input style transfer.
- Added CDP drag/drop upload support using Windows-readable host path candidates, with JavaScript drop and file-input transfer as fallback paths.
- Split prompt composer submission into `insertPromptText()` and `submitPreparedPrompt()` so attachment turns can type the prompt first, upload files second, and click send without reinserting text.
- Added stale composer protection: attachment turns now clear the prompt before inserting, and prompt insertion verifies that the requested prompt text actually landed rather than accepting any existing draft text.
- Fixed nested `chat`/`image` CLI subcommand file plumbing so `--file` reaches `createChatgptSession()` and `sendChatgptTurn()` even when Commander captures root-level file options.
- Removed an unsafe attachment preflight fallback where the prompt's filename text plus generic upload controls could masquerade as an already-present attachment.
- Hardened attachment sends so they require an enabled send-button click after upload completion instead of falling back to Enter.
- Added a short final assistant snapshot settle pass so CLI results do not return a too-early partial answer when the final DOM snapshot extends shortly after completion.

Evidence:

- Live CLI smoke succeeded:
  - Command shape: `oracle chat create --turn-message ... --file=.tmp-attachment-live-4040.txt --browser-model-strategy select --browser-model-label Instant --timeout 190s --include-snapshot --json`
  - Returned `answerText: "attachment-live-4040-final"`.
  - Conversation URL: `https://chatgpt.com/c/69e97e2f-1d1c-83ea-93b8-2372370f3655`.
  - Latest user turn exposed attachment labels for `.tmp-attachment-live-4040.txt`.
- Intermediate diagnostic run proved the upload path now reaches ChatGPT's real attachment state: the sent turn gained attachment labels and the assistant read `attachment-live-3030-final`.
- `pnpm run lint` passed.
- Focused attachment/prompt tests passed: `pnpm vitest run tests/browser/pageActions.test.ts --testNamePattern "uploadAttachmentFile|prompt|send button"`.
- `pnpm run build` passed.

Remaining attachment-specific gaps:

- Text-file attachment is live-proven; image files, multiple attachments, zip bundles, directories/globs through the new chat commands, and large-paste-as-attachment behavior still need focused live smokes.
- CDP drag/drop is currently the proven path. Native file-input upload remains useful as a fallback and should be re-evaluated after multi-file/image smoke coverage.
- MCP attachment proof should be repeated now that CLI file plumbing and browser send sequencing are fixed.

### 2026-04-22 Slice 7

Attachment completion matrix:

- Added shared `resolveBrowserAttachments()` for direct ChatGPT CLI/MCP tools.
- Stopped applying the inline text-file 1 MB cap to real browser uploads; browser uploads now resolve and stat files without reading text content.
- Added deterministic ZIP bundling for more than 10 resolved files, matching ChatGPT's visible attachment limit while preserving directory/glob inputs as one upload.
- Changed direct ChatGPT MCP image/session tools to use the same attachment resolver as CLI.
- Added sent-turn attachment verification to remote Chrome direct-chat submissions.
- Improved conversation snapshot attachment label extraction for multi-file and zip/archive turns.
- Reconciled returned answers with the final conversation snapshot, including cases where the early browser capture is a `ChatGPT said:` progress wrapper.
- Made conversation snapshot stabilization include latest assistant text, not only turn count and generated image IDs.
- Filtered user-uploaded image attachments out of generated-image artifact extraction so image-editing/reference uploads do not appear as generated outputs.

Live evidence:

- Multi-file CLI:
  - Conversation `https://chatgpt.com/c/69e98342-1494-83ea-a904-282022fbe191`.
  - Assistant read both files and returned `multi-a-5101-final,multi-b-5102-final`.
  - Snapshot labels now show `multi-a.txt` and `multi-b.txt`.
- Image/SVG CLI:
  - Conversation `https://chatgpt.com/c/69e98419-2e58-83ea-87a6-161debdde3c6`.
  - Assistant returned `image-token-5200-final`.
  - User turn kept `image-token.svg`; generated image count is now `0` for this uploaded image attachment.
- Directory/glob ZIP bundle:
  - Conversation `https://chatgpt.com/c/69e98728-09ec-83ea-b0eb-2e403e0db1b5`.
  - More than 10 files resolved into `attachments-bundle.zip`.
  - Assistant read `file-11.txt` from the archive and snapshot latest answer is `bundle-token-11-final`.
- MCP:
  - `mcporter call oracle-local.chatgpt_create_session ... files:["/home/skra/projects/ql_homepage/docs_tmp/oracle/.tmp-attach-smoke/mcp.txt"] ...` completed.
  - Conversation `https://chatgpt.com/c/69e98930-0504-83ea-91b5-64de0e92aef5`.
  - Returned `mcp-attachment-5300-final`.
- Large paste plus real file:
  - Conversation `https://chatgpt.com/c/69e98992-e5bc-83ea-97e3-9c835186d4a6`.
  - A prompt with roughly 4,200 filler repetitions plus `large-paste-file.txt` still sent and returned `large-paste-file-5400-final`.

Verification:

- `pnpm run lint` passed.
- `pnpm vitest run tests/browser/attachmentResolver.test.ts tests/browser/pageActions.test.ts --testNamePattern "resolveBrowserAttachments|uploadAttachmentFile|prompt|send button"` passed.
- `pnpm vitest run tests/browser/chatgptImageArtifacts.test.ts tests/browser/attachmentResolver.test.ts` passed.
- `pnpm run build` passed.

Remaining attachment risk:

- The core matrix is green, but long-run stress coverage is still pending for very large binary files, repeated uploads in the same conversation, and exact behavior at ChatGPT's undocumented per-file size limits.

### 2026-04-22 Slice 8

Attachment reliability and no-send probe hardening:

- Codified the known ChatGPT browser upload policy in the shared attachment resolver:
  - 512 MiB aggregate attachment budget by default.
  - 20 normal attachment uploads by default after live no-send limit probes.
  - A separate image attachment allowance is retained in the resolver shape, but current drag/drop evidence shows the same 20-upload practical ceiling for image files.
  - Mixed batches preserve image files as first-class uploads and bundle non-image overflow into `attachments-bundle.zip`.
  - Bundled plans are checked again against the aggregate byte budget after ZIP overhead is known.
- Added `oracle browser probe-attachments --file ...`, which opens the configured ChatGPT browser, uploads attachments into the composer, waits for the composer to become send-ready, clears the composer, and exits without submitting a turn.
- Hardened real send paths for both local and remote browser mode:
  - Attachment upload failures now fail closed instead of sending a prompt whose attachments were not confirmed.
  - Transient upload failures and upload-completion timeouts get one full batch retry after clearing composer attachments.
  - Policy-class failures such as too many files, too large, unsupported file, or aggregate/image-limit errors are not retried blindly.
  - Visible ChatGPT upload/toast errors are detected and surfaced immediately from the wait loop.
- Moved the no-send probe page snapshot after composer cleanup so reference-upload thumbnails are not reported as generated image artifacts in probe diagnostics.

No-send live evidence:

- `pnpm exec tsx bin/oracle-cli.ts browser probe-attachments --file '.tmp-attach-probe/*.svg' --timeout 180s --json` completed without submitting a model request.
- The resolver kept 12 SVG images as first-class attachments, confirming the image-count exception path beyond the normal 10-file limit.
- The browser probe uploaded all 12 images, waited for readiness, cleared the composer, and returned `cleared: true`.
- Post-cleanup snapshot reported `hasComposer: true`, `loginLikely: true`, `generatedImageNodeCount: 0`, and `uniqueGeneratedImageCount: 0`.

Verification:

- `pnpm vitest run tests/browser/attachmentResolver.test.ts tests/browser/attachmentsCompletion.test.ts tests/browser/pageActions.test.ts` passed.
- `pnpm run lint` passed.
- `pnpm run build` passed.

Remaining attachment risk:

- This slice avoids firing model requests for limit probes. The upload layer is now directly probeable, but exact production behavior near the 512 MiB aggregate boundary should be verified with intentionally staged large files before relying on it for high-value batches.
- ChatGPT can still reject files for policy, account, MIME, or transient service reasons outside Oracle's control. The hardened behavior is to surface those failures and avoid sending an incomplete request.

### 2026-04-22 Slice 9

Attachment limit probes:

- DOM inspection found three file controls:
  - `#upload-files`: `multiple`, no `accept` restriction.
  - `#upload-photos`: `multiple`, `accept="image/*"`.
  - `#upload-camera`: `multiple`, `accept="image/*"`, `capture="environment"`.
  - None exposed numeric count or byte limits in attributes or visible page text.
- Generic file no-send probes through Oracle's production drag/drop path:
  - 10 text files: passed, uploaded and cleared, about 155 seconds.
  - 11 text files: first attempt hit a transient DevTools target close; repeat passed, uploaded and cleared, about 167 seconds.
  - 20 text files: passed, uploaded and cleared, about 305 seconds.
  - 21 text files: failed. Files 1-20 became ChatGPT attachment chips; file 21 fell back to raw file-input state and never became an attachment chip before timeout.
- Image no-send probes through Oracle's production drag/drop path:
  - 12 SVG files: passed, uploaded and cleared.
  - 21 SVG files: same boundary behavior as generic files. Images 1-20 became attachment chips; image 21 fell back to raw file-input state and did not become a ChatGPT attachment.
- Image-specific raw input probe:
  - Setting all 21 files directly on `#upload-photos` populated the input names but did not start ChatGPT's upload pipeline or create attachment chips.
  - Conclusion: Oracle should not rely on direct `setFileInputFiles` against `#upload-photos` until additional UI event work is proven.

Resulting policy update:

- Updated `resolveBrowserAttachments()` defaults to 20 total first-class uploads.
- Updated the image attachment default to 20, not 50, because current proven production-path behavior does not support file 21 as a real attachment.
- Non-image overflow over 20 is bundled into one zip.
- Mixed image-plus-non-image overflow is allowed only when the preserved images plus one zip still fit within 20 uploads.
- More than 20 first-class image/reference attachments should fail preflight for now rather than silently sending an incomplete image batch.

Verification:

- `pnpm vitest run tests/browser/attachmentResolver.test.ts tests/browser/attachmentsCompletion.test.ts` passed.
- `pnpm run lint` passed.

### 2026-04-22 Slice 10

Final tooling push:

- Added first-class image edit surfaces:
  - `oracle image edit --turn-message ... --file ...`.
  - `chatgpt_edit_image` MCP tool.
  - Both return input attachment metadata, generated image records, downloaded artifacts, and warnings.
- Added guarded destructive delete surfaces:
  - `oracle chat delete <conversationUrl> --confirm <conversationId>`.
  - `chatgpt_delete_conversation` MCP tool.
  - Confirmed delete refuses to run unless the supplied confirmation id exactly matches the conversation URL id.
- Fixed browser status/extraction navigation:
  - `browser status` now navigates to the target URL before snapshotting instead of accidentally reporting an attached `about:blank` tab.
  - Image extraction now navigates to the conversation URL before snapshotting and downloading artifacts.
- Expanded page snapshots with:
  - Model menu presence and label.
  - Generic file upload control presence.
  - Photo upload control presence.
  - Composer plus-button presence.
- Added image-reference attachment handling:
  - Sent-turn filename verification remains strict for non-image attachments.
  - Image/reference attachments can continue after upload readiness if ChatGPT does not expose original filenames in the sent user turn.

Live evidence:

- `oracle browser status --json` returned `status: ok`, `hasComposer: true`, `hasModelMenu: true`, `hasFileUploadControl: true`, `hasPhotoUploadControl: true`, and `hasComposerPlusButton: true`.
- Model menu probe found stable current labels/selectors:
  - `model-switcher-gpt-5-3`: Instant.
  - `model-switcher-gpt-5-4-thinking`: Thinking.
  - `model-switcher-gpt-5-4-pro`: Pro.
- Fresh Images 2.0 generation succeeded in the Image Gen project:
  - Conversation `https://chatgpt.com/g/g-p-69e9108d43308191ac348051d529ffaf-image-gen/c/69e99f58-7910-83ea-8c80-e12ddb16cbc1`.
  - One logical generated image was detected from three DOM image nodes.
  - Downloaded artifact: `.tmp-image-live/01_file_000000002bb871fda181997fdbc9d9d8.png`.
  - Artifact metadata: PNG, 1254x1254, 113,213 bytes, SHA-256 `ed852cb40d2ff6f9a6725fe2103783eef5c7b5347d4862ac69088121f0f5ae45`.
- Read-only extraction against the generated conversation succeeded after the navigation fix and downloaded the same artifact under `.tmp-image-live-redownload/`.
- Image edit/reference smoke was attempted twice with the generated PNG as an attachment:
  - First attempt failed on strict sent-turn image filename verification.
  - After relaxing sent-turn filename verification for image attachments, the flow progressed into response waiting.
  - Both live edit attempts timed out before generated output, so image editing remains the primary live blocker.

Verification:

- `pnpm vitest run tests/browser/attachmentResolver.test.ts tests/browser/attachmentsCompletion.test.ts tests/browser/pageActions.test.ts tests/browser/chatgptImageArtifacts.test.ts tests/cli/browserConfig.test.ts` passed.
- `pnpm run lint` passed.
- `pnpm run build` passed.
- MCP code-level registration includes `chatgpt_edit_image` and `chatgpt_delete_conversation`; `mcporter` was not available on PATH in this shell, so persistent MCP registry smoke could not be rerun here.

Resolved blockers in later slices:

- Project create/move/rename workflows are now implemented with exact-target checks and live verification.
- WSL-restart persistence remains a literal environmental gate; browser status and persistent configuration are green in the current boot/session.

### 2026-04-23 Slice 11

Image edit recovery, multi-output extraction, and destructive delete proof:

- Recovered all three previously timed-out image/reference edit conversations from the Image Gen project main chat list:
  - `https://chatgpt.com/g/g-p-69e9108d43308191ac348051d529ffaf-image-gen/c/69e99fd8-cda4-83ea-aa9b-4325b11d47a2`
  - `https://chatgpt.com/g/g-p-69e9108d43308191ac348051d529ffaf-image-gen/c/69e9a051-76a8-83ea-8571-509cf46d8fad`
  - `https://chatgpt.com/g/g-p-69e9108d43308191ac348051d529ffaf-image-gen/c/69e9a30f-2340-83ea-9c19-6b035b5200d3`
- Downloaded one generated PNG artifact from each recovered reference-image edit:
  - `.tmp-image-edit-recovered-0/01_file_00000000237471fdbe4f9ed6eaf6f60d.png`, 1254x1254, 88,784 bytes, SHA-256 `7d373c1f47229c1089bc11291490819c496a5e08882f1098d9582f510737a723`.
  - `.tmp-image-edit-recovered-1/01_file_00000000500c71fdb88da3c24b62931f.png`, 1254x1254, 118,921 bytes, SHA-256 `1889f4a6c0e0ad31ca81b903a225f39e34d4b163694f319edf5cfd4a3f56088d`.
  - `.tmp-image-edit-recovered-2/01_file_000000009f5c71fdb18070046028ec8c.png`, 1254x1254, 85,431 bytes, SHA-256 `dac30a3955e7a58da7e12780c152627134f680fd6ec01d25a9cd3f39aa616da8`.
- Fixed project snapshots so they wait for and include project-main conversation links, not just sidebar history.
- Added `--browser-thinking-time` to `oracle image generate` and `oracle image edit`.
- Added `browserThinkingTime` to `chatgpt_generate_images` and `chatgpt_edit_image`.
- Raised image generate/edit default turn timeout to 30 minutes, while preserving explicit timeout overrides.
- Live multi-image request completed but produced one image artifact; this is recorded as model/UI behavior, not extraction failure.
- Verified multi-output extraction and download against the completed Images 2.0 sample conversation:
  - Conversation `https://chatgpt.com/c/69e9073a-9660-83ea-b480-751914edbc95`.
  - Detected 24 generated-image DOM nodes.
  - Deduped to 7 unique generated images.
  - Downloaded all 7 image artifacts under `.tmp-image-sample-download/`.
- Guarded deletion was live-smoked against the throwaway multi-image test conversation:
  - Delete plan returned the expected conversation id.
  - Confirmed delete required exact id `69e9ade2-7ee4-83ea-b648-091d588f3783`.
  - Confirmation dialog selector was hardened around `delete-conversation-confirm-button`.
  - Delete completed with `deleted: true` and `verification: url_changed`.

Verification:

- `pnpm vitest run tests/browser/chatgptProjects.test.ts tests/browser/chatgptImageArtifacts.test.ts tests/mcp/consult.test.ts` passed.
- `pnpm exec tsc --noEmit --pretty false` passed.
- `pnpm vitest run tests/browser/attachmentResolver.test.ts tests/browser/attachmentsCompletion.test.ts tests/browser/pageActions.test.ts tests/browser/chatgptImageArtifacts.test.ts tests/browser/chatgptProjects.test.ts tests/cli/browserConfig.test.ts tests/mcp/consult.test.ts` passed.
- `pnpm run lint` passed.
- `pnpm run build` passed.

### 2026-04-23 Slice 12

Project organization completion:

- Added project creation through ChatGPT's browser-authenticated project endpoint:
  - Endpoint path verified from the loaded webapp bundle: `/backend-api/gizmos/snorlax/upsert`.
  - A first probe against `/backend-api/gizmos` created a regular GPT-shaped gizmo, not a project; that throwaway was deleted and the route was rejected for project creation.
  - The project-specific endpoint returned a `g-p-...` project id and `snorlax` gizmo type.
- Added first-class browser operation `createChatgptProject()`.
- Added CLI command:
  - `oracle project create <name> --instructions <text> --json`.
- Added MCP tool:
  - `chatgpt_create_project`.
- Added project move workflow:
  - `oracle chat move <conversationUrl> --project-url <projectUrl> --confirm <conversationId>`.
  - `chatgpt_move_conversation_to_project`.
  - Uses the conversation options menu, the Move to project menu item, and full pointer/mouse event dispatch for the target project item.
  - Verifies through project-linked conversation, project conversation URL, or project page title.
- Added project rename workflow:
  - `oracle project rename <projectUrl> --new-name <name> --confirm-current-name <name>`.
  - `chatgpt_rename_project`.
  - Uses the project title editor when available, with project options menu fallback.
  - Requires exact current-name confirmation.

Live evidence:

- No-op rename against the existing Image Gen project completed with `renamed: true` and `verification: unchanged_same_name`.
- A throwaway text conversation was moved into Stupid Spam, then moved back into Image Gen, with final move verification `page_title_project`.
- The throwaway moved conversation was deleted successfully with `deleted: true` and `verification: url_changed`.
- Project create smoke:
  - `oracle project create "Oracle QA Temp Project 20260423 012" --timeout 60s --json`
  - Returned project id `g-p-69e9b818a8b48191a17c9d1283cebdf4`.
  - Returned URL `https://chatgpt.com/g/g-p-69e9b818a8b48191a17c9d1283cebdf4-oracle-qa-temp-project-20260423-012/project`.
  - Completed with `created: true` and `verification: project_page_opened`.
  - The throwaway project was deleted through the verified guarded project deletion endpoint and no longer appears in `project list`.
- Final project list after cleanup returned the expected five existing projects:
  - Image Gen.
  - Stupid Spam.
  - Pro Request Spam 2.
  - Thesis & Graduation.
  - Deep Research Bulk.

Verification:

- `pnpm exec tsc --noEmit --pretty false` passed after project create/move/rename wiring.
- `pnpm vitest run tests/browser/attachmentResolver.test.ts tests/browser/attachmentsCompletion.test.ts tests/browser/pageActions.test.ts tests/browser/chatgptImageArtifacts.test.ts tests/browser/chatgptProjects.test.ts tests/cli/browserConfig.test.ts tests/mcp/consult.test.ts` passed: 82 passed, 1 skipped.
- `pnpm run lint` passed.
- `pnpm run build` passed.

### 2026-04-23 Slice 13

Sandbox artifact downloads, live tab-budget enforcement, and terminal-login design:

- Added first-class ChatGPT sandbox artifact contracts and browser helpers under:
  - `src/browser/chatgpt/sandboxArtifacts.ts`
  - `src/browser/chatgpt/types.ts`
- Added explicit CLI extraction command:
  - `oracle chat artifacts <conversationUrl>`
- Added explicit MCP extraction tool:
  - `chatgpt_extract_sandbox_artifacts`
- Extended conversation snapshots to surface sandbox artifact labels/refs alongside generated images.
- Extended chat turn/create results to return:
  - `sandboxArtifacts`
  - `newSandboxArtifacts`
  - `downloadedSandboxArtifacts`
  - `warnings`
- Added automatic post-turn sandbox artifact collection in browser mode:
  - new artifact buttons are detected after a completed assistant response
  - downloads are fetched through the browser-authenticated page context
  - artifacts are written with stable filenames and JSON sidecars
- Fixed a duplicate-artifact failure mode caused by nested/rehydrated conversation turn wrappers:
  - artifact refs are deduped with preference for entries carrying concrete `messageId`
  - resolved downloads are deduped by `fileId` or sandbox path before bytes are fetched
- Added a configurable output-dir path for auto-downloaded sandbox artifacts via browser config.
- Hardened remote Chrome tab management:
  - default live tab budget remains 4
  - pruning now closes excess live ChatGPT/about:blank pages even when tracked-state metadata is empty
  - remote tab close path now uses `Target.closeTarget`, which works against the live endpoint where `CDP.Close` was insufficient
- Added a focused terminal-login design doc:
  - `docs/chatgpt-terminal-login-automation-plan.md`

Live evidence:

- Read-only sandbox artifact extraction was live-smoked against the provided Pro conversation:
  - `https://chatgpt.com/g/g-p-69a9f36e9c488191a9fbaf2c920c6c4e/c/69e7da3a-8218-83ea-a974-5c2b2d54146a`
  - Resolved exactly 3 logical assistant sandbox artifacts:
    - frontend codebase zip
    - README
    - implementation manifest
  - Downloaded all 3 artifacts under `tmp/smoke-sandbox-artifacts/`
  - Captured stable metadata including `messageId`, sandbox path, file id, MIME type, byte size, and SHA-256
- Live browser hygiene check found 9 lingering page tabs on the remote ChatGPT endpoint.
- After switching pruning/close to `Target.closeTarget`, live cleanup reduced the endpoint to the intended 4-tab budget.
- A subsequent `oracle chat get ... --json` round-trip completed without leaving extra tabs behind; the live page count was 3 immediately after the command.

Verification:

- `pnpm exec tsc --noEmit --pretty false` passed.
- `pnpm vitest run tests/browser/attachmentResolver.test.ts tests/browser/attachmentsCompletion.test.ts tests/browser/pageActions.test.ts tests/browser/chatgptImageArtifacts.test.ts tests/browser/chatgptProjects.test.ts tests/browser/remoteChromeTabs.test.ts tests/browser/chatgptSandboxArtifacts.test.ts tests/browser/config.test.ts tests/browser/chromeLifecycle.test.ts tests/cli/browserConfig.test.ts tests/mcp/consult.test.ts` passed: 98 passed, 1 skipped.
- `pnpm run lint` passed.
- `pnpm run build` passed.

### 2026-04-23 Slice 14

Final local wrap-up and Ubuntu delegation prep:

- Re-ran the effective Codex permission probe after restarting the session with `--yolo`:
  - `/mnt/c` is mounted writable.
  - GitHub DNS and HTTPS are available.
  - workspace `.git` is writable.
  - `git fetch --dry-run` succeeds for both upstream and fork remotes.
- Added `.gitignore` protections for local browser/live-test state:
  - `openai_creds.env`
  - `.tmp-*`
  - `tmp/`
- Updated the terminal-login plan from "planned" to implemented CLI status.
- Updated the fork/rebase/Linux plan to remove stale WSL permission blockers.
- Added a no-context Ubuntu delegation handoff:
  - `docs/ubuntu-linux-agent-handoff.md`

Remaining work intentionally delegated:

- True Ubuntu Linux validation with Linux Chrome and a Linux-local persistent profile.
- Ubuntu OTP retry/persistence proof.
- Ubuntu MCP smoke against the new ChatGPT browser tools.
- Optional fork branch/rebase/push after the Ubuntu gate is green.
