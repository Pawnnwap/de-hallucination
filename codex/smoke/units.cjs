#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dehall-units-"));
const newsDir = path.resolve(__dirname, "..", "..", "pi", "bench", "fixtures", "news");
process.env.DH_CODEX_STATE_DIR = stateDir;
process.env.DH_NEWS_DIR = newsDir;

const { renderTemplates, formatIssue, validateFormat, extractJsonCandidate, resultText, varsForTool, verificationGuard } =
  require("../lib/text.cjs");
const { extractOptions } = require("../lib/jev.cjs");
const { withState, load, resetTurn } = require("../lib/state.cjs");
const { searchLocalCorpus, formatNewsResult, parseNewsVars } = require("../lib/news.cjs");
const { buildPolicy } = require("../hooks.cjs");

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("check() received a promise");
    if (r === false) throw new Error("check() returned false");
    pass++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL: ${name} — ${String(e.message || e).slice(0, 240)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL: ${name} — ${String(e.message || e).slice(0, 240)}`);
  }
}

const hook = (event, env = {}) =>
  JSON.parse(
    execFileSync(process.execPath, [path.join(__dirname, "..", "hooks.cjs")], {
      input: JSON.stringify(event),
      env: { ...process.env, ...env },
      encoding: "utf8",
    }),
  );

(async () => {
  check("render substitutes known vars byte-exact", () => {
    const vars = { read1_path: "E:/x/notes.txt", bash1_out: "OK-73" };
    const out = renderTemplates("path {read1_path} out {bash1_out}", vars);
    assert.equal(out.text, "path E:/x/notes.txt out OK-73");
    assert.deepEqual(out.replaced, ["read1_path", "bash1_out"]);
  });

  check("render leaves unknown braces and code untouched", () => {
    const vars = { bash1_out: "OK" };
    const src = "braces {not_a_var} code {x.done} {bash1_out}";
    assert.equal(renderTemplates(src, vars).text, "braces {not_a_var} code {x.done} OK");
  });

  check("render strips echoed hint lines", () => {
    const src = "[vars: bash1_out] — quote these\nanswer {bash1_out}\nDEHALL_VARS {\"x\":1}";
    assert.equal(renderTemplates(src, { bash1_out: "OK" }).text, "answer OK");
  });

  check("render collapses a retyped copy next to its placeholder", () => {
    const vars = { read1_path: "notes.txt", bash2_exit: "1" };
    // byte-equal backticked copy, drifted backticked copy, bare byte-equal copy
    assert.equal(
      renderTemplates("**File path read:** `{read1_path}` → `notes.txt`", vars).text,
      "**File path read:** `notes.txt`",
    );
    assert.equal(renderTemplates("exit was `{bash2_exit}` → `0`", vars).text, "exit was `1`");
    assert.equal(
      renderTemplates("plain {read1_path} -> notes.txt end", vars).text,
      "plain notes.txt end",
    );
    assert.equal(
      renderTemplates('Version: {bash3_out} -> "Python 3.13.14".', { bash3_out: "Python 3.13.14\n" }).text,
      "Version: Python 3.13.14.",
    );
    assert.equal(renderTemplates("bad: {bash4_out} -> '0.1'", { bash4_out: "9.9" }).text, "bad: 9.9");
  });

  check("render promotes a multi-line value to a block and dedupes the retyped fence", () => {
    const vars = { read1_content: "first line with unusual-tokens_XY73\nsecond line\n" };
    const src = [
      "**File content (lines):** `{read1_content}` → two lines:",
      "```",
      "first line with unusual-tokens_XY73",
      "second line",
      "```",
    ].join("\n");
    const want = [
      "**File content (lines):** two lines:",
      "",
      "```",
      "first line with unusual-tokens_XY73",
      "second line",
      "```",
    ].join("\n");
    const out = renderTemplates(src, vars);
    assert.equal(out.text, want);
    assert.deepEqual(out.replaced, ["read1_content"]);
  });

  check("render keeps fence substitution byte-exact, inline substitution boundary-trimmed", () => {
    const vars = { write1_content: '{"a": 1}\n', bash1_out: "Python 3.13.14\n" };
    assert.equal(renderTemplates("```json\n{write1_content}\n```", vars).text, '```json\n{"a": 1}\n\n```');
    assert.equal(renderTemplates("out: {bash1_out} done", vars).text, "out: Python 3.13.14 done");
  });

  check("JSON array is valid deliverable", () => {
    assert.equal(validateFormat("```json\n[1,2]\n```", "json"), true);
    assert.equal(validateFormat('prefix {"ok":true} suffix', "json"), true);
    assert.equal(validateFormat("not json", "json"), false);
  });

  check("format issues are specific", () => {
    assert.match(formatIssue("not json", "json"), /JSON\.parse failed/);
    assert.match(formatIssue("```js\nx\n", "code"), /unbalanced/);
    assert.equal(formatIssue("a: 1\nb: 2\n", "yaml"), null);
    assert.equal(formatIssue("a,b\n1,2\n", "csv"), null);
  });

  check("json candidate extraction prefers outer span", () => {
    assert.equal(extractJsonCandidate('x {"a":1} y'), '{"a":1}');
  });

  check("choice extraction finds named alternatives", () => {
    const choices = extractOptions("Which is better for quick scripts: Python or Bash? Pick one.");
    assert.deepEqual(choices.map((c) => c.key), ["python", "bash"]);
    assert.equal(extractOptions("Summarize this report."), null);
  });

  check("verification guard flags success claims after errors", () => {
    const vars = { bash1_out: "Traceback (most recent call last):\nboom", bash1_cmd: "python bad.py" };
    assert.match(verificationGuard("I verified the fix works.", vars, 1), /de-hallucination check/);
    assert.equal(verificationGuard("Here is the error output.", vars, 1), null);
  });

  check("bash vars capture command and output", () => {
    const pairs = varsForTool("Bash", "bash1", { command: "echo hi" }, "hi\r\n", "hi\r\n");
    assert.deepEqual(Object.fromEntries(pairs), { bash1_cmd: "echo hi", bash1_out: "hi\r\n" });
  });

  check("apply_patch vars extract path and diff", () => {
    const input = { patch: "*** Begin Patch\n*** Update File: notes.txt\n@@\n-a\n+b\n*** End Patch" };
    const pairs = Object.fromEntries(varsForTool("apply_patch", "edit1", input, "Success", "Success"));
    assert.equal(pairs.edit1_path, "notes.txt");
    assert.match(pairs.edit1_patch, /Update File/);
    assert.equal(pairs.edit1_diff, "Success");
  });

  check("tool_response object text extraction", () => {
    assert.equal(resultText({ output: "out" }), "out");
    assert.equal(resultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\nb");
  });

  check("state roundtrip keeps vars and resets turn", () => {
    withState("unit-session", (st) => {
      resetTurn(st, "t1", "prompt");
      st.vars.bash1_out = "OK";
      st.turn.format = "binary";
    });
    withState("unit-session", (st) => {
      resetTurn(st, "t2", "next");
    });
    const st = load("unit-session");
    assert.equal(st.vars.bash1_out, "OK");
    assert.equal(st.turn.format, "chat");
    assert.equal(st.turn.id, "t2");
  });

  await checkAsync("local news corpus finds the right company", async () => {
    const hits = await searchLocalCorpus("Nordvine funding round", 3);
    assert.ok(hits.length >= 1);
    assert.match(hits[0].source, /nordvine/);
  });

  check("news vars marker roundtrip", () => {
    const { text } = formatNewsResult(
      "Nordvine",
      [{ source: "x", date: "2026-01-01", title: "T", text: "B" }],
      "news42",
    );
    const parsed = parseNewsVars(text);
    assert.equal(parsed.base, "news42");
    assert.equal(parsed.vars.news42_r1_title, "T");
  });

  check("policy mentions the CLI mechanisms and compact quoting", () => {
    const p = buildPolicy();
    assert.match(p, /Verbatim quoting policy/);
    assert.match(p, /write the \{name\}/);
    assert.match(p, /placeholder alone/);
    assert.match(p, /fenced code block/);
    assert.match(p, /other\s+braces\s+pass\s+through/);
    assert.match(p, /vars-list/);
    assert.match(p, /cli\.cjs/);
    assert.match(p, /jev-decide/);
    assert.match(p, /news-search/);
  });

  await checkAsync("CLI news-search returns hits and vars", async () => {
    const out = execFileSync(
      process.execPath,
      [path.join(__dirname, "..", "cli.cjs"), "news-search", "Nordvine funding round", "--limit", "2"],
      { env: { ...process.env, DH_NEWS_DIR: newsDir }, encoding: "utf8" },
    );
    assert.match(out, /Nordvine/i);
    assert.match(out, /DEHALL_VARS/);
  });

  await checkAsync("hook pipeline captures vars and renders them at Stop", async () => {
    const sid = "hook-" + process.pid;
    const common = { DH_DISABLE_ROUTER: "1" };
    const session = hook(
      { hook_event_name: "SessionStart", session_id: sid, source: "startup", cwd: process.cwd(), model: "chat" },
      common,
    );
    assert.match(session.hookSpecificOutput.additionalContext, /Verbatim quoting policy/);
    const prompt = hook(
      { hook_event_name: "UserPromptSubmit", session_id: sid, turn_id: "turn-1", prompt: "read notes", cwd: process.cwd() },
      common,
    );
    // No per-turn reminder by default: the session policy already carries the rules, and a
    // per-turn reminder is extra bytes inside the remote's cached prompt prefix.
    assert.equal(prompt.hookSpecificOutput, undefined);
    const promptWithReminder = hook(
      { hook_event_name: "UserPromptSubmit", session_id: sid, turn_id: "turn-2", prompt: "read notes", cwd: process.cwd() },
      { ...common, DH_CODEX_TURN_REMINDER: "1" },
    );
    assert.match(promptWithReminder.hookSpecificOutput.additionalContext, /de-hallucination/);
    hook(
      {
        hook_event_name: "PreToolUse",
        session_id: sid,
        turn_id: "turn-1",
        tool_name: "Bash",
        tool_use_id: "call-1",
        tool_input: { command: "Get-Content notes.txt" },
        cwd: process.cwd(),
      },
      common,
    );
    const post = hook(
      {
        hook_event_name: "PostToolUse",
        session_id: sid,
        turn_id: "turn-1",
        tool_name: "Bash",
        tool_use_id: "call-1",
        tool_input: { command: "Get-Content notes.txt" },
        tool_response: "unusual-tokens_XY73\r\n",
        cwd: process.cwd(),
      },
      common,
    );
    // The hint no longer rides as additionalContext: a mid-conversation developer item
    // re-renders the remote model's prompt prefix and drops its KV cache. The names are
    // recorded in state; the session policy and the vars-list CLI carry the contract.
    assert.deepEqual(post, {});
    const postState = load(sid);
    assert.equal(postState.vars.bash1_cmd, "Get-Content notes.txt");
    assert.equal(postState.vars.bash1_out, "unusual-tokens_XY73\r\n");
    const stop = hook(
      {
        hook_event_name: "Stop",
        session_id: sid,
        turn_id: "turn-1",
        last_assistant_message: "The exact output is {bash1_out}",
        stop_hook_active: false,
        cwd: process.cwd(),
      },
      common,
    );
    assert.match(stop.systemMessage, /rendered final reply/);
    assert.match(stop.systemMessage, /unusual-tokens_XY73/);
    assert.ok(!stop.systemMessage.includes("{bash1_out}"));
  });

  await checkAsync("Bash CLI news output becomes vars and renders at Stop", async () => {
    const sid = "news-hook-" + process.pid;
    const common = { DH_DISABLE_ROUTER: "1", DH_NEWS_DIR: newsDir };
    const cliOut = execFileSync(
      process.execPath,
      [path.join(__dirname, "..", "cli.cjs"), "news-search", "Nordvine funding round", "--limit", "1"],
      { env: { ...process.env, DH_NEWS_DIR: newsDir }, encoding: "utf8" },
    );
    hook(
      { hook_event_name: "UserPromptSubmit", session_id: sid, turn_id: "tn", prompt: "news?", cwd: process.cwd() },
      common,
    );
    hook(
      {
        hook_event_name: "PreToolUse",
        session_id: sid,
        turn_id: "tn",
        tool_name: "Bash",
        tool_use_id: "call-news",
        tool_input: { command: "node codex/cli.cjs news-search ..." },
        cwd: process.cwd(),
      },
      common,
    );
    const post = hook(
      {
        hook_event_name: "PostToolUse",
        session_id: sid,
        turn_id: "tn",
        tool_name: "Bash",
        tool_use_id: "call-news",
        tool_input: { command: "node codex/cli.cjs news-search ..." },
        tool_response: cliOut,
        cwd: process.cwd(),
      },
      common,
    );
    const newsState = load(sid);
    const name = Object.keys(newsState.vars).find((n) => /news\d+_r1_date/.test(n));
    assert.ok(name, "news vars captured in state");
    const stop = hook(
      {
        hook_event_name: "Stop",
        session_id: sid,
        turn_id: "tn",
        last_assistant_message: `The date is {${name}}.`,
        stop_hook_active: false,
        cwd: process.cwd(),
      },
      common,
    );
    assert.match(stop.systemMessage, /2026-10-03/);
    assert.ok(!stop.systemMessage.includes(`{${name}}`));
  });

  await checkAsync("DH_CODEX_RENDER=block requests one corrected reply", async () => {    const sid = "render-block-" + process.pid;
    const common = { DH_DISABLE_ROUTER: "1", DH_CODEX_RENDER: "block" };
    hook(
      { hook_event_name: "UserPromptSubmit", session_id: sid, turn_id: "tr", prompt: "value?", cwd: process.cwd() },
      common,
    );
    hook(
      {
        hook_event_name: "PreToolUse",
        session_id: sid,
        turn_id: "tr",
        tool_name: "Bash",
        tool_use_id: "call-rb",
        tool_input: { command: "echo OK-73" },
        cwd: process.cwd(),
      },
      common,
    );
    hook(
      {
        hook_event_name: "PostToolUse",
        session_id: sid,
        turn_id: "tr",
        tool_name: "Bash",
        tool_use_id: "call-rb",
        tool_input: { command: "echo OK-73" },
        tool_response: "OK-73\n",
        cwd: process.cwd(),
      },
      common,
    );
    const stop = hook(
      {
        hook_event_name: "Stop",
        session_id: sid,
        turn_id: "tr",
        last_assistant_message: "value {bash1_out}",
        stop_hook_active: false,
        cwd: process.cwd(),
      },
      common,
    );
    assert.equal(stop.decision, "block");
    assert.match(stop.reason, /OK-73/);
    // The block reason goes into the model's input and stays in the thread, so the
    // inlined payload is capped (DH_CODEX_RENDER_PAYLOAD, default 2000 chars).
    const longSid = "render-cap-" + process.pid;
    const capCommon = { ...common, DH_CODEX_RENDER_PAYLOAD: "120" };
    hook(
      { hook_event_name: "UserPromptSubmit", session_id: longSid, turn_id: "tr", prompt: "value?", cwd: process.cwd() },
      capCommon,
    );
    hook(
      {
        hook_event_name: "PreToolUse",
        session_id: longSid,
        turn_id: "tr",
        tool_name: "Bash",
        tool_use_id: "call-rc",
        tool_input: { command: "echo " + "Z".repeat(500) },
        cwd: process.cwd(),
      },
      capCommon,
    );
    hook(
      {
        hook_event_name: "PostToolUse",
        session_id: longSid,
        turn_id: "tr",
        tool_name: "Bash",
        tool_use_id: "call-rc",
        tool_input: { command: "echo " + "Z".repeat(500) },
        tool_response: "Z".repeat(500),
        cwd: process.cwd(),
      },
      capCommon,
    );
    const capped = hook(
      {
        hook_event_name: "Stop",
        session_id: longSid,
        turn_id: "tr",
        last_assistant_message: "value {bash1_out}",
        stop_hook_active: false,
        cwd: process.cwd(),
      },
      capCommon,
    );
    assert.equal(capped.decision, "block");
    assert.ok(capped.reason.length < 400, `block reason not capped: ${capped.reason.length} chars`);
    assert.match(capped.reason, /truncated/);
    const stop2 = hook(
      {
        hook_event_name: "Stop",
        session_id: sid,
        turn_id: "tr",
        last_assistant_message: "value OK-73",
        stop_hook_active: true,
        cwd: process.cwd(),
      },
      common,
    );
    assert.ok(!stop2.decision);
  });

  await checkAsync("Stop checker validates rendered text, not raw placeholders", async () => {
    const sid = "checker-render-" + process.pid;
    withState(sid, (st) => {
      resetTurn(st, "tx", "Give me JSON");
      st.turn.format = "json";
      st.vars.bash1_out = 'a"b';
    });
    const stop = hook(
      {
        hook_event_name: "Stop",
        session_id: sid,
        turn_id: "tx",
        last_assistant_message: '{"x":"{bash1_out}"}',
        stop_hook_active: false,
        cwd: process.cwd(),
      },
      { DH_DISABLE_ROUTER: "1" },
    );
    assert.equal(stop.decision, "block");
    assert.match(stop.reason, /not valid json/);
    assert.match(stop.reason, /user-visible final answer/);
  });

  await checkAsync("Stop checker blocks once, then accepts the corrected JSON", async () => {
    const sid = "check-" + process.pid;
    withState(sid, (st) => {
      resetTurn(st, "tj", "Give me JSON");
      st.turn.format = "json";
    });
    const base = {
      hook_event_name: "Stop",
      session_id: sid,
      turn_id: "tj",
      stop_hook_active: false,
      cwd: process.cwd(),
    };
    const bad = hook({ ...base, last_assistant_message: "not json" }, { DH_DISABLE_ROUTER: "1" });
    assert.equal(bad.decision, "block");
    assert.match(bad.reason, /not valid json/);
    const good = hook(
      { ...base, last_assistant_message: '{"ok":true}', stop_hook_active: true },
      { DH_DISABLE_ROUTER: "1" },
    );
    assert.ok(!good.decision);
    assert.match(good.systemMessage, /corrected json deliverable is valid/);
  });

  await checkAsync("MCP server handshake, tool list and news call", async () => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "mcp-server.cjs")], {
      env: { ...process.env, DH_NEWS_DIR: newsDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending = new Map();
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const resolver = pending.get(msg.id);
        if (resolver) {
          pending.delete(msg.id);
          resolver(msg);
        }
      }
    });
    let nextId = 1;
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`MCP timeout on ${method}`)), 10000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    try {
      const init = await rpc("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "dehall-test", version: "1" },
      });
      assert.equal(init.serverInfo.name, "dehall");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const list = await rpc("tools/list", {});
      const names = list.tools.map((t) => t.name);
      assert.ok(names.includes("jev_decide"));
      assert.ok(names.includes("news_search"));
      const news = await rpc("tools/call", {
        name: "news_search",
        arguments: { query: "Nordvine funding round", limit: 2 },
      });
      const text = news.content.map((c) => c.text).join("\n");
      assert.match(text, /Nordvine|nordvine/i);
      assert.match(text, /DEHALL_VARS/);
    } finally {
      child.kill();
    }
  });


  const gates = require("../lib/jev.cjs");
  check("maskEvidence redacts numbers and keeps prose", () => {
    assert.equal(gates.maskEvidence("Spearman -0.989, 3/19 rising"), "Spearman -[#], [#] rising");
    assert.equal(gates.maskEvidence("levels 1,2,3 and 42%"), "levels [#] and [#]%");
    assert.equal(gates.maskEvidence("no digits here"), "no digits here");
  });
  check("topProb reads the sharpest cell", () => {
    assert.equal(gates.topProb({ a: 0.31, b: 0.44, c: 0.25 }).toFixed(2), "0.44");
    assert.equal(gates.topProb({}), 0);
  });
  check("floorReason gates a flat binary", () => {
    assert.match(gates.floorReason("binary", { noul: 0.52 }), /below/);
    assert.equal(gates.floorReason("binary", { noul: 0.62 }), "");
  });
  check("floorReason gates a flat choice", () => {
    assert.match(gates.floorReason("choice", { probabilities: { x: 0.315, y: 0.276, z: 0.23, w: 0.179 } }), /top-p/);
    assert.equal(gates.floorReason("choice", { probabilities: { x: 0.674, y: 0.22, z: 0.106 } }), "");
  });
  check("the closing notice is only the choices with their probabilities", () => {
    assert.equal(gates.distLine({ noul: 0.895 }), "yes 89.5%, no 10.5%");
    assert.equal(gates.fmtProbs({ no: 0.895, yes: 0.105 }), "no 89.5%, yes 10.5%");
    assert.equal(gates.distLine({}), "");
    return gates.abstain("binary", "|p-0.5|=0.020 below 0.1", { noul: 0.52 }) === undefined;
  });
  check("options: four-item list keeps all four labels", () => {
    const r = extractOptions("Which candidate failed: jiban_factor, min_lot_ratio_ts_demean40, peak_ratio_diff or sqw_rangemed_40?");
    return !!r && r.length === 4 && r[0].key === "jiban_factor" && r[3].key === "sqw_rangemed_40";
  });
  check("options: colon list with no 'or'", () => {
    const r = extractOptions("Pick one: Python, Bash, Julia, R.");
    return !!r && r.map((o) => o.key).join(",") === "python,bash,julia,r";
  });
  check("options: prose with no list stays null", () => extractOptions("Is the file longer than 100 lines?") === null);
  check("options: live form with a trailing clause keeps 4 labels", () => {
    const r = extractOptions("Recorded scan: jiban_factor Spearman -0.989 with 3/19 rising; min_lot +0.992. Pick exactly one of: jiban_factor, min_lot_ratio_ts_demean40, peak_ratio_diff, sqw_rangemed_40 - the one that failed monotonicity.");
    return !!r && r.length === 4 && r[3].key === "sqw_rangemed_40";
  });
  check("options: semicolon list", () => {
    const r = extractOptions("Choose an engine: vllm; llama.cpp; transformers.");
    return !!r && r.map((o) => o.key).join(",") === "vllm,llama.cpp,transformers";
  });
  check("twinFrame masks numbers then caps each message", () => {
      const st = [{ role: "user", content: "spearman 0.989 " + "x ".repeat(2000) }, { role: "assistant", content: "pick 3" }];
      const f = gates.twinFrame(st, 500);
      return !!f && f.every((m) => m.content.length <= 500) && /\[#\]/.test(f[0].content) && !/0\.989/.test(f[0].content);
    });
    check("twinFrame returns null when there is nothing to ablate", () =>
      gates.twinFrame([{ role: "user", content: "no digits in this request at all" }], 4000) === null);
  check("twinFrame keeps the shared system preamble byte-identical", () => {
    const st = [
      { role: "system", content: gates.JUDGE_PREAMBLE },
      { role: "user", content: "IC 0.061 in 2026Q3" },
    ];
    const f = gates.twinFrame(st, 4000);
    return !!f && f[0].content === gates.JUDGE_PREAMBLE && /\[#\]/.test(f[1].content) && !/0\.061/.test(f[1].content);
  });
  await checkAsync("router sends only the user message; closing and twin share a byte-stable prefix", async () => {
    const http = require("http");
    const frames = [];
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        frames.push(body.state);
        const answers = {};
        for (const [qid, q] of Object.entries(body.questions || {})) {
          answers[qid] =
            q.type === "noul"
              ? { type: "noul", noul: 0.85 }
              : { type: "choice", choice: "binary", probabilities: { binary: 0.8, chat: 0.2 }, confidence: 0.8 };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers }));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const env = { DH_JEV_URL: `http://127.0.0.1:${srv.address().port}`, DH_JEV_TIMEOUT_MS: "2000" };
    // async spawn: the stub server lives in this process and must stay unblocked
    const runHook = (event) =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [path.join(__dirname, "..", "hooks.cjs")], {
          env: { ...process.env, ...env },
        });
        let out = "";
        p.stdout.on("data", (c) => (out += c));
        p.on("error", reject);
        p.on("close", () => resolve(out));
        p.stdin.write(JSON.stringify(event));
        p.stdin.end();
      });
    try {
      await runHook({
        hook_event_name: "UserPromptSubmit",
        session_id: "frame-test",
        turn_id: "t1",
        prompt: "Is the IC 0.061 monotonic in 2026Q3? yes or no?",
      });
      await runHook({
        hook_event_name: "Stop",
        session_id: "frame-test",
        turn_id: "t1",
        last_assistant_message: "Yes - the IC 0.061 curve is monotonic in 2026Q3.",
      });
    } finally {
      srv.close();
    }
    assert.ok(frames.length >= 3, `expected router+closing+twin frames, got ${frames.length}`);
    // The router sends the user message alone: no session-start system message, no agent
    // wrapper (state is a bare string). The framing that used to open this frame was the
    // biggest, coldest part of the first judge call of a turn.
    assert.equal(
      typeof frames[0],
      "string",
      `router state must be the bare user message, got ${typeof frames[0]}`,
    );
    assert.equal(
      frames[0],
      "Is the IC 0.061 monotonic in 2026Q3? yes or no?",
      "router must send exactly the user message",
    );
    // Closing and ablation-twin frames keep the shared byte-stable preamble, so those two
    // calls still reuse each other's prefix on the judge side.
    const judgeFrames = frames.slice(1);
    for (const st of judgeFrames) {
      assert.equal(st[0].role, "system");
      assert.ok(
        String(st[0].content).startsWith(gates.JUDGE_PREAMBLE),
        "every closing/twin judge frame must open with the shared preamble",
      );
    }
    const ser = (s) => JSON.stringify(s);
    const lcp = (a, b) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return i;
    };
    for (let i = 1; i < judgeFrames.length; i++) {
      assert.ok(
        lcp(ser(judgeFrames[i - 1]), ser(judgeFrames[i])) >= ser([{ role: "system", content: gates.JUDGE_PREAMBLE }]).length - 3,
        `judge frames ${i - 1}/${i} lost the shared prefix`,
      );
    }
  });
  check("tvDistance is symmetric and bounded", () => {
    const d = gates.tvDistance({ a: 0.5, b: 0.5 }, { a: 0.9, b: 0.1 });
    return Math.abs(d - 0.4) < 1e-9 && gates.tvDistance({ a: 1 }, { a: 1 }) === 0;
  });
  await checkAsync("gateVerdict publishes a sharp, evidence-bound verdict", async () => {
    const g = await gates.gateVerdict("binary", { noul: 0.91 }, async () => 0.42);
    assert.equal(g, true);
  });
  await checkAsync("gateVerdict abstains when the masked twin barely moves", async () => {
    const g = await gates.gateVerdict("binary", { noul: 0.62 }, async () => 0.03);
    assert.equal(g, false);
  });
  await checkAsync("gateVerdict floor beats ablation", async () => {
    const g = await gates.gateVerdict("choice", { probabilities: { a: 0.315, b: 0.276, c: 0.22, d: 0.189 } }, async () => 0.40);
    assert.equal(g, false);
  });
  await checkAsync("gateVerdict skips ablation when there are no numbers to mask", async () => {
    const g = await gates.gateVerdict("binary", { noul: 0.62 }, async () => null);
    assert.equal(g, true);
  });

  // A doubly-wired PostToolUse hook (hooks in both config.toml and a legacy hooks.json)
  // must not add a second [vars: ...] trailer to the same tool result: the trailer lives
  // in the prompt the remote model caches, and a duplicate also allocates a second name.
  await checkAsync("PostToolUse is idempotent per tool_use_id", async () => {
    const sid = "dup-" + process.pid;
    const common = { DH_DISABLE_ROUTER: "1" };
    const call = {
      hook_event_name: "PostToolUse",
      session_id: sid,
      turn_id: "t",
      tool_name: "Bash",
      tool_use_id: "call-dup",
      tool_input: { command: "echo OK-73" },
      tool_response: "OK-73\n",
      cwd: process.cwd(),
    };
    const first = hook(call, common);
    const second = hook(call, common);
    assert.deepEqual(first, {});
    assert.deepEqual(second, {});
    // The names were allocated exactly once (no second variable name).
    const dupState = load(sid);
    assert.equal(dupState.vars.bash1_cmd, "echo OK-73");
    assert.ok(!dupState.vars.bash2_cmd);
  });

  // Codex >= 0.163 reads hooks from config.toml; installing twice must not leave two
  // copies of every hook table behind (that would run each hook twice).
  check("installer writes hooks into config.toml and stays idempotent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dehall-install-"));
    const install = path.join(__dirname, "..", "install.cjs");
    execFileSync(process.execPath, [install, dir], { encoding: "utf8" });
    execFileSync(process.execPath, [install, dir], { encoding: "utf8" });
    const cfg = fs.readFileSync(path.join(dir, ".codex", "config.toml"), "utf8");
    assert.equal((cfg.match(/\[\[hooks\.\w+\]\]/g) || []).length, 5);
    assert.equal((cfg.match(/hooks\.cjs/g) || []).length, 5);
    assert.ok(!fs.existsSync(path.join(dir, ".codex", "hooks.json")));
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  });

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
