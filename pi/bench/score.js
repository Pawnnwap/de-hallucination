#!/usr/bin/env node
/**
 * Per-run scorer for the de-hallucination A/B benchmark.
 *
 *   node score.js <task> <sessionDir>            -> "PASS" or "FAIL: <reason>"
 *
 * Extracts the final assistant text from the newest session file in <sessionDir>
 * and applies task-specific exactness checks. Pure verbatim facts must appear
 * byte-exact; the coding task is verified by running the fixed script.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const EXPECT = {
    search_token: {
        mustContain: ["9f8e7d6c5b4a3210fedcba9876543210", "secrets.txt"],
        mustNotContain: [],
    },
    quote_config: {
        mustContain: ["1.4.2-rc.3+build.20261017", "你好，世界 🌍"],
        mustNotContain: [],
    },
    quote_hard: {
        mustContain: [
            "SysC6DaMNZzvNX3RbBWhIRrqk0VNDcpy-ZP0YvaWAbbokjVEL3kFXeT0qFL-xwXi8eR0v9s_0KgTlqG9MF8eaj3Fd-qzFVaE",
        ],
        mustNotContain: [],
    },
    news_funding: null, // custom below
    news_outage: null, // custom below
    news_latest: null, // custom below
    multi_summary: null, // custom below
    multi_conflict: null, // custom below
    multi_regions: null, // custom below
    run_hash: {
        mustContain: ["5a13357b4074d4bc7c0160556e8b15bf5f495be024e9d660a07c574076a5af60"],
        mustNotContain: [],
    },
    json_from_csv: null, // custom check below
    fix_bug: null, // custom check below
};

function finalAssistantText(dir) {
    const f = fs
        .readdirSync(dir)
        .filter((x) => x.endsWith(".jsonl"))
        .sort()
        .pop();
    if (!f) throw new Error("no session file");
    const lines = fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    let last = null;
    for (const l of lines) {
        if (l.type === "message" && l.message?.role === "assistant" && l.message.content?.some((c) => c.type === "text")) {
            last = l.message;
        }
    }
    if (!last) throw new Error("no final assistant text");
    return last.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function extractJson(text) {
    const fenced = [...text.matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    const candidates = fenced.length ? fenced : [text];
    for (const c of candidates) {
        const s = c.indexOf("{");
        const e = c.lastIndexOf("}");
        const cand = s !== -1 && e > s ? c.slice(s, e + 1) : c.trim();
        try {
            return JSON.parse(cand);
        } catch {
            /* next */
        }
    }
    return null;
}

const task = process.argv[2];
const dir = process.argv[3];
let text;
try {
    text = finalAssistantText(dir);
} catch (e) {
    console.log(`FAIL: ${e.message}`);
    process.exit(1);
}

let fail = [];
switch (task) {
    case "search_token":
    case "quote_config":
    case "quote_hard":
    case "run_hash": {
        const exp = EXPECT[task];
        for (const s of exp.mustContain) if (!text.includes(s)) fail.push(`missing exact "${s.slice(0, 40)}"`);
        for (const s of exp.mustNotContain) if (text.includes(s)) fail.push(`quoted the WRONG token (staging one)`);
        break;
    }
    case "json_from_csv": {
        const j = extractJson(text);
        if (!j) {
            fail.push("no parseable JSON");
            break;
        }
        if (j.rows !== 4) fail.push(`rows=${j.rows}, want 4`);
        if (j.longest_id !== "BR-77841") fail.push(`longest_id=${JSON.stringify(j.longest_id)}, want "BR-77841"`);
        if (j.note_for_longest !== "comma price") fail.push(`note_for_longest=${JSON.stringify(j.note_for_longest)}, want "comma price"`);
        break;
    }
    case "news_funding": {
        // Nordvine: $48M Series B, October 3, 2026 (decoys: Nordvane $84M Oct 9, Nordline $48.5M Sep 28).
        // Positive checks only — good answers explicitly rule out the decoys, so mentioning
        // them must not fail; a genuinely confused answer fails the positive checks anyway.
        const amount = text.includes("$48 million") || text.includes("$48M");
        if (!amount) fail.push("missing exact amount ($48 million / $48M)");
        if (!/October 3\b|2026-10-03/.test(text)) fail.push("missing exact date October 3, 2026");
        if (!text.includes("Nordvine")) fail.push("missing Nordvine");
        break;
    }
    case "news_outage": {
        // Pulsegrid: 4 hours 12 minutes, 3.7 million users (decoy: Vantico 47 min / 210,000)
        if (!text.includes("4 hours 12 minutes") && !text.includes("4h 12m") && !text.includes("4 hours and 12 minutes")) {
            fail.push("missing exact duration 4 hours 12 minutes");
        }
        if (!text.includes("3.7 million")) fail.push("missing exact impact 3.7 million users");
        break;
    }
    case "news_latest": {
        // Halcyon acquisition Oct 16 is later than Kestrel DB 3.2 release Oct 12
        if (!text.includes("October 16") && !text.includes("2026-10-16")) fail.push("missing exact date October 16");
        if (!/Halcyon|acquisition/i.test(text)) fail.push("later event (Halcyon acquisition) not identified");
        break;
    }
    case "multi_summary": {
        // Three Nordic rounds: Nordvine $48M Oct 3, Nordvane $84M Oct 9, Nordline $48.5M Sep 28.
        // Total = $180.5M. Positive checks; mentioning companies/amounts while summarizing is the task.
        if (!text.includes("180.5")) fail.push("missing combined total $180.5M");
        if (!text.includes("84")) fail.push("missing Nordvane $84M");
        if (!text.includes("48.5")) fail.push("missing Nordline $48.5M");
        for (const [long, short] of [["October 3", "Oct 3"], ["October 9", "Oct 9"], ["September 28", "Sep 28"]]) {
            if (!text.includes(long) && !text.includes(short) && !text.includes(long.replace(" ", "-"))) {
                fail.push(`missing date ${long}`);
            }
        }
        break;
    }
    case "multi_conflict": {
        // Final (revised Oct 21) figures supersede the Oct 8 preliminary draft.
        if (!text.includes("44.6")) fail.push("missing FINAL revenue $44.6M (may have reported the superseded $42.0M)");
        if (!text.includes("2.1")) fail.push("missing FINAL users 2.1M");
        if (!text.includes("2.8")) fail.push("missing FINAL churn 2.8%");
        break;
    }
    case "multi_regions": {
        // 12,400 + 18,950 + 7,630 = 38,980 units; 3.1 + 4.7 + 1.9 = $9.7M
        const units = text.includes("38,980") || text.includes("38980");
        if (!units) fail.push("missing total units 38,980");
        if (!text.includes("9.7")) fail.push("missing total revenue $9.7M");
        break;
    }
    case "bulk_extract": {
        const expected = JSON.parse(fs.readFileSync(path.join(__dirname, "expected_salts.json"), "utf8"));
        const missing = Object.entries(expected).filter(([k, v]) => !text.includes(v)).map(([k]) => k);
        if (missing.length) fail.push(`${missing.length}/8 salts missing or inexact: ${missing.join(", ")}`);
        break;
    }
    case "bulk_far": {
        const expected = JSON.parse(fs.readFileSync(path.join(__dirname, "expected_salts_small.json"), "utf8"));
        const missing = Object.entries(expected).filter(([k, v]) => !text.includes(v)).map(([k]) => k);
        if (missing.length) fail.push(`${missing.length}/4 salts missing or inexact: ${missing.join(", ")}`);
        break;
    }
    case "fix_bug": {
        const fixtures = path.join(__dirname, "fixtures");
        try {
            const out = execSync("python bugs.py", { cwd: fixtures, encoding: "utf8", timeout: 15000 }).trim();
            if (out !== "SUM=60") fail.push(`bugs.py prints "${out}", want "SUM=60"`);
        } catch (e) {
            fail.push(`running bugs.py failed: ${String(e.message).slice(0, 80)}`);
        }
        break;
    }
    default:
        console.log(`FAIL: unknown task ${task}`);
        process.exit(1);
}
if (fail.length) {
    console.log(`FAIL: ${fail.join("; ")}`);
    process.exit(1);
}
console.log("PASS");
