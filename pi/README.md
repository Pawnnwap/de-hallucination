# de-hallucination for pi — routes, quotes and decides via jev

> This is the pi implementation. The Codex implementation lives in
> [`../codex`](../codex/README.md); the repository overview is in [`../README.md`](../README.md).
> All commands below run from the repository root.

A single [pi](https://github.com/earendil-works/pi) extension (TypeScript, no build step, no
fork) that adds four anti-hallucination mechanisms to a normal coding agent. Classification
and decision calls go to a **[Jev](https://docs.typesafe.ai)-compatible** calibrated decision
service — local or hosted; the main model can be anything pi supports.

```
user request ──► ① jev format router ──► pi agent loop (normal tools) ──► final message pipeline
                  chat / doc            read bash edit grep find ls       ②③ render + close + check
                  code / json / yaml / csv                                 │
                  choice / score / binary                                  ▼
                                                                        user sees:
                  ┌─────────────────────────────────────────────────── exact-quoted text
                  │ ① router: one jev choice question per request      (+ JEV verdict block
                  │ ② templates: {var} placeholders rendered            when binary/choice/score)
                  │ ③ jev_decide tool: calibrated decisions
```

## Mechanisms

### 1. Verbatim quoting via `{var}` templates

Every tool call records template variables with deterministic names:

| tool | variables |
|---|---|
| `read` | `read{N}_path`, `read{N}_content` |
| `bash` | `bash{N}_cmd`, `bash{N}_out`, `bash{N}_exit` |
| `edit` | `edit{N}_path`, `edit{N}_diff` |
| `write` | `write{N}_path`, `write{N}_content` |
| `grep` / `find` / `ls` | `{tool}{N}_pattern` / `{tool}{N}_path`, `{tool}{N}_out` |

A per-request policy plus a `[vars: …]` hint on each tool result tell the model to quote
those facts as `{varname}` instead of retyping them. Large blobs are quoted once and
referenced by line/field, not pasted repeatedly. The final message is rendered by exact
substitution (f-string semantics). **Only known names are substituted** — every other brace
passes through byte-identical, so code blocks cannot be corrupted. Values are capped at
`DH_MAX_VAR_CHARS` with an explicit truncation marker.

### 2. Format router, closing round, format checker

Each request is classified by jev (one `choice` question, ~1 s) into `chat / doc / code /
json / yaml / csv / choice / score / binary`. A hard-injected routing preamble lifted router
accuracy on 18 labeled prompts from 14/18 @ 0.762 to **17/18 @ 0.907**
(`python pi/bench/router_eval.py` reproduces both). Then:

- **binary / choice / score** — after the model finishes, jev runs a **closing round** on
  `[request, final output sans thinking]`: `noul` for yes/no, extracted alternatives for
  choice (falling back to `/v1/systemone/auto`), a 5-level `score` question otherwise. The
  verdict is appended as a marked block with top-3 probabilities; the model's analysis stays
  as evidence.
- **code / json / yaml / csv** — deterministic validators first (JSON.parse for objects *and*
  arrays, JSON-in-prose extraction, YAML/CSV heuristics, code-fence balance). Only when
  invalid: one nested LLM call re-emits the payload strictly, re-validated, ≤2 retries.
  Formatting changes, facts never do.
- **chat / doc** — template rendering only.

### 3. `jev_decide` tool

`jev_decide(context, choices[])` returns the argmax choice, a probability for every choice,
and a confidence — instead of a guess in prose. If jev is unreachable the tool throws and the
model decides itself.

### 4. `news_search` tool

`news_search(query, limit?, hours?)` searches a local corpus (`DH_NEWS_DIR`, or `news/` /
`bench/fixtures/news/`) or live HN via Algolia (`DH_NEWS_LIVE=1`). Results are registered as
`{news…}` variables so quoted facts render byte-exact. Comparison questions ("which happened
later?") route to `choice` and get a JEV verdict over the extracted alternatives. A dead live
backend falls back to the local corpus.

### 5. What the extension costs the remote model's prompt cache

The remote model caches the *prefix* of the prompt, so anything the extension adds to the
prompt is paid on every request of the session. Measured with `pi/bench/cache_probe.py`
against an OpenAI-compatible backend: with the extension on, the first request is **2.5 kB
larger** than stock pi (the policy section ~1 kB + the two tool schemas ~1.5 kB), and every
later request is the same size plus the `[vars: …]` trailers.

Two decisions keep that overhead from touching the cached prefix:

- **The policy travels as a prompt *section*, not as a forced system prompt.** `before_agent_start`
  also accepts `systemPrompt`, but that path replaces the whole prompt for the run: pi then
  projects the forced text onto every request of the run and drops the transcript's own system
  messages from the request, so the bytes on the wire can drift from the session — and from
  the prefix the remote model already cached. Changing a section is pi's documented
  alternative: pi records the change as a transcript delta and renders every request from the
  same sections, so the prompt stays byte-stable across turns. The section is installed on
  *every* run, including custom-triggered ones, because pi's section diff would otherwise
  strip it from the transcript.
- **The tools block is the most-cached region of the prompt**, so the tool schemas are kept
  short, and `DH_DISABLE_NEWS=1` drops the news tool's schema from it entirely.

The `[vars: …]` trailer on each tool result is the one part that grows with the session; it
carries the variable names only, and it is what lets the model quote a recorded value instead
of retyping it (the rendered answer stays out of the prompt — pi's `message_end` replacement
reaches the session file and the TUI, not the next turn's model context).

## Everything fails open

jev unreachable ⇒ router defaults to `chat`, closer/checker skip, `jev_decide` errors loudly.
pi behaves exactly like stock pi; the smoke matrix verifies it.

## Setup

```bash
npm i -g @earendil-works/pi-coding-agent        # tested with 1.3.0

# jev runs separately (llama-server :8091 + adapter :8090); start it, then:
pi --extension ./pi/index.ts --model spark-local/Spark-X2.5-4B            # interactive
pi --extension ./pi/index.ts --model spark-local/Spark-X2.5-4B -p "..."  # headless
```

### Jev compatibility

The extension speaks the public **Jev wire format**: `POST /v1/systemone` with `noul` /
`choice` / `score` questions and typed answers. The decision service does not have to be
local. Only the format checker's nested re-emission needs an OpenAI-compatible engine
(`/v1/chat/completions`); with a hosted jev and no local engine it simply skips repairs.

| backend | configuration |
|---|---|
| local adapter (default) | `DH_JEV_URL=http://127.0.0.1:8090` — any llm2jev-compatible server |
| hosted TypeSafe Jev | `DH_JEV_URL=https://api.typesafe.ai`, `DH_JEV_KEY=…`, `DH_JEV_MODEL=jev-latest` |
| your own service | implement `POST /v1/systemone`; `state` may be a string, object or array |

`state` is sent as an array of chat messages, which the spec accepts alongside strings and
objects. `POST /v1/systemone/auto` (option generation when a choice question has no
extractable alternatives) is an llm2jev extension, **not** part of the published spec:
services without it return 404, which the extension treats as "no verdict for this question"
rather than an outage — every other question type keeps working.

Any stronger main model works — the extension never assumes the local one. Verified with the
free `xingchen-agi/xing4.0-29b-a4b:free` via OpenRouter while jev stays local:

```bash
export OPENROUTER_API_KEY=sk-or-...    # keep it in a gitignored .env.local
pi --extension ./pi/index.ts --model "openrouter/xingchen-agi/xing4.0-29b-a4b:free"
PI_MODEL="openrouter/xingchen-agi/xing4.0-29b-a4b:free" bash pi/bench/bench.sh 3
```

Headless runs from a non-TTY context must redirect stdin (`< /dev/null`): pi's `-p` mode
reads stdin when it is not a terminal and otherwise blocks with no output.

### Closing-round gates

A sharp distribution is only worth publishing if the judge read the evidence, so every closing
verdict passes two gates. One failure publishes `**JEV closing decision: ABSTAINED**` with the
distribution instead of a confident number:

- **Flatness floor.** Binary: abstain when `|p - 0.5| < DH_ABSTAIN_MARGIN`. Choice/score: use
  the service's entropy-based `confidence` when present (`< DH_ABSTAIN_CONF`), else a top-p
  mass floor (`< DH_ABSTAIN_TOPP`). The same floor protects the router: a flat classification
  keeps `chat` rather than forcing a format onto the answer.
- **Evidence-ablation twin.** The same frame is re-run with every number in the user request
  masked to `[#]`. If the answer distribution barely moves (total-variation distance
  `< DH_ABLATION_DELTA`), the verdict was reading the answer's own prose and not the evidence,
  so it abstains. Skipped when the request has no numbers to mask.

Measured on a four-way factor question, the judge put 81.9% on the correct option and the
masked twin moved by TV=0.014, so the verdict abstained: an answer that states its conclusion
spoils its own twin. The defaults are deliberately conservative. Lower `DH_ABLATION_DELTA`
(set `DH_DISABLE_ABLATION=1` to disable the gate entirely) to publish more verdicts; raise the
floors to publish fewer. Thresholds are eyeballed off a handful of probes, not fitted.

Prefill cost: masking rewrites the user turn, so the twin diverges from the real frame at
its first byte and can never reuse that run's KV prefix. Each twin message is therefore capped
at `DH_TWIN_STATE_CHARS` (default 4000 characters), which keeps the twin's prefill a fraction
of the closing round it audits. Nothing in the extension rewrites history on the host side
except pi's `message_end` template rendering, which rewrites the newest assistant message only
(the Codex port posts a notice instead and leaves the transcript bytes untouched).

### Configuration

| var | default | meaning |
|---|---|---|
| `DH_JEV_URL` | `http://127.0.0.1:8090` | jev base URL (hosted: `https://api.typesafe.ai`) |
| `DH_JEV_KEY` | empty | bearer token sent as `Authorization` (hosted/authenticated services) |
| `DH_JEV_MODEL` | empty | `model` field sent with every request (hosted Jev requires `jev-latest`) |
| `DH_JEV_TIMEOUT_MS` | `20000` | jev timeout (closing round uses 3×, `/auto` ≥60 s; 429/5xx retried once) |
| `DH_SPARK_URL` | `http://127.0.0.1:8091/v1` | OpenAI-compatible engine base |
| `DH_SPARK_MODEL` | `Spark-X2.5-4B` | model id (auto-discovered when the engine is up) |
| `DH_SPARK_CTX` | `16384` | declared context window; pi derives the output budget from it (too small ⇒ `max_completion_tokens=1`) |
| `DH_SPARK_MAX_OUT` | `6144` | max output tokens |
| `DH_SPARK_THINK` | on | `=0` disables native thinking (faster, measured sloppier on a 4B) |
| `DH_MAX_VAR_CHARS` | `8192` | per-variable value cap |
| `DH_ABSTAIN_MARGIN` | `0.10` | binary flatness floor: minimum `\|p-0.5\|` to publish a verdict |
| `DH_ABSTAIN_CONF` | `0.15` | choice/score flatness floor: minimum service-reported `confidence` |
| `DH_ABSTAIN_TOPP` | `0.45` | fallback top-p mass floor; also gates the router (flat classification stays `chat`) |
| `DH_ABLATION_DELTA` | `0.15` | minimum total-variation distance between the real and number-masked verdict distributions |
| `DH_DISABLE_ABLATION` | off | `=1` skips the evidence-ablation twin (publishes verdicts the twin would veto) |
| `DH_TWIN_STATE_CHARS` | `4000` | per-message cap on the masked twin frame, i.e. its prefill cost on the judge |
| `DH_DISABLE_ROUTER/_TEMPLATES/_CLOSER/_CHECKER/_DECIDE` | off | `=1` disables one mechanism (all five = stock pi) |
| `DH_DISABLE_NEWS` | off | `=1` drops the news tool (and its schema) from the request's tools block |
| `DH_DEBUG` | off | `=1` for `[dehall] …` logs on stderr |

## Tests

```bash
node pi/smoke/units.js    # 19 deterministic checks, no LLM: render/strip, JSON extraction,
                          # format checks, verification guard, env parsing, var capture
bash pi/smoke/smoke.sh    # units, then binary/choice/json/templates + fail-open against the stack
python pi/bench/router_eval.py         # router accuracy with/without the preamble
python pi/bench/cache_probe.py --base-url <remote> --api-key <key> --model <provider/model>
                          # what the extension costs the remote model's prompt cache:
                          # prompt bytes, tool-schema size, prefix share per request
```

## Benchmark

```bash
bash pi/bench/bench.sh 3                    # 14 tasks × both arms × 3 runs
bash pi/bench/bench.sh 3 quote_hard fix_bug # task filter
```

Both arms run on the identical stack (same model/temperature; baseline = all five features
off, verified stock behavior). Tasks cover exact quoting among decoys, a 96-char key, a
64-hex sha256, an off-by-one fix verified by running it, strict JSON from CSV, news-search
disambiguation, multi-source synthesis, and a 58k-token needle file.

**Measured on Spark-X2.5-4B (N=3/arm): 17/18 vs 17/18.** The extension ties raw accuracy
while removing stock's two observed failure modes: empty replies from token-cap thinking
loops (bounded continuation) and un-flagged "verified" claims that contradict the recorded
command output (deterministic guard). At 29B both arms hit the ceiling; the value there is
failure-mode insurance, auditable provenance and closing verdicts. Full round-by-round:
[bench/results/summary_20261018.md](bench/results/summary_20261018.md). Concrete
side-by-side transcripts: [EXAMPLES.md](EXAMPLES.md).

## Examples

[EXAMPLES.md](EXAMPLES.md) has three real, measured comparisons: a calibrated closing verdict
vs a bare answer, byte-exact quoting with substitution provenance vs retyping, and a recorded
4B confabulation (a 48-char decoy reported as a 64-hex salt).

## Known behavior / limitations

- **Where replacements land:** pi's `message_end` replacement reaches the session file and the
  live TUI, but the headless `-p` stdout and the next turn's model context keep the model's
  original text. The next turn may therefore contain unreplaced `{placeholders}` — harmless,
  since the next final message is rendered again.
- **Template variables persist for the session:** a placeholder written later resolves to the
  value recorded when its tool ran (f-string semantics).
- **Final analysis sees rendered text:** the closing round, format checker and guard run on
  the rendered final message, so substituted values are judged as the user sees them. A
  checker-repaired deliverable is not rendered a second time.
- **jev failures self-heal:** timeouts/5xx are retried once; after any failure the router and
  closer re-probe once the 15 s cooldown has elapsed instead of staying dark.
- **Search-class exit codes:** the guard ignores a bare nonzero exit for `grep`/`find`/`test`/
  `diff` (exit 1 is their normal answer) and only judges the current turn's `bash` output.
- The choice closer trusts a regex extractor (2–6 short items); otherwise `/auto` generates
  candidates with the same local model. The checker validates payloads, not prose, and for
  code only checks fence balance — it does not compile or lint.
- **Choice extractor is a regex:** widest candidate window over `,` `:` `(` `;`, plus
  colon-introduced lists and `;`/spaced-dash items; 2-6 items survive. Longer lists truncate to
  the last six, the text before the first delimiter counts as prose ("Run it with npm, pnpm,
  yarn, bun or deno" loses `npm`), and a fragment led by a determiner or relative pronoun
  (" - the one that failed monotonicity") counts as commentary, not an option.
- **The ablation twin can be spoiled:** when the answer states its own conclusion, masking the
  numbers in the request barely moves the distribution, so a correct and confident verdict
  abstains (measured: 81.9% on the right option at TV=0.014). Gate thresholds are eyeballed off
  a handful of probes, not fitted.
- jev is text-only and calibrated on single-token answers; option wording materially affects
  routing/decision quality.

## License

MIT — see [LICENSE](LICENSE).
