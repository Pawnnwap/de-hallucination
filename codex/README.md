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
                │  PostToolUse: record {vars} in state (no model-context injection)
                ▼
Stop hook ─────► ② closing round (binary / choice / score)
                ③ format checker (JSON / YAML / CSV / code)
                ④ verification guard
                ⑤ template render notice (+ optional corrective re-emission)
```

## Mechanisms

### 1. Verbatim quoting via `{var}` templates

`PreToolUse` assigns a stable prefix to each call (`bash1`, `edit2`, …). `PostToolUse` records
the important values from `tool_input`/`tool_response` into per-session state (and, for news
results, the returned `[vars: …]` list already rides in the tool output itself). The session
policy documents the deterministic names and offers `node codex/cli.cjs vars-list --last`:

```
- {bash1_out} chars=17 preview="unusual-tokens_XY73"
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
`chat / doc / code / json / yaml / csv / choice / score / binary` (the same user-message-only
frame as the pi version — no preamble). The `Stop` hook renders placeholders first, then runs
the closing round, format checker and guard on the **rendered** text — the same text the user
sees. For
`binary / choice / score`, it runs a closing round on `[request, final answer]` and posts
the calibrated verdict in the hook notice. For `code / json / yaml / csv`, it validates the
rendered deliverable deterministically: if invalid (including a placeholder whose value
breaks the payload), it blocks the stop once with a precise correction prompt; the model
re-emits, and the next `Stop` accepts the corrected payload. Formatting only — facts never
change.

Closing verdicts pass two gates before they are posted. **Flatness floor**: binary abstains
under `|p-0.5| < DH_ABSTAIN_MARGIN`; choice/score use the service's `confidence`
(`< DH_ABSTAIN_CONF`) or a top-p mass floor (`< DH_ABSTAIN_TOPP`), and a flat router result
keeps `chat`. **Evidence-ablation twin**: the frame is re-run with every number in the request
masked to `[#]`; if the two distributions differ by less than `DH_ABLATION_DELTA`
(total variation), the verdict came from the answer's own prose, not the evidence. A verdict
that fails either gate posts `**JEV closing decision: ABSTAINED**` with the distribution.
Measured cost: a four-way factor question where the judge put 81.9% on the correct option
abstained at TV=0.014, because the answer had already stated its conclusion.

Cache cost, measured against the request bytes Codex actually sends. Codex posts the whole
input array on every turn with `store=false` and `prompt_cache_key=<session id>`, so the remote
model's prefix cache is the only cache and the hit rate is the share of the prompt that is
byte-identical to the previous request. The hooks therefore have to add nothing that moves
inside the cached prefix:

- **The `SessionStart` policy is the only permanent addition**: one `developer` item of
  ~1.2 kB at a fixed position (right after the AGENTS.md/environment block), injected once
  per session — never again on resume, which would stack a second copy in the middle of the
  prefix.
- **The per-turn `UserPromptSubmit` reminder is off by default** (`DH_CODEX_TURN_REMINDER=1`
  re-enables it). It was redundant: the session policy already carries the quoting rule and the
  exact CLI commands, so the reminder only re-sent those bytes inside the cached prefix on
  every turn and mutated the prompt once per turn.
- **`PostToolUse` injects nothing into the model context.** Codex transports hook
  `additionalContext` as a mid-conversation `developer` item, and the target chat template
  merges developer messages into the system preamble — appending one re-renders the tokenized
  prompt from the first block, so every cached KV block diverges and every tool-call follow-up
  re-prefills the whole history (measured: 49% vs 94–97% prompt-cache hit under the same load).
  The recorded variable names stay predictable (`bash<N>_cmd`/`bash<N>_out`, one per shell
  call of the session) and the session policy documents them; the model can also run
  `node codex/cli.cjs vars-list --last`, whose output is a normal tool result and keeps the
  prefix append-only.
- **`Stop` returns a `systemMessage`**, which is UI-only and adds no model tokens. The one
  exception is a `decision: "block"`, whose reason *does* enter the model's input and stays
  in the thread for the rest of the session — so the inlined payload is capped at
  `DH_CODEX_RENDER_PAYLOAD` (2 kB) instead of the full expanded reply.
- No hook rewrites earlier transcript bytes, and the judge traffic is local: it never touches
  the remote model's prompt.

The judge side is cache-friendly by construction too: every closing, twin and `jev-decide`
judge frame opens with the same byte-stable system preamble (the router is preamble-free), so
consecutive judge calls reuse the engine's KV prefix; the masked twin leaves that preamble
untouched and only redacts the evidence messages, so it reuses the real closing call's prefix
up to the first redacted digit instead of re-prefilling from scratch (the rest is capped per
message at `DH_TWIN_STATE_CHARS`).

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

This writes the hook tables into `<project>/.codex/config.toml` (`[[hooks.SessionStart]]`,
`[[hooks.UserPromptSubmit]]`, `[[hooks.PreToolUse]]`, `[[hooks.PostToolUse]]`,
`[[hooks.Stop]]`) and nothing else. Codex ≥ 0.163 reads hooks from `config.toml` — a separate
`hooks.json` is the pre-0.163 location and is ignored, so installing into both would run
every hook twice and put the policy and the per-tool trailers into the prompt twice. The
installer replaces only its own hook tables, so re-running it never leaves a second copy.
Codex loads project hooks only for trusted projects, so approve the project/hook review
prompt once. For non-interactive runs in an already-trusted project:

```bash
codex exec --dangerously-bypass-hook-trust ...
```

If you cannot trust the project (for example a shared checkout), use `--user` instead.

### User scope

```bash
node codex/install.cjs --user
```

This merges the hook tables into `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`) and
leaves existing hooks untouched. Existing files are backed up as `*.bak-dehall`.

For a pre-0.163 Codex that still reads `hooks.json`, add `--legacy-json` to write that file
instead (never both).

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
| `DH_CODEX_TURN_REMINDER` | off | `=1` re-sends the per-turn reminder (redundant with the session policy; costs cached-prefix bytes every turn) |
| `DH_CODEX_RENDER_PAYLOAD` | `2000` | max chars of the expanded reply inlined into a `block` reason (the reason enters the model's input and stays in the thread) |
| `DH_CODEX_CHECK_RETRIES` | `1` | max Stop-block correction attempts for invalid deliverables (0–2) |
| `DH_MAX_VAR_CHARS` | `8192` | per-variable value cap |
| `DH_ABSTAIN_MARGIN` | `0.10` | binary flatness floor: minimum `\|p-0.5\|` to publish a verdict |
| `DH_ABSTAIN_CONF` | `0.15` | choice/score flatness floor: minimum service-reported `confidence` |
| `DH_ABSTAIN_TOPP` | `0.45` | fallback top-p mass floor; also gates the router (flat classification stays `chat`) |
| `DH_ABLATION_DELTA` | `0.15` | minimum total-variation distance between the real and number-masked verdict distributions |
| `DH_DISABLE_ABLATION` | off | `=1` skips the evidence-ablation twin (publishes verdicts the twin would veto) |
| `DH_TWIN_STATE_CHARS` | `4000` | per-message cap on the masked twin frame, i.e. its prefill cost on the judge |
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
- **Closing gates are tuned by eye.** Floors and the ablation delta come from a handful of
  probes; the twin is spoiled by any answer that states its own conclusion (correct 81.9%
  verdict, TV=0.014, abstained). `DH_DISABLE_ABLATION=1` turns that gate off.
- **Choice extractor is a regex:** 2-6 items survive; longer lists truncate to the last six,
  the text before the first delimiter counts as prose, and a fragment led by a determiner
  (" - the one that failed monotonicity") counts as commentary.
- **Router is text-only.** Option wording materially affects routing quality.
- **Headless stdin.** `codex exec` reads stdin when it is not a terminal; redirect it
  (`< /dev/null`) in scripts.
