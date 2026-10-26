# de-hallucination

Anti-hallucination mechanisms for normal coding agents, in two host-specific implementations:

| folder | host | integration | status |
|---|---|---|---|
| [`pi/`](pi/README.md) | [pi](https://github.com/earendil-works/pi) | one TypeScript extension | original, benchmarked |
| [`codex/`](codex/README.md) | [Codex](https://github.com/openai/codex) | lifecycle hooks + a zero-dependency CLI (optional MCP) | ported and verified with Codex 0.163.0 |

Both versions share the same idea:

1. **Verbatim quoting** — tool results are recorded as `{var}` templates; the final reply
   uses placeholders instead of retyped facts, so exact values cannot drift.
2. **Format router + closing round** — jev classifies each request; binary/choice/score
   answers get a calibrated closing verdict; JSON/YAML/CSV/code deliverables are validated.
   Every closing verdict also passes a flatness floor and an evidence-ablation gate, and a
   verdict that fails publishes nothing ([gates](pi/README.md#closing-round-gates)).
3. **Verification guard** — a success claim that contradicts the last recorded command
   output is flagged.
4. **Decision and news tools** — calibrated `jev_decide` and corpus/live-HN `news_search`.

Everything fails open: with jev down, the agent behaves like the stock host.

**Remote-model cache cost.** The remote model caches the *prefix* of the prompt, so what a
port adds to the prompt is paid on every request. Both ports were measured against the exact
request bytes they send: pi delivers its policy as a prompt *section* (a transcript delta)
rather than a forced system prompt, and the Codex port injects one session-scoped policy item
and no per-turn reminder. `pi/bench/cache_probe.py` reproduces the measurement.

## Quick start

### pi

```bash
npm i -g @earendil-works/pi-coding-agent
pi --extension ./pi/index.ts --model spark-local/Spark-X2.5-4B
```

See [pi/README.md](pi/README.md) for setup, configuration, benchmarks and measured results.

### Codex

```bash
node codex/install.cjs /path/to/project   # project-scoped hooks (recommended)
# or
node codex/install.cjs --user             # merge into ~/.codex/config.toml
```

The model calls `news-search` / `jev-decide` through `codex/cli.cjs`. On providers that
preserve Responses API `namespace` tools, `--mcp` additionally exposes the same tools over
MCP. See [codex/README.md](codex/README.md) for the hook pipeline, configuration and the
fleet-provider notes.

## Repository layout

```
pi/      pi extension, benchmark, smoke tests, measured transcripts
codex/   Codex hooks, CLI, optional MCP server, smoke tests, fleet catalog
```

Shared fixtures live under `pi/bench/fixtures/`; the Codex news CLI searches them when run
from the repository root (or set `DH_NEWS_DIR`).

## Tests

```bash
node pi/smoke/units.js       # pi helpers, no LLM
node codex/smoke/units.cjs   # Codex hooks/CLI/MCP, no LLM
```

Live smoke/benchmark suites require the local jev/Spark stack:

```bash
bash pi/smoke/smoke.sh
bash pi/bench/bench.sh 3
```

The pi benchmark measured 17/18 vs 17/18 on Spark-X2.5-4B (N=3/arm) while removing two
observed failure modes; details and caveats are in
[pi/bench/results/summary_20261018.md](pi/bench/results/summary_20261018.md) and
[pi/EXAMPLES.md](pi/EXAMPLES.md).

## License

MIT — see [LICENSE](LICENSE).
