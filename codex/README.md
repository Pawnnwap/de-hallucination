# de-hallucination for Codex — hooks, a CLI, and optional MCP

A Codex port of the same anti-hallucination mechanisms as the
[pi extension](../pi/README.md). It uses Codex lifecycle hooks for everything that must happen
around a turn, and a tiny Node CLI for the two model-callable tools. There is no Codex fork,
no build step and no npm dependency.

```
user prompt ──► ① UserPromptSubmit hook: jev format router
                │
Codex turn ────► tools (Bash / apply_patch / …)
                │  PreToolUse: allocate bash1/edit1/…
                │  PostToolUse: record {vars} + inject the [vars: …] hint
                ▼
Stop hook ─────► ② closing round (binary / choice / score)
                ③ format checker (JSON / YAML / CSV / code)
                ④ verification guard
                ⑤ template render notice (+ optional corrective re-emission)
```

## Mechanisms

### 1. Verbatim quoting via `{var}` templates

`PreToolUse` assigns a stable prefix to each call (`bash1`, `edit2`, …). `PostToolUse` records
the important values from `tool_input`/`tool_response` and injects a hint:

```
[vars: bash1_cmd bash1_out] — quote these as {name} placeholders in your final reply
```

The model is instructed to write the placeholder instead of retyping the fact. Large blobs
are quoted once and referenced by line/field, not pasted repeatedly. The `Stop` hook renders
every known placeholder to the exact recorded value and posts the rendered reply in a hook
notice. Unknown braces pass through byte-identical, so code is safe. Values are capped by
`DH_MAX_VAR_CHARS`.

Codex hooks cannot rewrite the final assistant message in place. The default is a **notice**
(the rendered reply is shown in the TUI hook cell). Set `DH_CODEX_RENDER=block` to have the
`Stop` hook request one corrective re-emission with the rendered text; the corrected answer
is then a new assistant message. Headless `codex exec --json` does not print hook notices.

### 2. Format router and closing round

`UserPromptSubmit` classifies the request with jev into
`chat / doc / code / json / yaml / csv / choice / score / binary` (same router preamble as
the pi version). The `Stop` hook renders placeholders first, then runs the closing round,
format checker and guard on the **rendered** text — the same text the user sees. For
`binary / choice / score`, it runs a closing round on `[request, final answer]` and posts
the calibrated verdict in the hook notice. For `code / json / yaml / csv`, it validates the
rendered deliverable deterministically: if invalid (including a placeholder whose value
breaks the payload), it blocks the stop once with a precise correction prompt; the model
re-emits, and the next `Stop` accepts the corrected payload. Formatting only — facts never
change.

### 3. Decision and news tools

Two transports are available:

| transport | how the model calls it | when to use |
|---|---|---|
| **CLI (default)** | `node codex/cli.cjs news-search …` / `jev-decide …` through the shell | works with every provider, including fleet/Qwen |
| **MCP (optional)** | `news_search` / `jev_decide` MCP tools | providers that support Responses API namespace tools |

Codex sends MCP tools as `namespace` tools. Fleet's OpenAI-compatible endpoint drops that
tool type, so the model never sees the MCP functions (verified with Codex 0.163.0 + fleet
`chat`). The default policy therefore uses the CLI; the MCP server remains available for
providers that support namespaces. `DH_CODEX_TOOLS=cli|mcp|both` selects the policy.

The news command returns the same records as the pi extension: local corpus (`DH_NEWS_DIR`,
or `news/` / `pi/bench/fixtures/news`) or live HN via Algolia (`DH_NEWS_LIVE=1`). It ends
with a `DEHALL_VARS` line that the `PostToolUse` hook turns into `{news…}` placeholders.

### 4. Verification guard

When the final reply claims success while the last recorded Bash output looks like an error,
the `Stop` hook appends a warning with the recorded error tail. Codex's hook payload gives
Bash output as text (not an exit code), so the guard uses error patterns; if a structured
`exit_code` is present it is used too. Search-class commands (`grep`, `diff`, `test`, …) are
not treated as failures just because of a nonzero exit.

All mechanisms fail open: jev unreachable ⇒ `chat` route and no verdict; a hook error ⇒
empty output; a missing CLI/state ⇒ Codex behaves normally.

## Install

Requirements: Codex CLI with hooks (tested with **0.163.0**), Node 20+ (tested with 24),
and jev running separately (local adapter on `:8090` by default).

### Project scope (recommended, least intrusive)

```bash
node codex/install.cjs /path/to/your/project
```

This writes `<project>/.codex/hooks.json` and nothing else. Codex loads project hooks only
for trusted projects, so approve the project/hook review prompt once. For non-interactive
runs in an already-trusted project:

```bash
codex exec --dangerously-bypass-hook-trust ...
```

If you cannot trust the project (for example a shared checkout), use `--user` instead.

### User scope

```bash
node codex/install.cjs --user
```

This merges the hook groups into `$CODEX_HOME/hooks.json` (or `~/.codex/hooks.json`) and
leaves existing hooks untouched. Existing files are backed up as `*.bak-dehall`.

### Optional MCP transport

```bash
node codex/install.cjs --mcp /path/to/your/project
```

This also appends `[mcp_servers.dehall]` to `.codex/config.toml`. Then set
`DH_CODEX_TOOLS=both` (or `mcp`) in the environment that launches Codex. The hooks inherit
that environment and change the policy. Use this only when your provider preserves
`namespace` tools.

Example config: [config.example.toml](config.example.toml). Example hooks:
[hooks.example.json](hooks.example.json).

## Fleet / local provider notes

The local Codex config (`~/.codex/config.toml`) is functional with:

```toml
model = "chat"
model_provider = "fleet"
model_context_window = 262144
[model_providers.fleet]
base_url = "http://<fleet-host>:9000/v1"
wire_api = "responses"
```

Fleet serves an OpenAI-shaped `/v1/models`; Codex expects its own catalog schema and logs:

```
failed to refresh available models: ... failed to decode models response
Model metadata for `chat` not found. Defaulting to fallback metadata
```

That is cosmetic: turns work, and `model_context_window` is pinned. If you want clean
metadata, generate a Codex-format model catalog for your own Codex version and point
`model_catalog_json` at it in a dedicated profile (for example
`~/.codex/fleet.config.toml` with `codex -p fleet`). Catalog files are version-specific, so
this repository does not ship one. The hooks, CLI and news search do not need it.

## Configuration

| var | default | meaning |
|---|---|---|
| `DH_JEV_URL` | `http://127.0.0.1:8090` | jev base URL (hosted: `https://api.typesafe.ai`) |
| `DH_JEV_KEY` | empty | bearer token for jev |
| `DH_JEV_MODEL` | empty | `model` field sent with every jev request |
| `DH_JEV_TIMEOUT_MS` | `20000` | jev timeout (closing round uses 3×) |
| `DH_NEWS_DIR` | corpus discovery | local news corpus directory |
| `DH_NEWS_LIVE` | off | `=1` searches live HN via Algolia |
| `DH_CODEX_TOOLS` | `cli` | `cli`, `mcp`, or `both` tool policy |
| `DH_CODEX_RENDER` | `notice` | `notice`, `block` (one corrective re-emission), or `off` |
| `DH_CODEX_CHECK_RETRIES` | `1` | max Stop-block correction attempts for invalid deliverables (0–2) |
| `DH_MAX_VAR_CHARS` | `8192` | per-variable value cap |
| `DH_MAX_NOTICE_CHARS` | `12000` | rendered-notice cap |
| `DH_CODEX_STATE_DIR` | `%TEMP%/dehall-codex` | hook state (vars, route, counters) |
| `DH_DEBUG` | off | `=1` for `[dehall] …` logs on stderr |
| `DH_DISABLE_ROUTER/_TEMPLATES/_CLOSER/_CHECKER/_DECIDE` | off | `=1` disables one mechanism |

The state file is per Codex session and is safe to delete; `SessionStart` cleans entries older
than 7 days.

## Tests

```bash
node codex/smoke/units.cjs
```

Covers template rendering, JSON/YAML/CSV/code validation, choice extraction, the verification
guard, Bash/apply_patch variable capture, state round-trips, local news search, the CLI, the
full hook pipeline (including a Bash CLI news result rendered at `Stop`), the Stop-block
checker retry, and the MCP handshake/tool call. All checks are deterministic and need no LLM.

Manual end-to-end checks used during development:

```bash
# real Codex turn through fleet, project-scoped hooks
CODEX_HOME=<isolated-home> DH_CODEX_STATE_DIR=<state> \
  codex exec --strict-config --skip-git-repo-check \
  --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox \
  --json "Run exactly: echo hello-dehall. Report the exact output."
```

A successful run shows the model writing `{bash1_cmd}` / `{bash1_out}` and a state file with
`vars.bash1_cmd` and `vars.bash1_out`.

## Known behavior / limitations

- **No in-place final rewrite.** Codex has no message-rewrite hook; rendered facts and the
  JEV verdict arrive as a TUI hook notice. `codex exec --json` omits hook notices; the model
  may still print literal `{placeholders}` in headless output.
- **Checker corrections cost a turn.** The `Stop` block makes Codex continue the model once
  with a correction prompt. The original answer remains above the corrected one. The checker
  validates the rendered payload, so a value containing quotes/newlines can invalidate JSON
  or YAML after substitution and trigger a correction; structured payloads should use the
  literal exact values rather than placeholders.
- **MCP namespace tools.** Fleet/Qwen ignores them; use the default CLI transport, or a
  provider that supports Codex's `namespace` tool type.
- **Exit codes.** Codex hook payloads expose Bash output as a string; the guard uses error
  patterns rather than a per-command exit code.
- **Router is text-only.** Option wording materially affects routing quality.
- **Headless stdin.** `codex exec` reads stdin when it is not a terminal; redirect it
  (`< /dev/null`) in scripts.
