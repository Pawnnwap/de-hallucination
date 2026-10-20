#!/usr/bin/env node
/**
 * Deterministic unit checks for the de-hallucination extension helpers.
 *
 *   node pi/smoke/units.js     -> "PASS: <check>" / "FAIL: <check>", exit 1 on any failure
 *
 * These cover the pure guardrails (template rendering, JSON payload extraction,
 * format validation, verification guard, env parsing, var capture) with no LLM/jev
 * dependency, so regressions surface without a full smoke run.
 */
(async () => {
    const { __internals: I } = await import("../index.ts");
    let pass = 0;
    let fail = 0;
    const check = (name, ok, detail) => {
        if (ok) {
            pass++;
            console.log(`PASS: ${name}`);
        } else {
            fail++;
            console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
        }
    };

    // 1. template rendering: substitution, unknown names pass through byte-identical
    {
        const vars = new Map([
            ["read1_path", "E:/x/notes.txt"],
            ["bash1_out", "OK-73"],
        ]);
        const out = I.renderTemplates("path {read1_path} out {bash1_out} braces {not_a_var} code {x.done}", vars);
        check(
            "render: substitute known, keep unknown literal",
            out === "path E:/x/notes.txt out OK-73 braces {not_a_var} code {x.done}",
            JSON.stringify(out),
        );
    }

    // 2. template rendering: an echoed [vars: …] hint line is stripped (production path)
    {
        const vars = new Map([["read1_path", "/p"]]);
        const out = I.renderTemplates(
            "the path is {read1_path}\n[vars: read1_path] — quote these as {name} placeholders in your final reply; they are replaced with the exact recorded values",
            vars,
        );
        check("render: strips echoed [vars:] hint line", out === "the path is /p", JSON.stringify(out));
    }

    // 3. JSON extraction: a fenced ARRAY must survive prose that contains {braces}
    {
        const text = 'Here is the result {as requested}:\n```json\n[1, 2, 3]\n```';
        const cand = I.extractJsonCandidate(text);
        let ok = false;
        try {
            ok = Array.isArray(JSON.parse(cand));
        } catch {
            /* ok stays false */
        }
        check("json: fenced array not clobbered by prose braces", ok, JSON.stringify(cand));
        check("format: valid JSON array passes", I.validateFormat(text, "json"));
    }

    // 4. JSON extraction: object embedded in prose (no fence)
    {
        const text = 'The answer follows: {"rows": 4, "longest_id": "BR-77841"} — done.';
        let ok = false;
        try {
            ok = JSON.parse(I.extractJsonCandidate(text)).rows === 4;
        } catch {
            /* ok stays false */
        }
        check("json: embedded object extracted from prose", ok, JSON.stringify(I.extractJsonCandidate(text)));
    }

    // 5. payload: a ```json fence wins over a later untagged fence (example snippet)
    {
        const text = '```json\n{"a":1}\n```\n\nFor example:\n```\n{"a":999}\n```';
        check("payload: tagged json fence preferred", I.extractPayload(text, "json") === '{"a":1}', JSON.stringify(I.extractPayload(text, "json")));
    }

    // 6. format: code validity is now substantive (fence balance), fail-open otherwise
    {
        check("format: code with balanced fences valid", I.validateFormat("```python\nprint(1)\n```", "code"));
        check("format: code with an unclosed fence invalid", !I.validateFormat("```python\nprint(1)\n", "code"));
        check("format: unfenced code stays valid (fail-open)", I.validateFormat("Use `pip install x` first.", "code"));
    }

    // 7. verification guard: true positive — success claim vs traceback output
    {
        I.vars.clear();
        I.vars.set("bash1_cmd", "python bugs.py");
        I.vars.set("bash1_out", "Traceback (most recent call last):\n  ...\nSyntaxError: invalid syntax");
        const g = I.verificationGuard("I fixed it and verified the output now prints SUM=60.", 1);
        check("guard: flags success claim over an error run", !!g && g.includes("de-hallucination check"), String(g).slice(0, 80));
    }

    // 8. verification guard: grep's exit 1 (no match) is an answer, not an error
    {
        I.vars.clear();
        I.vars.set("bash1_cmd", "grep -rn TODO src/");
        I.vars.set("bash1_out", "exited with code 1");
        const g = I.verificationGuard("I verified there are no TODOs left.", 1);
        check("guard: search-class exit 1 does not false-positive", g === null, String(g).slice(0, 80));
    }

    // 9. verification guard: scoped to the current turn, not stale earlier output
    {
        I.vars.clear();
        I.vars.set("bash1_cmd", "python old.py");
        I.vars.set("bash1_out", "Traceback (most recent call last):\nValueError: boom");
        I.vars.set("bash2_cmd", "python new.py");
        I.vars.set("bash2_out", "SUM=60");
        check("guard: ignores an earlier turn's error", I.verificationGuard("I verified the fix.", 2) === null);
        check("guard: still flags when the error IS this turn's", I.verificationGuard("I verified the fix.", 1) !== null);
    }

    // 10. env parsing: malformed integers fall back instead of becoming NaN
    {
        process.env.DH_TEST_BAD = "abc";
        process.env.DH_TEST_GOOD = "42";
        check("env: NaN falls back to default", I.int("DH_TEST_BAD", 7) === 7, String(I.int("DH_TEST_BAD", 7)));
        check("env: valid integer parsed", I.int("DH_TEST_GOOD", 7) === 42, String(I.int("DH_TEST_GOOD", 7)));
        check("env: unset uses default", I.int("DH_TEST_UNSET_XYZ", 9) === 9);
        delete process.env.DH_TEST_BAD;
        delete process.env.DH_TEST_GOOD;
    }

    // 11. var capture: read path/content, bash cmd/out/exit
    {
        const readPairs = Object.fromEntries(I.varsForTool("read", "read1", { path: "/x/notes.txt" }, "line one\nline two"));
        check("vars: read path+content", readPairs.read1_path === "/x/notes.txt" && readPairs.read1_content === "line one\nline two");
        const bashPairs = Object.fromEntries(I.varsForTool("bash", "bash1", { command: "python x.py" }, "out\nexited with code 2"));
        check("vars: bash cmd+out+exit", bashPairs.bash1_cmd === "python x.py" && bashPairs.bash1_exit === "2");
    }

    // 12. option extraction: "Which is better … Python or Bash?" -> python/bash
    {
        const opts = I.extractOptions("Which is better for quick one-off data munging scripts: Python or Bash? Pick exactly one.");
        const keys = (opts || []).map((o) => o.key).join(",");
        check("options: extracts python,bash", keys === "python,bash", keys);
    }

    console.log(`\n===== units: ${pass} passed, ${fail} failed =====`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error("units: unexpected error —", e && e.message);
    process.exit(1);
});
