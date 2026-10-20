/**
 * de-hallucination — a single pi extension that routes, quotes and decides via jev.
 *
 * Three mechanisms:
 *   1. Verbatim quoting: tool results (paths, command outputs, URLs...) are recorded as
 *      template variables; the model writes {varname} placeholders and the final message
 *      is rendered by substitution, so certain facts can never be retyped wrong.
 *   2. Format router: every user request is first classified by jev (chat / doc / code /
 *      json / yaml / csv / choice / score / binary). binary/choice/score get a jev
 *      closing round appended after the LLM finishes; code/json/yaml/csv get an automatic
 *      format checker; chat/doc pass through untouched.
 *   3. jev_decide tool: the model can delegate any decision among candidates and gets
 *      back a calibrated probability per choice.
 *
 * Everything fails open: with jev or the engine down, pi behaves like stock pi.
 *
 * Config (env):
 *   DH_JEV_URL         jev base URL             (default http://127.0.0.1:8090; hosted:
 *                      https://api.typesafe.ai — the wire format is the public Jev API)
 *   DH_JEV_KEY         bearer token for jev     (default empty; hosted/authenticated only)
 *   DH_JEV_MODEL       "model" field per request (default empty; hosted Jev needs jev-latest)
 *   DH_JEV_TIMEOUT_MS  jev call timeout        (default 20000; auto/closing uses 3x)
 *   DH_SPARK_URL       OpenAI-compatible base for the local engine (default http://127.0.0.1:8091/v1)
 *   DH_SPARK_MODEL     model id                (default Spark-X2.5-4B; auto-discovered otherwise)
 *   DH_SPARK_CTX       declared context window (default 16384 — pi >=1.0 computes the output
 *                      budget as contextWindow - prompt - reserve; its default system prompt
 *                      is ~4-5k tokens, so declaring only the physical 8192 slot clamps the
 *                      budget to max_completion_tokens=1. The engine slot stays 8192; on the
 *                      rare long-session overflow llama-server errors and pi auto-compacts)
 *   DH_SPARK_MAX_OUT   max output tokens       (default 6144; reasoning models can burn
 *                                               thousands of tokens thinking before the answer)
 *   DH_SPARK_KEY       api key sent to engine  (default dummy)
 *   DH_SPARK_THINK     =0 to disable the model's native thinking. On by default: measured,
 *                      thinking-off makes this 4B sloppier (wrong-file attributions,
 *                      invented command outputs) even though it stops the token-cap loops.
 *                      The flake-recovery net below handles the loops instead.
 *   DH_MAX_VAR_CHARS   per-variable cap        (default 8192)
 *   DH_DISABLE_ROUTER / _TEMPLATES / _CLOSER / _CHECKER / _DECIDE =1 disables a feature
 *                      (all five off = stock pi behavior, provider still registered; used
 *                      as the baseline arm of bench/bench.sh)
 *   DH_DEBUG=1         verbose stderr logging
 *
 * Use with:  pi --extension ./pi/index.ts --model spark-local/<model-id>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, promises as fsp } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// config + logging
// ---------------------------------------------------------------------------

const env = (name: string, fallback: string): string => process.env[name] || fallback;
const flag = (name: string): boolean => process.env[name] === "1";
/**
 * Parse an integer env var. A malformed value must fall back with a warning, never
 * become NaN: maxVarChars=NaN makes cap() treat every value as over-long and replace
 * it with the bare truncation marker (silently destroying all template variables);
 * sparkCtx/sparkMaxOut NaN re-breaks the provider's declared context window.
 */
const warnedBadEnv = new Set<string>();
function int(name: string, fallback: number): number {
    const v = process.env[name];
    if (!v) return fallback;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) {
        if (!warnedBadEnv.has(name)) {
            warnedBadEnv.add(name);
            if (process.env.DH_DEBUG === "1") {
                console.error(`[dehall] ${name}="${v}" is not a valid integer — using fallback ${fallback}`);
            }
        }
        return fallback;
    }
    return n;
}
const CFG = {
    jevUrl: env("DH_JEV_URL", "http://127.0.0.1:8090").replace(/\/+$/, ""),
    jevTimeoutMs: int("DH_JEV_TIMEOUT_MS", 20000),
    // Optional auth/model for hosted or authenticated Jev-compatible services. The local
    // adapter ignores both; the hosted API (api.typesafe.ai) requires `model` and a bearer key.
    jevKey: env("DH_JEV_KEY", ""),
    jevModel: env("DH_JEV_MODEL", ""),
    sparkUrl: env("DH_SPARK_URL", "http://127.0.0.1:8091/v1").replace(/\/+$/, ""),
    sparkModel: env("DH_SPARK_MODEL", "Spark-X2.5-4B"),
    sparkCtx: int("DH_SPARK_CTX", 16384),
    sparkMaxOut: int("DH_SPARK_MAX_OUT", 6144),
    sparkKey: env("DH_SPARK_KEY", "sk-local-nokey"),
    // Thinking ON by default (DH_SPARK_THINK=0 disables): thinking-off made this model
    // measurably sloppier even though it stopped the token-cap loops.
    think: process.env.DH_SPARK_THINK !== "0",
    maxVarChars: int("DH_MAX_VAR_CHARS", 8192),
    router: !flag("DH_DISABLE_ROUTER"),
    templates: !flag("DH_DISABLE_TEMPLATES"),
    closer: !flag("DH_DISABLE_CLOSER"),
    checker: !flag("DH_DISABLE_CHECKER"),
    decide: !flag("DH_DISABLE_DECIDE"),
    debug: flag("DH_DEBUG"),
};
const log = (...args: unknown[]): void => {
    if (CFG.debug) console.error("[dehall]", ...args);
};

// ---------------------------------------------------------------------------
// jev client
// ---------------------------------------------------------------------------

class JevUnavailable extends Error {}

/**
 * Connection-level failures mean jev is gone (retrying won't help); timeouts and
 * network-ish errors mean it is busy or cold-starting (one retry is worthwhile).
 */
function jevFailureKind(e: unknown): "down" | "flaky" {
    const msg = String((e as Error)?.message || e);
    return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|fetch failed/i.test(msg) ? "down" : "flaky";
}

async function jevPost(path: string, body: unknown, timeoutMs: number): Promise<any> {
    const post = (): Promise<Response> =>
        fetch(CFG.jevUrl + path, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(CFG.jevKey ? { Authorization: `Bearer ${CFG.jevKey}` } : {}),
            },
            // The hosted Jev API requires `model`; local adapters do not care. Send it only
            // when configured so the default request body stays minimal.
            body: JSON.stringify(
                CFG.jevModel && body && typeof body === "object"
                    ? { ...(body as Record<string, unknown>), model: CFG.jevModel }
                    : body,
            ),
            signal: AbortSignal.timeout(timeoutMs),
        });
    const retryPause = (): Promise<void> => new Promise((r) => setTimeout(r, 500));
    let res: Response;
    try {
        res = await post();
    } catch (e) {
        if (jevFailureKind(e) === "down") {
            throw new JevUnavailable(`jev unreachable at ${CFG.jevUrl}: ${String(e)}`);
        }
        log(`jev ${path} soft failure (${String(e).slice(0, 100)}) — retrying once`);
        await retryPause();
        try {
            res = await post();
        } catch (e2) {
            throw new JevUnavailable(`jev unreachable at ${CFG.jevUrl}: ${String(e2)}`);
        }
    }
    if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        // 5xx, 429 and 529 = jev is up but busy/cold — retry once before failing. Other
        // 4xx are deterministic (bad key, bad body); retrying won't change them.
        if (res.status >= 500 || res.status === 429) {
            log(`jev ${path} -> HTTP ${res.status} — retrying once`);
            await retryPause();
            try {
                res = await post();
            } catch (e2) {
                throw new JevUnavailable(`jev unreachable at ${CFG.jevUrl}: ${String(e2)}`);
            }
            if (!res.ok) {
                const d2 = (await res.text().catch(() => "")).slice(0, 200);
                throw new JevUnavailable(`jev ${path} -> HTTP ${res.status}: ${d2}`);
            }
            return res.json();
        }
        const hint = res.status === 401 || res.status === 403 ? " (check DH_JEV_KEY)" : "";
        throw new JevUnavailable(`jev ${path} -> HTTP ${res.status}: ${detail}${hint}`);
    }
    return res.json();
}

type JevChoice = { key: string; description: string };
type JevDecision = { choice: string; probabilities: Record<string, number>; confidence: number };

/** One calibrated multiple-choice question over caller-declared options. */
async function jevDecide(context: string, choices: JevChoice[]): Promise<JevDecision> {
    if (choices.length < 2 || choices.length > 255) {
        throw new Error(`jev_decide needs 2..255 choices, got ${choices.length}`);
    }
    const criteria: Record<string, string> = {};
    for (const c of choices) criteria[c.key] = c.description;
    const r = await jevPost("/v1/systemone", {
        state: context,
        questions: {
            decision: {
                type: "choice",
                instructions: "Considering the context, which choice is the best decision?",
                criteria,
            },
        },
    }, CFG.jevTimeoutMs);
    const a = r.answers.decision;
    // Normalize: a malformed jev response must degrade to confidence 0 / empty
    // distribution, not crash the caller with NaN.toFixed or Object.entries(undefined).
    return {
        choice: String(a.choice),
        probabilities: (a.probabilities || {}) as Record<string, number>,
        confidence: Number(a.confidence) || 0,
    };
}

// ---------------------------------------------------------------------------
// local engine helpers (OpenAI-compatible; also used by the format checker)
// ---------------------------------------------------------------------------

async function engineChat(system: string, user: string, maxTokens: number): Promise<string> {
    const res = await fetch(CFG.sparkUrl + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${CFG.sparkKey}` },
        body: JSON.stringify({
            model: CFG.sparkModel,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            temperature: 0,
            max_tokens: maxTokens,
            stream: false,
            ...(CFG.think ? {} : { chat_template_kwargs: { enable_thinking: false } }),
        }),
        signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`engine chat -> HTTP ${res.status}`);
    const j: any = await res.json();
    const text: string = j?.choices?.[0]?.message?.content ?? "";
    return text.trim();
}

// ---------------------------------------------------------------------------
// per-run state (router result, current prompt, variable store)
// ---------------------------------------------------------------------------

type OutputFormat = "chat" | "doc" | "code" | "json" | "yaml" | "csv" | "choice" | "score" | "binary";

const runState: {
    prompt: string;
    format: OutputFormat;
    jevDown: boolean;
    /** When jevDown was last set — the self-heal probe waits JEV_REPROBE_MS. */
    jevDownSince: number;
} = {
    prompt: "",
    format: "chat",
    jevDown: false,
    jevDownSince: 0,
};

/** After a jev failure, wait this long before probing again instead of staying dark
 *  for the rest of the session (a single transient timeout must not disable the
 *  router and closer permanently). */
const JEV_REPROBE_MS = 15_000;

/** Highest bash{N} index recorded during the CURRENT user turn — scopes the
 *  verification guard to this turn's commands (older outputs are not evidence). */
let turnBashMax = 0;

/** Last assistant message seen at message_end, for the flake-recovery net. */
let lastAssistant: { stopReason: string; hasText: boolean } | null = null;
let flakeRetryUsed = 0;
const FLAKE_RETRY_BUDGET = 2;

const vars = new Map<string, string>();
const cap = (s: string): string =>
    s.length <= CFG.maxVarChars
        ? s
        : s.slice(0, CFG.maxVarChars) + `\n…[truncated, ${s.length - CFG.maxVarChars} chars omitted]`;

// toolCallId -> assigned variable prefix (e.g. "bash3"), set at tool_call time
const callVars = new Map<string, string>();
const toolCounters = new Map<string, number>();

// ---------------------------------------------------------------------------
// Feature 4 — news_search tool (local corpus or live HN), var-integrated
// ---------------------------------------------------------------------------

const SEARCH_STOPWORDS = new Set([
    "the", "a", "an", "of", "to", "in", "for", "and", "or", "on", "at", "is", "was",
    "are", "were", "did", "does", "do", "what", "which", "when", "how", "that", "this",
    "it", "its", "by", "with", "from", "about", "tell", "me", "report", "search",
]);

function searchTerms(query: string): string[] {
    return query
        .toLowerCase()
        .replace(/[^a-z0-9$.]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && !SEARCH_STOPWORDS.has(t));
}

function newsDir(): string | null {
    const fromEnv = process.env.DH_NEWS_DIR;
    if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
    for (const cand of ["news", "bench/fixtures/news"]) {
        const p = join(process.cwd(), cand);
        if (existsSync(p)) return p;
    }
    return null;
}

interface NewsHit {
    source: string;
    date: string;
    title: string;
    text: string;
}

async function searchLocalCorpus(query: string, limit: number): Promise<NewsHit[]> {
    const dir = newsDir();
    if (!dir) throw new Error("no local news corpus found (set DH_NEWS_DIR)");
    const terms = searchTerms(query);
    const scored: { hit: NewsHit; score: number }[] = [];
    // Async IO: a large corpus must not block the event loop (and pi's turn) while
    // the files are read.
    for (const f of (await fsp.readdir(dir)).filter((x) => x.endsWith(".txt"))) {
        const full = await fsp.readFile(join(dir, f), "utf8");
        const lines = full.split(/\r?\n/);
        const title = lines[0].trim();
        const body = lines.slice(1).join("\n").trim();
        const lowerTitle = title.toLowerCase();
        const lowerBody = body.toLowerCase();
        let score = 0;
        for (const t of terms) {
            score += 3 * (lowerTitle.split(t).length - 1);
            score += lowerBody.split(t).length - 1;
        }
        if (score > 0) {
            const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
            scored.push({ hit: { source: f.replace(/\.txt$/, ""), date: m ? m[1] : "", title, text: body }, score });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.hit);
}

async function searchLiveHN(query: string, limit: number, hours: number | null): Promise<NewsHit[]> {
    // "hours" switches to time-sorted search with a created_at_i floor (real-case
    // "today's headlines"); without it, relevance-ranked search over all time.
    const base = hours
        ? `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - hours * 3600}`
        : "https://hn.algolia.com/api/v1/search?tags=story";
    const url = `${base}&hitsPerPage=${limit}&query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HN search -> HTTP ${res.status}`);
    const j: any = await res.json();
    return (j.hits || []).map((h: any) => ({
        source: h.objectID,
        date: String(h.created_at || "").slice(0, 10),
        title: String(h.title || h.story_title || ""),
        text: `${h.points ?? "?"} points, ${h.num_comments ?? "?"} comments\n${h.url || `https://news.ycombinator.com/item?id=${h.objectID}`}`,
    }));
}

// ---------------------------------------------------------------------------
// Feature 2a — format router (jev multi-choice on every user request)
// ---------------------------------------------------------------------------

const FORMAT_OPTIONS: Record<string, string> = {
    chat: "Plain conversational answer or explanation; no structure, document, data format, pick or verdict is requested",
    doc: "A markdown document, report, plan or other structured prose answer",
    code: "A program, script, command or code patch is the main deliverable",
    json: "Strict JSON data is the main deliverable",
    yaml: "YAML data is the main deliverable",
    csv: "CSV data or a table is the main deliverable",
    choice: "The user asks to choose, pick or rank among named alternatives, or asks which of two items is later/better/bigger/larger (A or B, which one, which happened first)",
    score: "The user asks for a numeric rating, grade or evaluation score",
    binary: "The user asks a yes/no or true/false question",
};

/**
 * Hard-injected routing preamble — a system-prompt-alike sent as the leading state
 * message. Measured on bench/router_eval.py (18 labeled prompts): without it the 4B
 * decision model scores 14/18 at 0.762 avg winner-probability (misrouting
 * run-and-report to `code`, revision reads to `choice`); with it 17/18 at 0.907, and
 * the one residual miss (chat vs doc) is behaviorally identical downstream.
 * Keep in sync with PREAMBLE in bench/router_eval.py.
 */
const ROUTER_SYSTEM = `You are the output-format router of a coding agent. Classify what OUTPUT SHAPE the user requires for the final answer — the deliverable, not the topic. Exactly one choice.

Definitions with typical examples:
- chat: answer, explain, or find-and-report in prose ("tell me X", "what does Y print", "find the token and report its exact value")
- doc: a composed multi-section summary or report ("give me a combined summary of ...", "write a report", "an overview of all ...")
- code: a program, script, command or code patch is the deliverable ("write a script", "fix the bug in the file", "give me a one-liner that ...")
- json / yaml / csv: data in exactly that machine-readable format ("as JSON", "as YAML", "as a CSV")
- choice: pick among named alternatives ("A or B", "which one", "which happened later")
- score: a numeric rating ("rate 1 to 10", "how good is X on a scale")
- binary: a yes/no or true/false question ("is X ...?", "does it ...?")

Rules: the deliverable shape wins over the topic. Combining multiple sources into a summary is doc. Quoting exact values in prose is chat. Pick json/yaml/csv only when the user names that format. Fixing or producing code is code even if the user also wants a short explanation.`;

async function routeFormat(prompt: string): Promise<OutputFormat> {
    const r = await jevPost("/v1/systemone", {
        state: [
            { role: "system", content: ROUTER_SYSTEM },
            { role: "user", content: `User request to a coding agent:\n"""\n${prompt.slice(0, 6000)}\n"""` },
        ],
        questions: {
            fmt: {
                type: "choice",
                instructions: "What output format does the user require for the final answer to this request?",
                criteria: FORMAT_OPTIONS,
            },
        },
    }, CFG.jevTimeoutMs);
    const a = r.answers.fmt;
    log("router:", a.choice, fmtProbs(a.probabilities));
    return (a.choice in FORMAT_OPTIONS ? a.choice : "chat") as OutputFormat;
}

function fmtProbs(probs: Record<string, number>): string {
    return Object.entries(probs || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, p]) => `${k} ${(p * 100).toFixed(1)}%`)
        .join(", ");
}

// ---------------------------------------------------------------------------
// Feature 1 — variable capture from tool calls/results
// ---------------------------------------------------------------------------

interface AnyRecord {
    [k: string]: unknown;
}
const asRecord = (x: unknown): AnyRecord => (x && typeof x === "object" ? (x as AnyRecord) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : "");

/** Which variables to record per tool. Returns [name, value] pairs. */
function varsForTool(toolName: string, prefix: string, input: AnyRecord, resultText: string): [string, string][] {
    const out: [string, string][] = [];
    const add = (name: string, value: string): void => {
        if (value !== "") out.push([name, cap(value)]);
    };
    switch (toolName) {
        case "read":
            add(`${prefix}_path`, str(input.path));
            add(`${prefix}_content`, resultText);
            break;
        case "bash":
        case "powershell": {
            add(`${prefix}_cmd`, str(input.command));
            add(`${prefix}_out`, resultText);
            const m = resultText.match(/exited with code (-?\d+)/i);
            if (m) add(`${prefix}_exit`, m[1]);
            break;
        }
        case "edit":
            add(`${prefix}_path`, str(input.path));
            add(`${prefix}_diff`, resultText);
            break;
        case "write":
            add(`${prefix}_path`, str(input.path));
            add(`${prefix}_content`, str(input.content));
            break;
        case "grep":
            add(`${prefix}_pattern`, str(input.pattern));
            add(`${prefix}_out`, resultText);
            break;
        case "find":
            add(`${prefix}_pattern`, str(input.pattern));
            add(`${prefix}_out`, resultText);
            break;
        case "ls":
            add(`${prefix}_path`, str(input.path));
            add(`${prefix}_out`, resultText);
            break;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Feature 1 — template rendering ({varname} substitution, known names only)
// ---------------------------------------------------------------------------

const VAR_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
const KNOWN_PREFIX_RE = /^(read|bash|powershell|edit|write|grep|find|ls|news)\d+_/;

let renderSubstitutions = 0;

function renderTemplates(text: string, v: Map<string, string> = vars, count = true): string {
    // Drop hint lines the model echoed verbatim from tool results, then substitute.
    const cleaned = text.replace(/(^|\n)\[vars: [^\]]*\]( — [^\n]*)?(?=\n|$)/g, "").replace(/^\n+/, "");
    return cleaned.replace(VAR_RE, (whole, name: string) => {
        const value = v.get(name);
        if (value === undefined) {
            if (KNOWN_PREFIX_RE.test(name)) {
                log("warning: unresolved known-scheme variable", name, "- left literal");
            }
            return whole;
        }
        if (count) renderSubstitutions++;
        return value;
    });
}

// ---------------------------------------------------------------------------
// Feature 2b — closing round for binary / choice / score
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
    "a", "an", "the", "is", "are", "was", "were", "be", "did", "does", "do", "better", "best", "worse", "good",
    "bad", "which", "what", "who", "when", "where", "why", "how", "should", "would", "could",
    "i", "you", "we", "they", "it", "this", "that", "these", "those", "for", "with", "without",
    "to", "of", "in", "on", "at", "or", "and", "vs", "versus", "one", "pick", "choose", "use",
    "using", "my", "your", "me", "please", "exactly", "better for", "between",
]);

const slug = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9+#.]+/g, "_").replace(/^_+|_+$/g, "") || "opt";

/**
 * Best-effort extraction of enumerated alternatives from a request like
 * "Which is better for X: Python or Bash?" -> [python, bash]. Returns null when
 * nothing convincing is found (caller falls back to /auto generation).
 */
function extractOptions(prompt: string): JevChoice[] | null {
    const orIdx = prompt.search(/\s+(?:or|vs\.?|versus)\s+/i);
    if (orIdx === -1) return null;
    // Window: from the last list separator before "or" to the first sentence ender after it.
    const before = prompt.slice(0, orIdx);
    const after = prompt.slice(orIdx).replace(/^\s+(?:or|vs\.?|versus)\s+/i, "");
    const start = Math.max(
        before.lastIndexOf(","),
        before.lastIndexOf(":"),
        before.lastIndexOf("("),
        before.lastIndexOf(";"),
    ) + 1;
    const endMatch = after.match(/[?.,;:!)]/);
    const end = endMatch ? after.indexOf(endMatch[0]) : after.length;
    const window = `${before.slice(start)} or ${after.slice(0, end)}`;
    const items = window
        .split(/,|\s+(?:or|and|vs\.?|versus)\s+/i)
        .map((s) => s.trim().replace(/^["'`]+|["'`?.,;:]+$/g, "").trim())
        .filter(Boolean);
    const seen = new Set<string>();
    const choices: JevChoice[] = [];
    for (const raw of items) {
        // Drop purpose clauses ("MongoDB for my app" -> "MongoDB"), strip
        // leading/trailing stopwords ("Should I use SQLite" -> "SQLite").
        const item = raw.split(/\s+(?:for|to)\s+/i)[0];
        const words = item.split(/\s+/);
        while (words.length && STOPWORDS.has(words[0].toLowerCase())) words.shift();
        while (words.length && STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop();
        if (words.length === 0 || words.length > 4) continue;
        const cleaned = words.join(" ");
        const key = slug(cleaned);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        choices.push({ key, description: cleaned });
    }
    return choices.length >= 2 && choices.length <= 6 ? choices : null;
}

async function closingRound(prompt: string, lastOutput: string): Promise<string | null> {
    const state = [
        { role: "user", content: prompt.slice(0, 6000) },
        { role: "assistant", content: lastOutput.slice(0, 12000) },
    ];
    const fmt = runState.format;
    try {
        if (fmt === "binary") {
            const r = await jevPost("/v1/systemone", {
                state,
                questions: {
                    verdict: {
                        type: "noul",
                        instructions:
                            "Based on the assistant's analysis, is the correct final answer to the user's question yes/true/affirmative?",
                    },
                },
            }, CFG.jevTimeoutMs * 3);
            const p: number = Number(r.answers.verdict.noul);
            if (!Number.isFinite(p)) {
                log("closer: jev returned no noul probability — skipping verdict");
                return null;
            }
            return [
                `\n\n---\n**JEV closing decision: ${p >= 0.5 ? "YES" : "NO"}** (p=${p.toFixed(3)})`,
                `- yes: ${(p * 100).toFixed(1)}%  ·  no: ${((1 - p) * 100).toFixed(1)}%`,
            ].join("\n");
        }
        if (fmt === "score") {
            const r = await jevPost("/v1/systemone", {
                state,
                questions: {
                    verdict: {
                        type: "score",
                        instructions:
                            "What rating is the correct final answer to the user's request, given the assistant's analysis?",
                        criteria: ["1 — lowest", "2 — low", "3 — medium", "4 — high", "5 — highest"],
                    },
                },
            }, CFG.jevTimeoutMs * 3);
            const a = r.answers.verdict;
            const sc = Number(a.score);
            if (!Number.isFinite(sc)) {
                log("closer: jev returned no score — skipping verdict");
                return null;
            }
            const conf = Number(a.confidence);
            const dist = Object.entries(a.probabilities as Record<string, number>)
                .sort((x, y) => y[1] - x[1])
                .slice(0, 3)
                .map(([lvl, p]) => `level ${lvl}: ${(p * 100).toFixed(1)}%`)
                .join("  ·  ");
            return `\n\n---\n**JEV closing score: ${sc.toFixed(2)} / 5** (confidence=${Number.isFinite(conf) ? conf.toFixed(2) : "n/a"})\n- ${dist}`;
        }
        // choice
        const extracted = extractOptions(prompt);
        if (extracted) {
            log("closer: using extracted options", extracted.map((c) => c.key).join("/"));
            const d = await jevDecide(
                [
                    `User request:\n"""\n${prompt.slice(0, 6000)}\n"""`,
                    `Assistant's final answer and analysis:\n"""\n${lastOutput.slice(0, 12000)}\n"""`,
                ].join("\n\n"),
                extracted,
            );
            const dist = Object.entries(d.probabilities)
                .sort((x, y) => y[1] - x[1])
                .slice(0, 3)
                .map(([k, p]) => `${k}: ${(p * 100).toFixed(1)}%`)
                .join("  ·  ");
            const desc = extracted.find((c) => c.key === d.choice)?.description || "";
            return `\n\n---\n**JEV closing decision: ${d.choice}${desc ? ` (${desc})` : ""}** (confidence=${d.confidence.toFixed(2)})\n- ${dist}`;
        }
        // /auto is an llm2jev extension, not part of the published Jev wire format: a 404
        // from a hosted or minimal service means "no option generation here", not "jev is
        // down" — degrade to no verdict for this question instead of tripping jevDown.
        let r: any;
        try {
            r = await jevPost("/v1/systemone/auto", {
                state,
                questions: {
                    verdict: {
                        type: "auto",
                        instructions:
                            "Generate 3-5 concrete candidate ANSWERS to the user's question (the actual options, tools or approaches being chosen between — e.g. 'python', 'bash'), never descriptions of what an answer should contain. Then pick the best.",
                        num_options: 4,
                    },
                },
            }, Math.max(CFG.jevTimeoutMs * 3, 60000));
        } catch (e) {
            if (e instanceof JevUnavailable && /\b404\b/.test(e.message)) {
                log("closer: this jev service has no /auto endpoint — skipping verdict");
                return null;
            }
            throw e;
        }
        const a = r.answers.verdict;
        const gen = a.generated_options as Record<string, string>;
        const dist = Object.entries(a.probabilities as Record<string, number>)
            .sort((x, y) => y[1] - x[1])
            .slice(0, 3)
            .map(([k, p]) => `${k}: ${(p * 100).toFixed(1)}%`)
            .join("  ·  ");
        const desc = gen?.[a.choice] ? ` — ${gen[a.choice]}` : "";
        const conf = Number(a.confidence);
        return `\n\n---\n**JEV closing decision: ${a.choice}${desc}** (confidence=${Number.isFinite(conf) ? conf.toFixed(2) : "n/a"})\n- ${dist}`;
    } catch (e) {
        if (e instanceof JevUnavailable) {
            runState.jevDown = true;
            runState.jevDownSince = Date.now();
            log("closer skipped:", e.message);
            return null;
        }
        throw e;
    }
}

// ---------------------------------------------------------------------------
// Feature 2c — format checker for code / json / yaml / csv
// ---------------------------------------------------------------------------

/**
 * Extract the deliverable payload: fenced block if present, else whole text.
 * When `lang` is given, a fence tagged with it wins over a later untagged one, so a
 * trailing example snippet cannot shadow the real deliverable.
 */
function extractPayload(text: string, lang?: string): string {
    const fences = [...text.matchAll(/```([a-zA-Z0-9_+#.-]*)\r?\n([\s\S]*?)```/g)].map((m) => ({
        tag: m[1].toLowerCase(),
        body: m[2],
    }));
    if (lang) {
        const tagged = fences.find((f) => f.tag === lang || (lang === "yaml" && f.tag === "yml"));
        if (tagged) return tagged.body.trim();
    }
    return fences.length ? fences[fences.length - 1].body.trim() : text.trim();
}

/**
 * JSON candidate: fenced block, else the outermost brace/bracket span (JSON embedded
 * in prose). Objects AND arrays both count — a valid JSON array must not be judged
 * invalid just because the surrounding prose happens to contain a `{...}`.
 */
function extractJsonCandidate(text: string): string {
    const fenced = extractPayload(text, "json");
    if (fenced.startsWith("{") || fenced.startsWith("[")) return fenced;
    const startObj = text.indexOf("{");
    const startArr = text.indexOf("[");
    const start = startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (start !== -1 && end > start) return text.slice(start, end + 1);
    return fenced;
}

function validateFormat(text: string, fmt: OutputFormat): boolean {
    const payload = fmt === "json" ? extractJsonCandidate(text) : extractPayload(text);
    if (!payload) return false;
    switch (fmt) {
        case "json":
            try {
                JSON.parse(payload);
                return true;
            } catch {
                return false;
            }
        case "yaml": {
            if (payload.startsWith("{") || payload.startsWith("[")) return false;
            const lines = payload.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
            if (!lines.length) return false;
            const kv = lines.filter((l) => /^[\s]*[-a-zA-Z0-9_."'\\/]+\s*:(\s|$)/.test(l));
            return kv.length >= Math.ceil(lines.length / 2);
        }
        case "csv":
            return payload.includes(",") || payload.includes("\n");
        case "code": {
            // Substantive check: fenced blocks must be balanced — an odd fence count
            // means the deliverable was cut off mid-block. Unfenced answers (inline
            // code, patches) stay valid; fail-open by design.
            const fences = (text.match(/```/g) || []).length;
            return fences % 2 === 0;
        }
        default:
            return true;
    }
}

async function llmReformat(lastOutput: string, fmt: OutputFormat): Promise<string> {
    const system =
        `You are a strict output-format fixer. Re-emit the user's content so that the main deliverable is valid ${fmt}` +
        (fmt === "json" ? " (parseable by JSON.parse, no comments, no trailing commas)" : "") +
        (fmt === "yaml" ? " (plain YAML mapping, no document markers needed)" : "") +
        (fmt === "csv" ? " (comma-separated with a header row)" : "") +
        (fmt === "code" ? " (inside one fenced code block)" : "") +
        ". Change formatting only — do NOT change any facts, names, numbers or code semantics. Output the fixed content only, nothing else.";
    // Scale the fix budget with the payload: a long JSON/CSV deliverable needs more
    // than 2048 tokens or the re-emission gets cut off mid-structure and stays invalid.
    const budget = Math.min(8192, Math.max(2048, Math.ceil(lastOutput.length / 3) + 1024));
    return engineChat(system, lastOutput, budget);
}

async function checkFormat(lastOutput: string, fmt: OutputFormat): Promise<{ text: string; fixed: boolean } | null> {
    if (validateFormat(lastOutput, fmt)) {
        log("checker: valid on first pass");
        return { text: lastOutput, fixed: false };
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
        log(`checker: invalid, llm reformat attempt ${attempt}`);
        let fixed: string;
        try {
            fixed = await llmReformat(lastOutput, fmt);
        } catch (e) {
            log("checker: reformat call failed:", String(e));
            return null;
        }
        if (validateFormat(fixed, fmt)) {
            log("checker: fixed");
            return { text: fixed, fixed: true };
        }
        lastOutput = fixed;
    }
    log("checker: still invalid after retries, keeping original");
    return { text: lastOutput, fixed: false };
}

// ---------------------------------------------------------------------------
// Feature 2d — verification guard: success claims vs recorded command output
// ---------------------------------------------------------------------------

const ERROR_RE = /(Traceback \(most recent call last\)|SyntaxError|NameError|TypeError|ValueError|IndentationError|ImportError|ModuleNotFoundError)/;
const NONZERO_EXIT_RE = /exited with code [1-9]\d*/;
const SUCCESS_CLAIM_RE = /(verified|confirmed|now prints|now outputs|correctly prints|correctly outputs|prints `|outputs `|successfull|works as expected|fix(ed)? and)/i;
// Search/test-class commands exit nonzero as a normal ANSWER (grep: no match, diff:
// files differ, test: false) — for those, a nonzero exit alone is not an error.
const SEARCH_CLASS_CMD_RE = /^\s*(grep|rg|ag|find|fd|locate|test|\[|diff|comm|which|where|command -v)\b/;

/**
 * Deterministic cross-check: if the final reply claims the work succeeded while the LAST
 * command output recorded DURING THIS TURN is an error, append a warning with the
 * recorded error tail. Catches "hallucinated verification" (claiming a fix works when
 * the run failed). Outputs from earlier turns are not evidence about this reply.
 */
function verificationGuard(finalText: string, maxNOverride?: number): string | null {
    const maxN = maxNOverride ?? turnBashMax;
    if (!maxN) return null;
    const out = vars.get(`bash${maxN}_out`);
    const cmd = vars.get(`bash${maxN}_cmd`) || "";
    if (!out) return null;
    const isError = ERROR_RE.test(out) || (NONZERO_EXIT_RE.test(out) && !SEARCH_CLASS_CMD_RE.test(cmd));
    if (!isError) return null;
    if (!SUCCESS_CLAIM_RE.test(finalText)) return null;
    const tail = out.slice(-240).trim();
    return `\n\n---\n⚠️ **de-hallucination check**: this reply claims success, but the last recorded command output (\`bash${maxN}_out\`) is an error:\n\n\`\`\`\n${tail}\n\`\`\`\nRe-run the command and confirm before trusting the claim.`;
}

// ---------------------------------------------------------------------------
// system prompt policy
// ---------------------------------------------------------------------------

const POLICY_MARKER = "## Verbatim quoting policy (de-hallucination)";
const POLICY_QUOTING = `

Every tool result is recorded as template variables, listed at its end like
[vars: bash1_cmd bash1_out]. When your final reply mentions one of those facts, you MUST
write the placeholder, never retype the value:

- Write:  "The file at {read1_path} starts with: {read1_content}"
- NEVER:  "The file at /work/notes.txt starts with: first line..."

Compact quoting: when a large value (a whole file or command output) contains several facts
you need, quote the variable once in its own block, then refer to the specific line or field
by name. Never paste the same variable several times in one reply.

Placeholders are replaced with the exact recorded values before the user sees your reply, so
quoting is always byte-exact and cannot drift. Use exactly the listed variable names — never
invent one. Braces that are not a listed variable name are left untouched, so braces inside
code you write are safe.

Scope: the rule applies ONLY to facts that have a listed variable. Anything else — your own
reasoning, structure, commentary, and details with no variable (e.g. a link inside a larger
{text} value you already quoted) — is written normally. Do not hesitate or re-check: pick
the variable when one exists, write freely when it does not.
`;
const POLICY_DECIDE = `
When you need to decide among candidate options (which fix to apply, which approach to take,
which item is correct), call the \`jev_decide\` tool with the context and the choices: it
returns a calibrated probability for each choice instead of you guessing.
`;

/** Policy is built from the enabled features only, so a fully-disabled extension
 *  (the benchmark baseline) behaves exactly like stock pi. */
function buildPolicy(): string {
    let body = "";
    if (CFG.templates) body += POLICY_QUOTING;
    if (CFG.decide) body += POLICY_DECIDE;
    return body ? POLICY_MARKER + body : "";
}

// ---------------------------------------------------------------------------
// extension entry
// ---------------------------------------------------------------------------

/**
 * Helpers exported for tests (pi only consumes the default export). The REAL
 * renderTemplates is exported — with its hint-stripping — so tests exercise the
 * production path, not a look-alike shim; `vars` is the live store for guard tests.
 */
export const __internals = {
    extractOptions,
    extractPayload,
    extractJsonCandidate,
    validateFormat,
    verificationGuard,
    varsForTool,
    slug,
    renderTemplates,
    vars,
    int,
};

export default async function dehallucination(pi: ExtensionAPI): Promise<void> {
    // --- local Spark provider (registered first so it exists at model selection) ---
    let sparkModelId = CFG.sparkModel;
    try {
        const r = await fetch(CFG.sparkUrl + "/models", { signal: AbortSignal.timeout(3000) });
        const j: any = await r.json();
        const id = j?.data?.[0]?.id;
        if (id) sparkModelId = id;
    } catch {
        // engine down: register anyway with the configured/default id
    }
    CFG.sparkModel = sparkModelId;
    pi.registerProvider("spark-local", {
        name: "Spark (local llama-server)",
        baseUrl: CFG.sparkUrl,
        api: "openai-completions",
        apiKey: CFG.sparkKey,
        models: [
            {
                id: sparkModelId,
                name: `Spark local (${sparkModelId})`,
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: CFG.sparkCtx,
                maxTokens: CFG.sparkMaxOut,
                samplingParams: {
                    // Low temperature tames the 4B's degenerate reasoning loops; with
                    // thinking off entirely (default), they vanish — see DH_SPARK_THINK.
                    temperature: 0.2,
                    ...(CFG.think ? {} : { chat_template_kwargs: { enable_thinking: false } }),
                },
            },
        ],
    });
    log("provider spark-local registered, model", sparkModelId);

    // --- Feature 3: jev_decide tool ---
    if (CFG.decide) {
    pi.registerTool({
        name: "jev_decide",
        label: "jev decide",
        description:
            "Delegate a decision to the calibrated local decision service. Give the decision context and 2-255 candidate choices (short stable key + concrete description). Returns the chosen key, a probability for every choice, and a confidence. Use this whenever a decision among alternatives matters, instead of guessing in prose.",
        promptSnippet:
            "jev_decide: delegate a decision among candidates, get calibrated probabilities back.",
        parameters: {
            type: "object",
            properties: {
                context: {
                    type: "string",
                    description: "What needs deciding, plus the relevant observed facts.",
                },
                choices: {
                    type: "array",
                    minItems: 2,
                    maxItems: 255,
                    items: {
                        type: "object",
                        properties: {
                            key: { type: "string", description: "Short stable id, e.g. refactor" },
                            description: { type: "string", description: "What this choice means/implies" },
                        },
                        required: ["key", "description"],
                    },
                },
            },
            required: ["context", "choices"],
        } as any,
        async execute(_toolCallId, params) {
            const choices = (params.choices as JevChoice[]).map((c) => ({
                key: String(c.key),
                description: String(c.description),
            }));
            try {
                const d = await jevDecide(String(params.context), choices);
                const dist = Object.entries(d.probabilities)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, p]) => `- ${k}: ${(p * 100).toFixed(1)}%`)
                    .join("\n");
                const report = `Decision: ${d.choice} (confidence ${d.confidence.toFixed(2)})\n${dist}`;
                return {
                    content: [{ type: "text", text: report }],
                    details: d,
                };
                } catch (e) {
                    throw new Error(
                        `jev decision service unavailable (${String(e instanceof JevUnavailable ? e.message : e)}). Make the decision yourself and say so.`,
                    );
                }
            },
    });
    }

    // --- Feature 4: news_search tool ---
    pi.registerTool({
        name: "news_search",
        label: "news search",
        description:
            "Search a news archive for articles matching a query. Returns the top matches with date, headline and body. Use it for any question about news, announcements, incidents or recent events, and quote facts from the returned [vars: …] placeholders instead of retyping them.",
        promptSnippet: "news_search: search the news archive (local corpus, or live HN with DH_NEWS_LIVE=1).",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Search terms, e.g. 'Pulsegrid outage duration'" },
                limit: { type: "number", description: "Max matches to return (default 3, max 10)" },
                hours: { type: "number", description: "Only articles from the last N hours (time-sorted). Use e.g. 24 for today's headlines; omit for relevance search." },
            },
            required: ["query"],
        } as any,
        async execute(_toolCallId, params) {
            const query = String(params.query || "");
            const limit = Math.min(10, Math.max(1, Number(params.limit) || 3));
            const hoursRaw = Number(params.hours);
            const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(24 * 30, hoursRaw) : null;
            const live = flag("DH_NEWS_LIVE");
            let hits: NewsHit[];
            let degraded = "";
            try {
                hits = live ? await searchLiveHN(query, limit, hours) : await searchLocalCorpus(query, limit);
            } catch (e) {
                // Fail open: when the live backend is unreachable, try the local corpus
                // before giving up — one dead source must not kill the tool.
                log("news_search primary source failed:", String(e).slice(0, 120));
                try {
                    hits = live ? await searchLocalCorpus(query, limit) : [];
                    if (hits.length) degraded = " (live search unavailable — showing local corpus)";
                } catch {
                    hits = [];
                }
                if (!hits.length) {
                    return {
                        content: [{ type: "text", text: `News search unavailable (${String(e).slice(0, 120)}). The archive could not be reached — answer from your own knowledge and say so.` }],
                        details: { query, hits: [], error: String(e) },
                    };
                }
            }
            if (!hits.length) {
                return {
                    content: [{ type: "text", text: `No news matches for "${query}". Try different terms.` }],
                    details: { query, hits: [] },
                };
            }
            const n = (toolCounters.get("news") || 0) + 1;
            toolCounters.set("news", n);
            const names: string[] = [`news${n}_query`];
            if (CFG.templates) vars.set(`news${n}_query`, query);
            const blocks = hits.map((h, i) => {
                const k = i + 1;
                if (CFG.templates) {
                    vars.set(`news${n}_r${k}_title`, cap(h.title));
                    vars.set(`news${n}_r${k}_date`, h.date);
                    vars.set(`news${n}_r${k}_text`, cap(h.text));
                }
                names.push(`news${n}_r${k}_title`, `news${n}_r${k}_date`, `news${n}_r${k}_text`);
                return `#${k} [${h.source}] ${h.date}\n${h.title}\n${h.text.slice(0, 700)}`;
            });
            const hint = CFG.templates
                ? `\n[vars: ${names.join(" ")}] — quote these as {name} placeholders in your final reply; they are replaced with the exact recorded values`
                : "";
            return {
                content: [{ type: "text", text: blocks.join("\n\n") + hint + degraded }],
                details: { query, hits: hits.map((h) => h.source) },
            };
        },
    });

    // --- Feature 2a: router + policy injection on every user request ---
    pi.on("before_agent_start", async (event: any) => {
        // pi >=1.3 also fires this for extension-triggered runs (messageType "custom",
        // no prompt) — only route actual user prompts. Keep the truthiness check: an
        // absent/undefined messageType (older pi) must still route.
        if (event.messageType && event.messageType !== "user") return;
        runState.prompt = String(event.prompt || "");
        flakeRetryUsed = 0;
        turnBashMax = 0; // guard scope: only this turn's command outputs count
        if (CFG.router) {
            // Self-heal: a jev failure (even a transient timeout) must not darken the
            // router and closer for the rest of the session.
            if (runState.jevDown && Date.now() - runState.jevDownSince > JEV_REPROBE_MS) {
                log("router: jev was down — re-probing");
                runState.jevDown = false;
            }
            if (runState.jevDown) {
                runState.format = "chat";
            } else {
                try {
                    runState.format = await routeFormat(runState.prompt);
                } catch (e) {
                    if (e instanceof JevUnavailable) {
                        runState.jevDown = true;
                        runState.jevDownSince = Date.now();
                        runState.format = "chat";
                        log("router: jev down, failing open to chat:", e.message);
                    } else {
                        throw e;
                    }
                }
            }
        }
        // Append the policy for enabled features only; strip a previous copy in case
        // the base prompt is cumulative.
        const policy = buildPolicy();
        if (policy) {
            let sp = String(event.systemPrompt || "");
            const idx = sp.lastIndexOf(POLICY_MARKER);
            if (idx !== -1) sp = sp.slice(0, idx).replace(/\n+$/, "\n\n");
            return { systemPrompt: sp + policy };
        }
        return undefined;
    });

    // --- Feature 1: capture variables at tool_call / tool_result time ---
    pi.on("tool_call", (event: any) => {
        if (!CFG.templates) return;
        const toolName = String(event.toolName || "");
        if (!["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].includes(toolName)) return;
        const n = (toolCounters.get(toolName) || 0) + 1;
        toolCounters.set(toolName, n);
        callVars.set(String(event.toolCallId), `${toolName}${n}`);
    });

    pi.on("tool_result", (event: any) => {
        if (!CFG.templates) return;
        const prefix = callVars.get(String(event.toolCallId));
        if (!prefix) return;
        callVars.delete(String(event.toolCallId));
        // Track this turn's latest bash index — the verification guard only judges
        // outputs recorded during the current user turn.
        if (String(event.toolName) === "bash") {
            const m = /^bash(\d+)$/.exec(prefix);
            if (m) turnBashMax = Math.max(turnBashMax, Number(m[1]));
        }
        const resultText = (event.content || [])
            .filter((c: any) => c && c.type === "text")
            .map((c: any) => String(c.text))
            .join("\n");
        const pairs = varsForTool(String(event.toolName), prefix, asRecord(event.input), resultText);
        if (!pairs.length) return;
        for (const [name, value] of pairs) vars.set(name, value);
        log("vars +=", pairs.map(([n]) => n).join(" "));
        // Discovery hint: names + one short imperative. The full sentence version was
        // heavy per-result; the bare-name version lost all placeholder compliance —
        // this middle length kept both compliance and token overhead reasonable.
        const hint = `[vars: ${pairs.map(([n]) => n).join(" ")}] — quote these as {name} placeholders in your final reply; they are replaced with the exact recorded values`;
        return { content: [...event.content, { type: "text", text: hint }] };
    });

    // --- Final-output pipeline: closing round / format check / template render ---
    pi.on("message_end", async (event: any) => {
        const msg = event.message;
        if (!msg || msg.role !== "assistant") return;
        lastAssistant = {
            stopReason: String(msg.stopReason || ""),
            hasText: (msg.content || []).some((c: any) => c && c.type === "text" && String(c.text).trim()),
        };
        const content: any[] = Array.isArray(msg.content) ? msg.content : [];
        const hasToolCalls = content.some((c) => c && c.type === "toolCall");
        const hasText = content.some((c) => c && c.type === "text" && String(c.text).trim());
        if (hasToolCalls || !hasText) return;
        if (msg.stopReason === "aborted" || msg.stopReason === "error") return;

        const lastOutput = content
            .filter((c) => c && c.type === "text")
            .map((c) => String(c.text))
            .join("\n");

        // Analyze the user-visible text, not the placeholder text. Rendering after the
        // closer/checker/guard can turn a structurally valid payload into an invalid one
        // when a substituted value contains quotes or newlines.
        const renderedLastOutput = CFG.templates ? renderTemplates(lastOutput, vars, false) : lastOutput;

        let changed = false;
        const newContent = [...content];
        let deliverableAlreadyRendered = false;

        // The model's own last text part is the deliverable. Capture its index BEFORE
        // the closing round appends a verdict, so the format checker can never replace
        // the verdict instead of the deliverable.
        let deliverableIdx = -1;
        for (let i = newContent.length - 1; i >= 0; i--) {
            if (newContent[i] && newContent[i].type === "text") {
                deliverableIdx = i;
                break;
            }
        }

        // 2b: closing round for binary / choice / score
        if (CFG.closer && ["binary", "choice", "score"].includes(runState.format)) {
            // If the router's jev failure was transient and long enough ago, the closer
            // may still get a verdict — retry instead of skipping on a stale flag.
            if (runState.jevDown && Date.now() - runState.jevDownSince > JEV_REPROBE_MS) {
                log("closer: jev was down at route time — re-probing");
                runState.jevDown = false;
            }
            if (!runState.jevDown) {
                log("closer: running for format", runState.format);
                const verdict = await closingRound(runState.prompt, renderedLastOutput);
                log("closer: verdict =", verdict ? verdict.split("\n")[0] : "null");
                if (verdict) {
                    newContent.push({ type: "text", text: verdict });
                    changed = true;
                }
            }
        }

        // 2c: format checker for code / json / yaml / csv (uses last output sans thinking —
        // thinking content is never part of `lastOutput` by construction above)
        if (CFG.checker && ["code", "json", "yaml", "csv"].includes(runState.format)) {
            const result = await checkFormat(renderedLastOutput, runState.format);
            if (result && result.fixed && deliverableIdx >= 0 && newContent[deliverableIdx] && newContent[deliverableIdx].type === "text") {
                newContent[deliverableIdx] = { type: "text", text: result.text };
                deliverableAlreadyRendered = true;
                changed = true;
            }
        }

        // 2d: verification guard against the recorded command outputs
        const guard = verificationGuard(renderedLastOutput);
        if (guard) {
            newContent.push({ type: "text", text: guard });
            changed = true;
            log("verification guard triggered");
        }

        // 1: template render on every text part (verdict included — harmless).
        // A checker-repaired deliverable was built from renderedLastOutput, so it must
        // not be rendered a second time: substituted values may contain brace sequences.
        if (CFG.templates) {
            for (let i = 0; i < newContent.length; i++) {
                if (i === deliverableIdx && deliverableAlreadyRendered) continue;
                const c = newContent[i];
                if (c && c.type === "text") {
                    const rendered = renderTemplates(String(c.text));
                    if (rendered !== String(c.text)) changed = true;
                    newContent[i] = { type: "text", text: rendered };
                }
            }
        }

        if (!changed) return;
        log("final message processed, format =", runState.format, "| substitutions:", renderSubstitutions);
        log("final content types:", newContent.map((c) => c.type).join(","));
        return { message: { ...msg, content: newContent } };
    });

    // --- Flake-recovery net: a thinking/token-cap burn with no answer text gets exactly
    //     one forced continuation (agent_before_settle -> continue), instead of ending the
    //     run with an empty reply.
    pi.on("agent_before_settle", () => {
        if (lastAssistant && lastAssistant.stopReason === "length" && !lastAssistant.hasText && flakeRetryUsed < FLAKE_RETRY_BUDGET) {
            flakeRetryUsed++;
            log("flake recovery: forcing one continuation (length-flaked, no text)");
            return { continue: true };
        }
        return undefined;
    });

    log("de-hallucination extension loaded", {
        jev: CFG.jevUrl,
        engine: CFG.sparkUrl,
        router: CFG.router,
        templates: CFG.templates,
        closer: CFG.closer,
        checker: CFG.checker,
    });
}
