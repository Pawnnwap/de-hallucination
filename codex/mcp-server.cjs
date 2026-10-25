#!/usr/bin/env node
"use strict";

const fs = require("fs");
const readline = require("readline");
const { CFG, log } = require("./lib/config.cjs");
const { jevDecide, JevUnavailable } = require("./lib/jev.cjs");
const { searchNews, newsBase, formatNewsResult } = require("./lib/news.cjs");

const TOOL_DEFS = [
  {
    name: "jev_decide",
    description:
      "Delegate a decision among 2-255 candidate choices (short stable key + what each means); returns the chosen key, a probability per choice and a confidence. Use it instead of guessing in prose.",
    inputSchema: {
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
    },
  },
  {
    name: "news_search",
    description:
      "Search a news archive for articles matching a query; returns the top matches with date, headline and body. Quote facts from its [vars: …] list as {name} placeholders.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms, e.g. 'Pulsegrid outage duration'" },
        limit: { type: "number", description: "Max matches (default 3, max 10)" },
        hours: { type: "number", description: "Only articles from the last N hours (time-sorted)" },
      },
      required: ["query"],
    },
  },
];

function enabledTools() {
  return TOOL_DEFS.filter((t) => (t.name === "jev_decide" ? CFG.decide : true));
}

function logWire(direction, message) {
  if (!CFG.debug || !process.env.DH_MCP_LOG) return;
  try {
    fs.appendFileSync(
      process.env.DH_MCP_LOG,
      JSON.stringify({ at: new Date().toISOString(), direction, message }) + "\n",
    );
  } catch {}
}

function send(message) {
  logWire("out", message);
  process.stdout.write(JSON.stringify(message) + "\n");
}

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const baseName = (name) => String(name || "").split("__").pop();

async function callJevDecide(args) {
  const choices = (Array.isArray(args.choices) ? args.choices : []).map((c) => ({
    key: String(c.key),
    description: String(c.description),
  }));
  if (choices.length < 2 || choices.length > 255) {
    return {
      isError: true,
      content: [{ type: "text", text: `jev_decide needs 2..255 choices, got ${choices.length}.` }],
    };
  }
  try {
    const d = await jevDecide(String(args.context || ""), choices);
    const dist = Object.entries(d.probabilities)
      .sort((a, b) => b[1] - a[1])
      .map(([k, p]) => `- ${k}: ${(p * 100).toFixed(1)}%`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Decision: ${d.choice} (confidence ${d.confidence.toFixed(2)})\n${dist}`,
        },
      ],
      structuredContent: d,
    };
  } catch (e) {
    const suffix = e instanceof JevUnavailable ? e.message : String(e);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `jev decision service unavailable (${suffix}). Make the decision yourself and say so.`,
        },
      ],
    };
  }
}

async function callNewsSearch(args) {
  const query = String(args.query || "");
  const limit = Math.min(10, Math.max(1, Number(args.limit) || 3));
  const hoursRaw = Number(args.hours);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? Math.min(24 * 30, hoursRaw) : null;
  const { hits, degraded, error } = await searchNews(query, limit, hours);
  if (!hits.length) {
    const text = error
      ? `News search unavailable (${error.slice(0, 120)}). The archive could not be reached — answer from your own knowledge and say so.`
      : `No news matches for "${query}". Try different terms.`;
    return { content: [{ type: "text", text }], isError: Boolean(error) };
  }
  const formatted = formatNewsResult(query, hits, newsBase(query), CFG.templates);
  return {
    content: [{ type: "text", text: formatted.text + degraded }],
    structuredContent: { query, hits: hits.map((h) => h.source), vars: formatted.vars },
  };
}

async function handleToolsCall(id, params) {
  const name = baseName(params && params.name);
  const args = (params && (params.arguments || params.args)) || {};
  if (name === "jev_decide" && CFG.decide) {
    reply(id, await callJevDecide(args));
    return;
  }
  if (name === "news_search") {
    reply(id, await callNewsSearch(args));
    return;
  }
  fail(id, -32602, `unknown tool: ${params && params.name}`);
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "dehall", version: "1.0.0" },
      instructions:
        "de-hallucination tools. Use jev_decide for calibrated decisions among candidates; use news_search for news questions and quote its returned [vars: …] placeholders.",
    });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    reply(id, { tools: enabledTools() });
    return;
  }
  if (method === "tools/call") {
    await handleToolsCall(id, params || {});
    return;
  }
  if (method === "resources/list") {
    reply(id, { resources: [] });
    return;
  }
  if (method === "resources/templates/list") {
    reply(id, { resourceTemplates: [] });
    return;
  }
  if (method === "resources/read") {
    reply(id, { contents: [] });
    return;
  }
  if (method === "prompts/list") {
    reply(id, { prompts: [] });
    return;
  }
  if (method === "logging/setLevel") {
    reply(id, {});
    return;
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (e) {
    log("invalid JSON-RPC line:", String(e).slice(0, 120));
    return;
  }
  logWire("in", message);
  handle(message).catch((e) => {
    log("request failed:", String(e));
    if (message && message.id !== undefined) fail(message.id, -32603, String(e));
  });
});
