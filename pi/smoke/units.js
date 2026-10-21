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

    // 4-item and colon lists
    {
        const r = I.extractOptions("Which candidate failed: jiban_factor, min_lot_ratio_ts_demean40, peak_ratio_diff or sqw_rangemed_40?");
        check("options: four-item list keeps all four labels",
            !!r && r.length === 4 && r[0].key === "jiban_factor" && r[3].key === "sqw_rangemed_40", (r || []).map((o) => o.key).join(","));
        const c = I.extractOptions("Pick one: Python, Bash, Julia, R.");
        check("options: colon list with no 'or'", !!c && c.map((o) => o.key).join(",") === "python,bash,julia,r", (c || []).map((o) => o.key).join(","));
        check("options: prose with no list stays null", I.extractOptions("Is the file longer than 100 lines?") === null);
        const lv = I.extractOptions("Recorded scan: jiban_factor Spearman -0.989 with 3/19 rising; min_lot +0.992. Pick exactly one of: jiban_factor, min_lot_ratio_ts_demean40, peak_ratio_diff, sqw_rangemed_40 - the one that failed monotonicity.");
        check("options: live form with a trailing clause keeps 4 labels",
            !!lv && lv.length === 4 && lv[3].key === "sqw_rangemed_40", (lv || []).map((o) => o.key).join(","));
        const sm = I.extractOptions("Choose an engine: vllm; llama.cpp; transformers.");
        check("options: semicolon list", !!sm && sm.map((o) => o.key).join(",") === "vllm,llama.cpp,transformers", (sm || []).map((o) => o.key).join(","));
    }

    // gates: floors, ablation twin, abstain line
    {
        const m = I.maskEvidence("Spearman -0.989, 3/19 rising, 42% of 100");
        check("gates: mask redacts numbers, keeps punctuation", m === "Spearman -[#], [#] rising, [#]% of [#]", JSON.stringify(m));
        check("gates: topProb reads the sharpest cell", I.topProb({ a: 0.31, b: 0.44 }) === 0.44);
        check("gates: flat binary is floored", /below/.test(I.floorReason("binary", { noul: 0.52 })));
        check("gates: sharp binary passes", I.floorReason("binary", { noul: 0.62 }) === "");
        const flat = { probabilities: { x: 0.315, y: 0.276, z: 0.23, w: 0.179 } };
        check("gates: flat choice is floored", /top-p/.test(I.floorReason("choice", flat)));
        check("gates: sharp choice passes", I.floorReason("choice", { probabilities: { x: 0.674, y: 0.22, z: 0.106 } }) === "");
        check("gates: abstain line carries the distribution",
            /ABSTAINED/.test(I.abstainLine("binary", "x", { noul: 0.52 })) && /52.0%/.test(I.abstainLine("binary", "x", { noul: 0.52 })));
        const tv = I.tvDistance({ a: 0.5, b: 0.5 }, { a: 0.9, b: 0.1 });
        check("gates: tvDistance is symmetric", Math.abs(tv - 0.4) < 1e-9, String(tv));
        const sharp = await I.gateVerdict("choice", { probabilities: { a: 0.533, b: 0.467 } },
            async () => I.tvDistance({ a: 0.533, b: 0.467 }, { a: 0.9, b: 0.1 }));
        check("gates: masked run getting sharper is evidence-bound, not abstained", sharp === null, String(sharp));
        const pub = await I.gateVerdict("binary", { noul: 0.91 }, async () => 0.42);
        check("gates: sharp evidence-bound verdict publishes", pub === null, String(pub));
        const ab = await I.gateVerdict("binary", { noul: 0.62 }, async () => 0.03);
        check("gates: low evidence-sensitivity abstains", !!ab && /evidence-sensitivity/.test(ab), String(ab));
        const fb = await I.gateVerdict("choice", flat, async () => 0.4);
        check("gates: floor beats ablation", !!fb && /top-p/.test(fb), String(fb));
        check("gates: no numbers to mask skips ablation",
            (await I.gateVerdict("binary", { noul: 0.62 }, async () => null)) === null);
        check("gates: num() falls back on malformed env", (() => { process.env.DH_ABSTAIN_TOPP = "abc"; const v = I.num("DH_ABSTAIN_TOPP", 0.45); delete process.env.DH_ABSTAIN_TOPP; return v === 0.45; })());
    }

    console.log(`\n===== units: ${pass} passed, ${fail} failed =====`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error("units: unexpected error —", e && e.message);
    process.exit(1);
});
