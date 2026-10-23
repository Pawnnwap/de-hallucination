"use strict";

const fs = require("fs");
const path = require("path");
const { CFG, log } = require("./config.cjs");

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const safeId = (id) => String(id || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);

function stateDir() {
  fs.mkdirSync(CFG.stateDir, { recursive: true });
  return CFG.stateDir;
}

const statePath = (sessionId) => path.join(stateDir(), `${safeId(sessionId)}.json`);
const lockPath = (sessionId) => path.join(stateDir(), `${safeId(sessionId)}.lock`);

function defaultState(sessionId) {
  const now = Date.now();
  return {
    version: 1,
    sessionId: String(sessionId || ""),
    createdAt: now,
    updatedAt: now,
    vars: {},
    counters: {},
    callPrefixes: {},
    // tool_use_ids already processed, so a doubly-wired hook cannot add a second
    // [vars: ...] trailer (and a second variable name) to the same tool result
    seenTools: {},
    jevDown: false,
    jevDownSince: 0,
    turn: {
      id: "",
      prompt: "",
      format: "chat",
      bashMax: 0,
      checkBlocks: 0,
      renderBlocks: 0,
    },
  };
}

function load(sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(sessionId), "utf8"));
    const base = defaultState(sessionId);
    return {
      ...base,
      ...parsed,
      vars: parsed.vars && typeof parsed.vars === "object" ? parsed.vars : {},
      counters: parsed.counters && typeof parsed.counters === "object" ? parsed.counters : {},
      callPrefixes:
        parsed.callPrefixes && typeof parsed.callPrefixes === "object" ? parsed.callPrefixes : {},
      seenTools: parsed.seenTools && typeof parsed.seenTools === "object" ? parsed.seenTools : {},
      turn: { ...base.turn, ...(parsed.turn || {}) },
    };
  } catch {
    return defaultState(sessionId);
  }
}

function save(sessionId, state) {
  state.updatedAt = Date.now();
  const target = statePath(sessionId);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, target);
}

function acquireLock(sessionId) {
  const lock = lockPath(sessionId);
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid));
      return () => {
        try { fs.closeSync(fd); } catch {}
        try { fs.unlinkSync(lock); } catch {}
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > 15000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {}
      if (Date.now() - started > 4000) {
        throw new Error(`state lock timeout for ${sessionId}`);
      }
      sleep(20);
    }
  }
}

function withState(sessionId, fn) {
  const release = acquireLock(sessionId);
  try {
    const state = load(sessionId);
    const result = fn(state);
    save(sessionId, state);
    return result;
  } finally {
    release();
  }
}

function resetTurn(state, turnId, prompt) {
  state.turn = {
    id: String(turnId || ""),
    prompt: String(prompt || ""),
    format: "chat",
    bashMax: 0,
    checkBlocks: 0,
    renderBlocks: 0,
  };
  state.callPrefixes = {};
}

function cleanupOldStates(maxAgeMs = 7 * 24 * 3600 * 1000) {
  try {
    const dir = stateDir();
    const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json") && !f.endsWith(".lock")) continue;
      const full = path.join(dir, f);
      try {
        if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.unlinkSync(full);
      } catch {}
    }
  } catch (e) {
    log("state cleanup failed:", String(e));
  }
}

module.exports = {
  stateDir,
  statePath,
  defaultState,
  load,
  save,
  withState,
  resetTurn,
  cleanupOldStates,
};
