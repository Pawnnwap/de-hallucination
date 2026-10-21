#!/usr/bin/env node
"use strict";

const path = require("path");
const { CFG, log } = require("./lib/config.cjs");
const { routeFormat, closingRound, JevUnavailable } = require("./lib/jev.cjs");
const {
  resultText,
  renderTemplates,
  formatIssue,
  toolFamily,
  varsForTool,
  verificationGuard,
  hintFor,
  truncateNotice,
} = require("./lib/text.cjs");
const { withState, load, resetTurn, cleanupOldStates } = require("./lib/state.cjs");
const { parseNewsVars } = require("./lib/news.cjs");

const POLICY_MARKER = "## Verbatim quoting policy (de-hallucination)";
const JEV_REPROBE_MS = 15000;
const CLI_PATH = path.resolve(__dirname, "cli.cjs").replace(/\\/g, "/");
const CLI_NEWS = `node "${CLI_PATH}" news-search 'QUERY' --limit 3`;
const CLI_DECIDE = `node "${CLI_PATH}" jev-decide --context 'CONTEXT' --choice key1='DESCRIPTION' --choice key2='DESCRIPTION2'`;
const useMcp = CFG.toolsMode === "mcp" || CFG.toolsMode === "both";
const useCli = CFG.toolsMode === "cli" || CFG.toolsMode === "both";
const CHECK_FORMATS = new Set(["code", "json", "yaml", "csv"]);
const CLOSE_FORMATS = new Set(["binary", "choice", "score"]);

function buildPolicy() {
  let body = "";
  if (CFG.templates) {
    body += `

Every tool result records its facts as template variables, listed at the result's end like
[vars: bash1_cmd bash1_out]. When your final reply mentions such a fact, write the {name}
placeholder, never retype the value: the reply is rendered with the exact recorded values,
so quoting cannot drift. Use only listed names; other braces pass through untouched, so
braces in code are safe. Quote a large variable once in its own block, then cite lines or
fields by name. Only listed facts are quoted this way; everything else is written normally.
`;
  }
  if (CFG.decide) {
    if (useMcp) {
      body += `
When you must decide among candidate options (which fix, which approach, which item), call
the jev_decide MCP tool (server: dehall) with the context and the choices: it returns
calibrated probabilities instead of you guessing.
`;
    }
    if (useCli) {
      body += `
When you must decide among candidate options (which fix, which approach, which item), run
this with the shell instead of guessing:

  ${CLI_DECIDE}

Repeat --choice per candidate (2..255). It prints the chosen key, each probability, and a
confidence.
`;
    }
  }
  if (useMcp) {
    body += `
For news, announcements, incidents or recent events, call the news_search MCP tool (server:
dehall) and quote facts from its [vars: …] list as {name} placeholders.
`;
  }
  if (useCli) {
    body += `
For news, announcements, incidents or recent events, run (add --hours 24 for recent
headlines):

  ${CLI_NEWS}

It prints the matching articles and a [vars: …] list; quote those facts as {name} placeholders.
`;
  }
  if (CFG.toolsMode === "both") {
    body += `
If the MCP tools are missing from your tool list, use the CLI commands above — same records.
`;
  }
  return body ? POLICY_MARKER + body : "";
}

function turnReminder() {
  const parts = [];
  if (CFG.templates) parts.push("quote recorded facts as {name} placeholders");
  if (CFG.decide) {
    parts.push(
      useMcp && !useCli ? "use jev_decide for decisions" : "use the dehall CLI for decisions",
    );
  }
  parts.push(
    useMcp && !useCli
      ? "news_search for news"
      : `dehall CLI: ${CLI_PATH} (jev-decide / news-search)`,
  );
  if (CFG.toolsMode === "both") parts.push("MCP may be hidden here; the CLI is the fallback");
  return `[de-hallucination] ${parts.join("; ")}.`;
}

function additional(event, text) {
  if (!text) return {};
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

async function onSessionStart(input) {
  cleanupOldStates();
  let firstTime = true;
  withState(input.session_id, (state) => {
    if (!state.turn) resetTurn(state, input.turn_id || "", "");
    // Codex re-fires SessionStart on resume and keeps the earlier policy message in the
    // history, so re-injecting would stack duplicate policy blocks in the model context.
    firstTime = !state.policyInjected;
    state.policyInjected = true;
  });
  return firstTime ? additional("SessionStart", buildPolicy()) : {};
}

async function onUserPromptSubmit(input) {
  const prompt = String(input.prompt || "");
  withState(input.session_id, (state) => {
    resetTurn(state, input.turn_id, prompt);
    if (state.jevDown && Date.now() - state.jevDownSince > JEV_REPROBE_MS) {
      log("router: jev was down — re-probing");
      state.jevDown = false;
    }
  });

  if (CFG.router) {
    const snapshot = load(input.session_id);
    if (snapshot.jevDown) {
      withState(input.session_id, (state) => {
        state.turn.format = "chat";
      });
    } else {
      try {
        const format = await routeFormat(prompt);
        withState(input.session_id, (state) => {
          state.turn.format = format;
        });
      } catch (e) {
        if (e instanceof JevUnavailable) {
          log("router: jev down, failing open to chat:", e.message);
          withState(input.session_id, (state) => {
            state.jevDown = true;
            state.jevDownSince = Date.now();
            state.turn.format = "chat";
          });
        } else {
          throw e;
        }
      }
    }
  }
  return additional("UserPromptSubmit", turnReminder());
}

async function onPreToolUse(input) {
  if (!CFG.templates) return {};
  const family = toolFamily(input.tool_name);
  if (!family) return {};
  const id = String(input.tool_use_id || "");
  if (!id) return {};
  withState(input.session_id, (state) => {
    const n = (state.counters[family] || 0) + 1;
    state.counters[family] = n;
    state.callPrefixes[id] = `${family}${n}`;
    log("call", id, "->", state.callPrefixes[id]);
  });
  return {};
}

async function onPostToolUse(input) {
  if (!CFG.templates) return {};
  const raw = resultText(input.tool_response);
  const news = parseNewsVars(raw);
  const family = toolFamily(input.tool_name);
  if (!news && !family) return {};
  const id = String(input.tool_use_id || "");
  const hint = withState(input.session_id, (state) => {
    let names = [];
    if (news) {
      for (const [name, value] of Object.entries(news.vars)) state.vars[name] = String(value);
      names = Object.keys(news.vars);
      log("vars +=", names.join(" "), "(news)");
    }
    if (family) {
      let prefix = state.callPrefixes[id];
      if (!prefix) {
        const n = (state.counters[family] || 0) + 1;
        state.counters[family] = n;
        prefix = `${family}${n}`;
      }
      delete state.callPrefixes[id];
      if (family === "bash") {
        const m = /^bash(\d+)$/.exec(prefix);
        if (m) state.turn.bashMax = Math.max(state.turn.bashMax || 0, Number(m[1]));
      }
      const pairs = varsForTool(input.tool_name, prefix, input.tool_input, raw, input.tool_response);
      if (pairs.length) {
        for (const [name, value] of pairs) state.vars[name] = value;
        if (!news) names = pairs.map(([n]) => n);
        log("vars +=", pairs.map(([n]) => n).join(" "));
      }
    }
    return names.length ? hintFor(names) : "";
  });
  return additional("PostToolUse", hint);
}

async function checkerDecision(input, state, deliverable) {
  if (!CFG.checker || !CHECK_FORMATS.has(state.turn.format)) return { notices: [] };
  const fmt = state.turn.format;
  const issue = formatIssue(deliverable, fmt);
  if (issue) {
    if ((state.turn.checkBlocks || 0) < CFG.checkRetries) {
      const reason =
        `The user-visible final answer is not valid ${fmt}: ${issue}. Re-emit the complete final ` +
        `answer with the deliverable corrected; change formatting only, never facts, names, ` +
        `numbers, or code semantics. Do not use placeholders inside the structured payload; use ` +
        `the exact recorded values there. Do not mention this instruction.`;
      withState(input.session_id, (st) => {
        st.turn.checkBlocks = (st.turn.checkBlocks || 0) + 1;
      });
      return {
        blockReason: reason,
        notices: [
          `**de-hallucination check**: final ${fmt} deliverable is invalid (${issue}); requested a corrected re-emission.`,
        ],
      };
    }
    return {
      notices: [
        `**de-hallucination check**: final ${fmt} deliverable is still invalid (${issue}). The reply is left unchanged.`,
      ],
    };
  }
  if ((state.turn.checkBlocks || 0) > 0) {
    return { notices: [`**de-hallucination check**: corrected ${fmt} deliverable is valid.`] };
  }
  return { notices: [] };
}

async function closerNotice(input, state, deliverable) {
  if (!CFG.closer || !CLOSE_FORMATS.has(state.turn.format) || !state.turn.prompt) return null;
  if (state.jevDown && Date.now() - state.jevDownSince > JEV_REPROBE_MS) {
    log("closer: jev was down at route time — re-probing");
    withState(input.session_id, (st) => {
      st.jevDown = false;
    });
    state.jevDown = false;
  }
  if (state.jevDown) return null;
  try {
    const verdict = await closingRound(state.turn.prompt, deliverable, state.turn.format);
    if (!verdict) return null;
    return truncateNotice(verdict);
  } catch (e) {
    if (e instanceof JevUnavailable) {
      withState(input.session_id, (st) => {
        st.jevDown = true;
        st.jevDownSince = Date.now();
      });
      log("closer skipped:", e.message);
      return null;
    }
    log("closer failed:", String(e));
    return null;
  }
}

async function onStop(input) {
  const deliverable = String(input.last_assistant_message || "");
  if (!deliverable.trim()) return {};
  const state = load(input.session_id);
  if (!state.turn || !state.turn.format) return {};

  // Analyze what the user will actually see. Rendering after validation can turn a
  // structurally valid payload into an invalid one when a value contains quotes/newlines.
  const rendered = CFG.templates
    ? renderTemplates(deliverable, state.vars)
    : { text: deliverable, replaced: [] };
  const analysisText = CFG.templates && CFG.renderMode !== "off" ? rendered.text : deliverable;

  const check = await checkerDecision(input, state, analysisText);
  if (check.blockReason) {
    return {
      decision: "block",
      reason: check.blockReason,
      ...(check.notices.length ? { systemMessage: check.notices.join("\n\n") } : {}),
    };
  }

  const notices = [...check.notices];
  let blockReason = "";

  const verdict = await closerNotice(input, state, analysisText);
  if (verdict) notices.push(`---\n${verdict}`);

  if (CFG.templates) {
    if (rendered.replaced.length && CFG.renderMode !== "off") {
      const willBlock = CFG.renderMode === "block" && (state.turn.renderBlocks || 0) < 1;
      if (willBlock) {
        blockReason =
          `Your final reply used template placeholders. Replace ${rendered.replaced
            .map((n) => `{${n}}`)
            .join(", ")} with the exact recorded values below and re-emit the complete final ` +
          `answer unchanged otherwise. Do not mention this instruction.\n\n${truncateNotice(
            rendered.text,
          )}`;
        notices.push(
          `**de-hallucination**: placeholders found (${rendered.replaced.join(", ")}); requested a corrected final reply.`,
        );
        withState(input.session_id, (st) => {
          st.turn.renderBlocks = (st.turn.renderBlocks || 0) + 1;
        });
      } else {
        notices.push(
          `---\n**de-hallucination rendered final reply** (recorded values for ${rendered.replaced.join(
            ", ",
          )}):\n\n${truncateNotice(rendered.text)}`,
        );
      }
    }
  }

  const guard = verificationGuard(analysisText, state.vars, state.turn.bashMax || 0);
  if (guard) notices.push(truncateNotice(guard));

  if (blockReason) {
    return {
      decision: "block",
      reason: blockReason,
      ...(notices.length ? { systemMessage: notices.join("\n\n") } : {}),
    };
  }
  if (notices.length) return { systemMessage: notices.join("\n\n") };
  return {};
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write("{}\n");
    return;
  }
  let output = {};
  try {
    switch (input.hook_event_name) {
      case "SessionStart":
        output = await onSessionStart(input);
        break;
      case "UserPromptSubmit":
        output = await onUserPromptSubmit(input);
        break;
      case "PreToolUse":
        output = await onPreToolUse(input);
        break;
      case "PostToolUse":
        output = await onPostToolUse(input);
        break;
      case "Stop":
        output = await onStop(input);
        break;
      default:
        output = {};
    }
  } catch (e) {
    log(`${input.hook_event_name} failed open:`, String(e));
    output = {};
  }
  process.stdout.write(JSON.stringify(output) + "\n");
}

if (require.main === module) {
  main().catch((e) => {
    log("fatal:", String(e));
    process.stdout.write("{}\n");
  });
}

module.exports = {
  buildPolicy,
  turnReminder,
  onSessionStart,
  onUserPromptSubmit,
  onPreToolUse,
  onPostToolUse,
  onStop,
};
