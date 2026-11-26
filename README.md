# cLogs

A live network recorder for Claude Code, for macOS, Windows and Linux. It works like the Network panel in DevTools: press **Record**, use Claude Code in as many terminals as you like, and every request shows up grouped by chat session. That includes Anthropic API calls with full payloads, responses, token usage and timing, plus web fetches, web searches, MCP tool calls and `curl`/`wget` commands. **Stop**, **Clear**, and **Import / Export HAR** work as you'd expect.

There's no proxy, no certificates and no setup. It reads the transcripts Claude Code already writes to disk.

- **Live only.** Recording starts when the app opens. Only requests that start while recording is on are listed; earlier history is never shown.
- **Several accounts.** Each Claude config folder (for example `~/.claude` and `~/.claude-personal`) is an account. Sessions carry an account badge, the sidebar can filter by account, and **Folders** lets you switch recording on or off per account or add another config folder.
- **HAR.** Export everything captured, or a single session, as HAR 1.2. Request and response bodies sit in the standard fields, so the file also opens in Chrome DevTools. App-specific details are stored under `_clogs` (older files using `_claudeCodeCalls` still import), so importing one of its own HARs restores the full view. HARs from other tools are shown generically.

Shortcuts: Cmd/Ctrl+E start/stop · Cmd/Ctrl+K clear · Cmd/Ctrl+O import · Cmd/Ctrl+S export · ↑/↓ move through requests · Esc close the detail pane.

## Download

Get it from the website (it picks the right file for your OS): **https://shubhdeep12.github.io/clogs/**. Or grab a build directly from the repository's **Releases** page:

| OS | File |
|----|------|
| macOS (Apple Silicon) | `clogs-<version>-mac-arm64.dmg` |
| macOS (Intel) | `clogs-<version>-mac-x64.dmg` |
| Windows | `clogs-<version>-win-x64-setup.exe` (installer) or `…-portable.exe` |
| Linux | `clogs-<version>-linux-x86_64.AppImage` or `.tar.gz` |

`SHA256SUMS.txt` on each release lists the checksums.

The builds are not code-signed, so the first launch needs one extra step:

- **macOS:** open the app once, then go to **System Settings → Privacy & Security** and click **Open Anyway** (on macOS 14 and earlier, right-click the app → **Open** also works). Or run `xattr -dr com.apple.quarantine "/Applications/cLogs.app"`.
- **Windows:** SmartScreen shows "Windows protected your PC". Click **More info** → **Run anyway**.
- **Linux:** run `chmod +x clogs-*.AppImage`, then launch it. Some distros need `libfuse2` for AppImages.

## Run from source

```sh
npm install
npm start
npm test        # unit tests on a synthetic transcript
npm run verify  # parse every local session, print counts only
```

## Build installers

```sh
npm run dist:mac     # .dmg + .zip, arm64 and x64
npm run dist:win     # NSIS installer + portable .exe, x64
npm run dist:linux   # AppImage + .tar.gz, x64
npm run icon         # re-render build/icon.png from build/icon.svg
```

Build each platform on that platform. The output goes to `dist/`.

## Releases (GitHub Actions)

- `.github/workflows/ci.yml` runs syntax checks and unit tests on Linux, macOS and Windows for every push and pull request.
- `.github/workflows/release.yml` builds all three platforms. To publish a release, bump `version` in `package.json`, commit, then:

  ```sh
  git tag v0.1.0
  git push origin v0.1.0
  ```

  The workflow checks that the tag matches `package.json`, runs the tests, builds the installers, and publishes a GitHub Release with the files, checksums and generated notes. Running the workflow by hand (**Actions → Release → Run workflow**) builds the installers as downloadable run artifacts without publishing a release.
- **Code signing is optional.** To sign, add electron-builder's signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarization) and remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"` from the workflow.

## Website

The download page lives in `site/`. It's [Astro](https://astro.build): static HTML with self-hosted fonts and one small script that reads the latest GitHub Release and points the download button at the right file for the visitor's OS.

```sh
cd site && npm install && npm run dev
```

`.github/workflows/site.yml` deploys it to GitHub Pages on every push to `main` that touches `site/`. One-time setup: **Settings → Pages → Source: GitHub Actions**.

To serve it from a custom domain such as `clogs.okshubh.in`:
1. Add the domain under **Settings → Pages → Custom domain**.
2. Create a DNS `CNAME` record from `clogs` to `shubhdeep12.github.io`.
3. Re-run the Site workflow.

The base path and canonical URLs adjust automatically.

## Where the data comes from

Claude Code writes one JSONL transcript per session:

```
<config dir>/projects/<project>/<session-id>.jsonl
<config dir>/projects/<project>/<session-id>/subagents/agent-*.jsonl   (+ .meta.json)
```

The app finds config folders automatically: `~/.claude`, `~/.claude-*`, `~/.config/claude` and `$CLAUDE_CONFIG_DIR`. You can add others with the **Folders** button. While recording, it watches each folder's `projects/` directory (recursive `fs.watch`, plus a 1-second poll as a fallback). Any session whose transcript changes is parsed in full, because request bodies are delta-encoded against earlier requests, but only calls that start inside a recording window are listed.

From Claude Code **2.1.300** on, each Messages API call is recorded in the transcript:

| Entry               | Holds                                                                            |
|---------------------|----------------------------------------------------------------------------------|
| `api-request`       | params (model, betas, max_tokens, thinking, …), `base` + `keep` + `tail` deltas, cache-control paths |
| `api-request-shape` | `system` and `tools`, stored once per shape hash                                 |
| `api-request-blob`  | a wire message, stored once per hash                                             |
| `assistant`         | response content blocks, `requestRef` → request id, `requestId`, `usage`         |

The request body is rebuilt as
`messages(req) = messages(req.base)[0:keep] ++ resolve(req.tail)`.
Each tail entry is `sha256(canonical JSON of the message)`. Messages missing from the blob table are matched by hashing candidates rebuilt from transcript entries: an assistant turn's merged blocks, or a run of user entries merged into one message (parallel tool results). On the author's machine, 99.7% of messages resolve. The rest are shown as placeholders.

`npm run verify` parses every local session and prints the resolution rate. It prints counts only, never transcript content.

## What it can't show

- **Raw HTTP.** Auth headers, client headers and HTTP status codes of successful calls aren't in the transcript. The Headers tab marks which fields are reconstructed (`anthropic-beta` comes from the recorded betas, `anthropic-version` is the SDK default) and which are recorded (`request-id`).
- **Traffic Claude Code doesn't write to the transcript.** That includes telemetry, feature flags, OAuth, update checks and `count_tokens`.
- **Claude Code before 2.1.300.** These versions didn't record request payloads; the app shows responses, usage and timing only.
- **Exact network timing.** Timing comes from when each response block was written, not from network events.
- **Format stability.** The transcript format is internal to Claude Code and may change between versions.

## Privacy

Everything stays on this machine. The app only reads Claude's folders, never writes to them, and makes no network requests. Captured data lives in memory until you export it. Transcripts contain your prompts, code and tool output, so be careful when sharing screenshots or copied payloads.

## Layout

```
main.js            Electron main: window, IPC, file watching
preload.js         contextBridge API (renderer is sandboxed, no Node)
src/discover.js    config-folder (account) discovery
src/recorder.js    live recorder: watching, recording windows, start/stop/clear
src/transcript.js  incremental JSONL parser + request reconstruction
src/session.js     main + subagent transcripts → request list and details
src/har.js         HAR 1.2 export / import
src/smoke.js       self-test: `npm run smoke -- <outDir> [session] [hours-back]`
renderer/          UI (plain HTML/CSS/JS, no build step)
build/icon.svg     app icon source (build/icon.png is rendered from it)
scripts/           verify, smoke runner, icon renderer
site/              download page (Astro), deployed to GitHub Pages
test/              unit tests (node:test) + synthetic transcript fixture
.github/workflows/ CI and release pipelines
```
