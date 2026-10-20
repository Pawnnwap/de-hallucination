"use strict";

const { CFG, log } = require("./config.cjs");

class JevUnavailable extends Error {}

function jevFailureKind(e) {
  const msg = String((e && e.message) || e);
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|EAI_AGAIN|fetch failed/i.test(msg) ? "down" : "flaky";
}

async function jevPost(path, body, timeoutMs) {
  const post = () =>
    fetch(CFG.jevUrl + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CFG.jevKey ? { Authorization: `Bearer ${CFG.jevKey}` } : {}),
      },
      body: JSON.stringify(
        CFG.jevModel && body && typeof body === "object"
          ? { ...body, model: CFG.jevModel }
          : body,
      ),
      signal: AbortSignal.timeout(timeoutMs),
    });
  const pause = () => new Promise((r) => setTimeout(r, 500));
  let res;
  try {
    res = await post();
  } catch (e) {
    if (jevFailureKind(e) === "down") {
      throw new JevUnavailable(`jev unreachable at ${CFG.jevUrl}: ${String(e)}`);
    }
    log(`jev ${path} soft failure (${String(e).slice(0, 100)}) — retrying once`);
    await pause();
    try {
      res = await post();
    } catch (e2) {
      throw new JevUnavailable(`jev unreachable at ${CFG.jevUrl}: ${String(e2)}`);
    }
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status >= 500 || res.status === 429) {
      log(`jev ${path} -> HTTP ${res.status} — retrying once`);
      await pause();
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

const FORMAT_OPTIONS = {
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

function fmtProbs(probs) {
  return Object.entries(probs || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, p]) => `${k} ${(p * 100).toFixed(1)}%`)
    .join(", ");
}

async function routeFormat(prompt) {
  const r = await jevPost(
    "/v1/systemone",
    {
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
    },
    CFG.jevTimeoutMs,
  );
  const a = r.answers.fmt;
  log("router:", a.choice, fmtProbs(a.probabilities));
  return a.choice in FORMAT_OPTIONS ? a.choice : "chat";
}

async function jevDecide(context, choices) {
  if (choices.length < 2 || choices.length > 255) {
    throw new Error(`jev_decide needs 2..255 choices, got ${choices.length}`);
  }
  const criteria = {};
  for (const c of choices) criteria[c.key] = c.description;
  const r = await jevPost(
    "/v1/systemone",
    {
      state: context,
      questions: {
        decision: {
          type: "choice",
          instructions: "Considering the context, which choice is the best decision?",
          criteria,
        },
      },
    },
    CFG.jevTimeoutMs,
  );
  const a = r.answers.decision;
  return {
    choice: String(a.choice),
    probabilities: a.probabilities || {},
    confidence: Number(a.confidence) || 0,
  };
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "did", "does", "do", "better", "best", "worse", "good",
  "bad", "which", "what", "who", "when", "where", "why", "how", "should", "would", "could",
  "i", "you", "we", "they", "it", "this", "that", "these", "those", "for", "with", "without",
  "to", "of", "in", "on", "at", "or", "and", "vs", "versus", "one", "pick", "choose", "use",
  "using", "my", "your", "me", "please", "exactly", "better for", "between",
]);

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9+#.]+/g, "_").replace(/^_+|_+$/g, "") || "opt";

function extractOptions(prompt) {
  const orIdx = prompt.search(/\s+(?:or|vs\.?|versus)\s+/i);
  if (orIdx === -1) return null;
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
  const seen = new Set();
  const choices = [];
  for (const raw of items) {
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

async function closingRound(prompt, lastOutput, fmt) {
  const state = [
    { role: "user", content: prompt.slice(0, 6000) },
    { role: "assistant", content: lastOutput.slice(0, 12000) },
  ];
  try {
    if (fmt === "binary") {
      const r = await jevPost(
        "/v1/systemone",
        {
          state,
          questions: {
            verdict: {
              type: "noul",
              instructions:
                "Based on the assistant's analysis, is the correct final answer to the user's question yes/true/affirmative?",
            },
          },
        },
        CFG.jevTimeoutMs * 3,
      );
      const p = Number(r.answers.verdict.noul);
      if (!Number.isFinite(p)) return null;
      return [
        `**JEV closing decision: ${p >= 0.5 ? "YES" : "NO"}** (p=${p.toFixed(3)})`,
        `- yes: ${(p * 100).toFixed(1)}%  ·  no: ${((1 - p) * 100).toFixed(1)}%`,
      ].join("\n");
    }
    if (fmt === "score") {
      const r = await jevPost(
        "/v1/systemone",
        {
          state,
          questions: {
            verdict: {
              type: "score",
              instructions:
                "What rating is the correct final answer to the user's request, given the assistant's analysis?",
              criteria: ["1 — lowest", "2 — low", "3 — medium", "4 — high", "5 — highest"],
            },
          },
        },
        CFG.jevTimeoutMs * 3,
      );
      const a = r.answers.verdict;
      const sc = Number(a.score);
      if (!Number.isFinite(sc)) return null;
      const conf = Number(a.confidence);
      const dist = Object.entries(a.probabilities || {})
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([lvl, p]) => `level ${lvl}: ${(p * 100).toFixed(1)}%`)
        .join("  ·  ");
      return `**JEV closing score: ${sc.toFixed(2)} / 5** (confidence=${
        Number.isFinite(conf) ? conf.toFixed(2) : "n/a"
      })\n- ${dist}`;
    }
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
      const desc = (extracted.find((c) => c.key === d.choice) || {}).description || "";
      return `**JEV closing decision: ${d.choice}${desc ? ` (${desc})` : ""}** (confidence=${d.confidence.toFixed(2)})\n- ${dist}`;
    }
    let r;
    try {
      r = await jevPost(
        "/v1/systemone/auto",
        {
          state,
          questions: {
            verdict: {
              type: "auto",
              instructions:
                "Generate 3-5 concrete candidate ANSWERS to the user's question (the actual options, tools or approaches being chosen between — e.g. 'python', 'bash'), never descriptions of what an answer should contain. Then pick the best.",
              num_options: 4,
            },
          },
        },
        Math.max(CFG.jevTimeoutMs * 3, 60000),
      );
    } catch (e) {
      if (e instanceof JevUnavailable && /\b404\b/.test(e.message)) {
        log("closer: this jev service has no /auto endpoint — skipping verdict");
        return null;
      }
      throw e;
    }
    const a = r.answers.verdict;
    const gen = a.generated_options || {};
    const dist = Object.entries(a.probabilities || {})
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([k, p]) => `${k}: ${(p * 100).toFixed(1)}%`)
      .join("  ·  ");
    const desc = gen[a.choice] ? ` — ${gen[a.choice]}` : "";
    const conf = Number(a.confidence);
    return `**JEV closing decision: ${a.choice}${desc}** (confidence=${
      Number.isFinite(conf) ? conf.toFixed(2) : "n/a"
    })\n- ${dist}`;
  } catch (e) {
    if (e instanceof JevUnavailable) throw e;
    log("closer failed:", String(e));
    return null;
  }
}

module.exports = {
  JevUnavailable,
  jevPost,
  routeFormat,
  jevDecide,
  closingRound,
  extractOptions,
  FORMAT_OPTIONS,
  ROUTER_SYSTEM,
};
