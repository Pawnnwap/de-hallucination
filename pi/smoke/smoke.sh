#!/usr/bin/env bash
# de-hallucination smoke matrix — runs pi headless against the local Spark stack and
# asserts mechanism correctness (routing, verdicts, template substitution, fail-open).
#
# Prereqs: pi CLI installed (npm i -g @earendil-works/pi-coding-agent), local stack up
# (start_jev.bat in the jev checkout -> jev :8090 + llama-server :8091).
#
# Usage: bash pi/smoke/smoke.sh         (from the repo root, or `bash smoke/smoke.sh` from pi/)
set -u
cd "$(dirname "$0")/.."

WORK="$PWD/.smoke-work"
rm -rf "$WORK"; mkdir -p "$WORK"
PASS=0; FAIL=0
note() { printf '\n== %s ==\n' "$1"; }
check() { # check <name> <expected-substring> <file>
  if grep -q "$2" "$3" 2>/dev/null; then echo "PASS: $1"; PASS=$((PASS+1));
  else echo "FAIL: $1 (wanted '$2' in $3)"; FAIL=$((FAIL+1)); fi
}
flaked() { # flaked <label> -> true when the run ended length-flaked or rate-limited (retryable)
  node -e "
const fs=require('fs');const d=process.argv[1];
try{
  const f=fs.readdirSync(d).filter(x=>x.endsWith('.jsonl')).sort().pop();
  const lines=fs.readFileSync(d+'/'+f,'utf8').trim().split('\n').map(l=>JSON.parse(l));
  let last=null;
  for(const l of lines) if(l.type==='message'&&l.message?.role==='assistant') last=l.message;
  const lengthFlake=last&&last.stopReason==='length'&&!last.content.some(c=>c.type==='text');
  const rateLimited=last&&last.stopReason==='error'&&/429|rate.?limit|connection error|ECONNRESET|fetch failed/i.test(last.errorMessage||'');
  process.exit(lengthFlake||rateLimited?0:1);
}catch(e){process.exit(1)}" "$(cygpath -m "$WORK/$1" 2>/dev/null || echo "$WORK/$1")"
}
MODEL="${PI_MODEL:-spark-local/Spark-X2.5-4B}"
run_pi() { # run_pi <label> <prompt>  (the local 4B occasionally burns its whole output
           # budget thinking; retry once when that happens — model flake, not a bug)
  local label=$1; shift
  local i
  for i in 1 2; do
    mkdir -p "$WORK/$label"
    [ "$i" = 2 ] && { echo "  (length-flake on attempt 1, retrying)"; rm -f "$WORK/$label"/*.jsonl; }
    DH_DEBUG=1 pi -ne --extension ./index.ts --model "$MODEL" \
      -p --session-dir "$WORK/$label" "$1" < /dev/null 2>"$WORK/$label/stderr.log"
    flaked "$label" || break
  done
}
session_texts() { # session_texts <label> -> prints all assistant text contents of newest session
  local win
  win=$(cygpath -m "$WORK/$1" 2>/dev/null || echo "$WORK/$1")
  node -e "
const fs=require('fs');const d=process.argv[1];
const f=fs.readdirSync(d).filter(x=>x.endsWith('.jsonl')).sort().pop();
for(const l of fs.readFileSync(d+'/'+f,'utf8').trim().split('\n').map(l=>JSON.parse(l))){
  if(l.type==='message'&&l.message?.role==='assistant')
    for(const c of l.message.content) if(c.type==='text') console.log(c.text);
}" "$win"
}

note "fixture"
printf 'first line with unusual-tokens_XY73\nsecond line\n' > notes.txt

note "0. deterministic unit checks (guardrails, no LLM/jev)"
if node smoke/units.js; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

note "1. binary -> jev closing round"
run_pi binary "Is 7 a prime number? Answer with yes or no."
session_texts binary > "$WORK/binary/session.txt"
check "router picked binary"      "router: binary"            "$WORK/binary/stderr.log"
# A gated verdict publishes nothing by design (knowledge-anchored prompts abstain: the
# masked twin barely moves), so the guarantee is the closer DECIDED, not that it posted.
if grep -qE "closer: (verdict = |abstaining:)" "$WORK/binary/stderr.log"; then
  echo "PASS: closing round decided (published or gated)"; PASS=$((PASS+1));
else echo "FAIL: closing round did not decide"; FAIL=$((FAIL+1)); fi

note "2. choice -> extracted options + closing round"
run_pi choice "Which is better for quick one-off data munging scripts: Python or Bash? Pick exactly one."
session_texts choice > "$WORK/choice/session.txt"
check "router picked choice"      "router: choice"            "$WORK/choice/stderr.log"
check "options extracted"         "using extracted options python/bash" "$WORK/choice/stderr.log"
# A gated verdict publishes nothing by design — an answer that argues its own conclusion
# spoils the masked twin (observed: 90.1% on the right option, TV=0.016) — so the
# guarantee is the closer DECIDED, same contract as the binary check above. When it did
# publish, the verdict block carries probabilities.
if grep -qE "closer: (verdict = |abstaining:)" "$WORK/choice/stderr.log"; then
  echo "PASS: choice closing round decided (published or gated)"; PASS=$((PASS+1));
else echo "FAIL: choice closing round did not decide"; FAIL=$((FAIL+1)); fi
if grep -q "abstaining:" "$WORK/choice/stderr.log" || grep -qE "[0-9]\.[0-9]%" "$WORK/choice/session.txt"; then
  echo "PASS: choice verdict block or gate abstention present"; PASS=$((PASS+1));
else echo "FAIL: choice produced neither a verdict nor a gate abstention"; FAIL=$((FAIL+1)); fi

note "3. json -> format checker"
run_pi json "Give me a JSON object with keys name, language and lines for the file notes.txt in the current directory. The JSON must be the whole answer."
session_texts json > "$WORK/json/session.txt"
check "router picked json"        "router: json"              "$WORK/json/stderr.log"
check "checker ran"               "checker: \(valid\|invalid\|reformat\|still\)" "$WORK/json/stderr.log"

note "4. templates -> {var} substitution"
# NB: ask for the file CONTENT explicitly — "exact outputs" alone was answered as
# "command output only" by the 29B, which made this check measure prompt reading
# instead of the substitution mechanism.
run_pi tpl "Read notes.txt in the current directory, run 'python --version' with bash, then tell me: the exact file path you read, the exact content of the file line for line, and the exact output of the command."
session_texts tpl > "$WORK/tpl/session.txt"
check "vars captured"             "vars += read1_path"        "$WORK/tpl/stderr.log"
if grep -q "substitutions: [1-9]" "$WORK/tpl/stderr.log"; then
  echo "note: model used placeholders this run (live substitution engaged)"
fi
# Deterministic mechanism check — live placeholder usage is stochastic model behavior.
if node -e "
import('./index.ts').then(m => {
  const { renderTemplates } = m.__internals;
  const vars = new Map([['read1_path','/work/notes.txt'],['bash1_out','OK-73']]);
  const out = renderTemplates('path {read1_path} out {bash1_out} braces {not_a_var} code {x.done}', vars);
  process.exit(out === 'path /work/notes.txt out OK-73 braces {not_a_var} code {x.done}' ? 0 : 1);
});" 2>/dev/null; then echo "PASS: render mechanism (unit)"; PASS=$((PASS+1));
else echo "FAIL: render mechanism (unit)"; FAIL=$((FAIL+1)); fi
check "exact content rendered"    "unusual-tokens_XY73"       "$WORK/tpl/session.txt"
if grep -qE "\{(read|bash|edit|write|grep|find|ls)[0-9]+_[a-z]+\}" "$WORK/tpl/session.txt"; then
  echo "FAIL: unresolved placeholder leaked to user"; FAIL=$((FAIL+1))
else echo "PASS: no unresolved placeholders leak"; PASS=$((PASS+1)); fi

note "5. fail-open with jev down"
mkdir -p "$WORK/dead"
DH_DEBUG=1 DH_JEV_URL=http://127.0.0.1:8099 pi -ne --extension ./index.ts \
  --model "$MODEL" -p --session-dir "$WORK/dead" \
  "Is 7 a prime number? Answer with yes or no." < /dev/null 2>"$WORK/dead/stderr.log"
check "failed open to chat"       "failing open to chat"      "$WORK/dead/stderr.log"
if grep -q "closer: running for format" "$WORK/dead/stderr.log"; then echo "FAIL: verdict despite jev down"; FAIL=$((FAIL+1));
else echo "PASS: no verdict when jev down"; PASS=$((PASS+1)); fi

printf '\n===== %d passed, %d failed =====\n' "$PASS" "$FAIL"
echo "artifacts: $WORK"
[ "$FAIL" -eq 0 ]
