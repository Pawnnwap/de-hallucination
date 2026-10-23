#!/usr/bin/env python3
"""Router accuracy eval: posts the exact question the extension sends to jev, with and
without the routing preamble (the 'hard-injected system prompt'), against labeled prompts.

Usage: python pi/bench/router_eval.py [jev_url] [bearer_token]
"""
import json
import os
import sys
import urllib.request

URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8090").rstrip("/")
KEY = (sys.argv[2] if len(sys.argv) > 2 else os.environ.get("DH_JEV_KEY", "")).strip()
MODEL = (sys.argv[3] if len(sys.argv) > 3 else os.environ.get("DH_JEV_MODEL", "")).strip()

# Labels: the acceptable format(s) for each prompt (chat/doc overlap allowed).
CASES = [
    ("Two files in the current directory each contain an api_token line, one marked production and one marked staging. Report the api_token value from the production file and the name of that file, exactly.", {"chat"}),
    ("Read config.txt in the current directory and report: the exact version string, and the exact greeting line, character for character.", {"chat"}),
    ("Read longline.txt in the current directory and report the exact signing_key value, character for character.", {"chat"}),
    ("Run this exact command with bash and report its exact complete output: python -c \"import hashlib; print(1)\"", {"chat"}),
    ("bugs.py in the current directory should print SUM=60 but prints the wrong value. Find the bug and fix the file so it prints SUM=60. Do not create new files.", {"code"}),
    ("Read data.csv in the current directory and answer with a strict JSON object with exactly these keys: rows, longest_id, note_for_longest. JSON only.", {"json"}),
    ("Search the news for the Nordvine funding round. Report the exact amount they raised, the exact date, and quote the exact headline.", {"chat"}),
    ("Search the news for the Pulsegrid outage. Report the exact duration of the outage and the exact number of affected users.", {"chat"}),
    ("Search the news: did the Kestrel DB 3.2 release or the Tesserion-Halcyon acquisition happen later? Name the later event and give its exact date.", {"choice"}),
    ("Search the news and give me a combined summary of the three Nordic startup funding rounds: for each company the exact amount and exact date, then the exact total amount raised across all three rounds.", {"doc", "chat"}),
    ("Read the two ACME quarterly documents in the sources directory. One is a later revision that supersedes the other. Report the FINAL corrected revenue, user count and churn rate, each exactly as stated in the final document.", {"chat"}),
    ("Read the three regional sales files in the sources directory and report the exact total units sold across all three regions and the exact total revenue.", {"chat", "doc"}),
    ("Write a python script that renames all *.jpeg files in a folder to *.jpg.", {"code"}),
    ("Should we migrate the queue to Kafka or stay on RabbitMQ? Pick one.", {"choice"}),
    ("Does config.txt contain a timeout setting? yes or no.", {"binary"}),
    ("Rate the readability of main.py on a scale from 1 to 5.", {"score"}),
    ("Give me the list of supported endpoints as YAML.", {"yaml"}),
    ("Export the test results table as CSV.", {"csv"}),
]

FORMAT_OPTIONS = {
    "chat": "Plain conversational answer or explanation; no structure, document, data format, pick or verdict is requested",
    "doc": "A markdown document, report, plan or other structured prose answer",
    "code": "A program, script, command or code patch is the main deliverable",
    "json": "Strict JSON data is the main deliverable",
    "yaml": "YAML data is the main deliverable",
    "csv": "CSV data or a table is the main deliverable",
    "choice": "The user asks to choose, pick or rank among named alternatives, or asks which of two items is later/better/bigger/larger (A or B, which one, which happened first)",
    "score": "The user asks for a numeric rating, grade or evaluation score",
    "binary": "The user asks a yes/no or true/false question",
}

PREAMBLE = """You are the output-format router of a coding agent. Classify what OUTPUT SHAPE the user requires for the final answer — the deliverable, not the topic. Exactly one choice.

Definitions with typical examples:
- chat: answer, explain, or find-and-report in prose ("tell me X", "what does Y print", "find the token and report its exact value")
- doc: a composed multi-section summary or report ("give me a combined summary of ...", "write a report", "an overview of all ...")
- code: a program, script, command or code patch is the deliverable ("write a script", "fix the bug in the file", "give me a one-liner that ...")
- json / yaml / csv: data in exactly that machine-readable format ("as JSON", "as YAML", "as a CSV")
- choice: pick among named alternatives ("A or B", "which one", "which happened later")
- score: a numeric rating ("rate 1 to 10", "how good is X on a scale")
- binary: a yes/no or true/false question ("is X ...?", "does it ...?")

Rules: the deliverable shape wins over the topic. Combining multiple sources into a summary is doc. Quoting exact values in prose is chat. Pick json/yaml/csv only when the user names that format. Fixing or producing code is code even if the user also wants a short explanation."""


def route(prompt: str, mode: str):
    # mode "user"      -> only the user message goes to jev (no session-start framing)
    # mode "wrapped"   -> user message wrapped in the agent framing, no system preamble
    # mode "preamble"  -> system routing preamble + wrapped user message
    if mode == "user":
        state = prompt[:6000]
    else:
        state = []
        if mode == "preamble":
            state.append({"role": "system", "content": PREAMBLE})
        state.append({"role": "user", "content": f'User request to a coding agent:\n"""\n{prompt[:6000]}\n"""'})
    body = {
        "state": state,
        "questions": {
            "fmt": {
                "type": "choice",
                "instructions": "What output format does the user require for the final answer to this request?",
                "criteria": FORMAT_OPTIONS,
            }
        },
    }
    if MODEL:
        body["model"] = MODEL
    headers = {"Content-Type": "application/json"}
    if KEY:
        headers["Authorization"] = f"Bearer {KEY}"
    req = urllib.request.Request(URL + "/v1/systemone", data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        a = json.load(r)["answers"]["fmt"]
    return a["choice"], a["probabilities"].get(a["choice"], 0.0)


def main():
    modes = [
        ("user-only (state = the user message, no framing)", "user"),
        ("OLD (state = raw request)", "wrapped"),
        ("NEW (routing preamble injected)", "preamble"),
    ]
    for label, mode in modes:
        correct = 0
        conf_sum = 0.0
        misses = []
        for prompt, accept in CASES:
            got, p = route(prompt, mode)
            conf_sum += p
            if got in accept:
                correct += 1
            else:
                misses.append(f"    {got} (p={p:.2f}) want {'/'.join(sorted(accept))}: {prompt[:60]}...")
        print(f"{label}: {correct}/{len(CASES)} correct, avg winner-prob {conf_sum/len(CASES):.3f}")
        for m in misses:
            print(m)


if __name__ == "__main__":
    main()
