#!/usr/bin/env bash
# de-hallucination A/B benchmark: pi WITH the extension vs WITHOUT (all five features
# disabled via env; provider/model/temperature identical), on everyday tasks against the
# local Spark-X2.5-4B stack. Verbatim-exactness tasks are the extension's home turf;
# fix_bug measures that everyday coding is not harmed.
#
# Usage:  bash pi/bench/bench.sh [N]     (N = repeats per task per arm, default 3)
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
N="${1:-3}"
TS=$(date +%Y%m%d_%H%M%S)
RESULTS="bench/results/bench_${TS}.md"
WORK="$ROOT/.bench-work"
rm -rf "$WORK"; mkdir -p "$WORK"
: > "$WORK/notes.txt"

FIXTURES_BUGS="$ROOT/bench/fixtures/bugs.py"
BUGS_PRISTINE="$WORK/bugs.py.orig"
cp "$FIXTURES_BUGS" "$BUGS_PRISTINE"

TASKS_ALL=(search_token quote_config quote_hard run_hash fix_bug json_from_csv news_funding news_outage news_latest multi_summary multi_conflict multi_regions bulk_extract bulk_far)
TASKS=("${TASKS_ALL[@]}")
PROMPTS=(
  "Two files in the current directory each contain an api_token line, one marked production and one marked staging. Report the api_token value from the production file and the name of that file, exactly."
  "Read config.txt in the current directory and report: the exact version string, and the exact greeting line, character for character."
  "Read longline.txt in the current directory and report the exact signing_key value, character for character."
  "Run this exact command with bash and report its exact complete output: python -c \"import hashlib; print(hashlib.sha256(b'dehall-bench').hexdigest())\""
  "bugs.py in the current directory should print SUM=60 but prints the wrong value. Find the bug and fix the file so it prints SUM=60. Do not create new files."
  "Read data.csv in the current directory and answer with a strict JSON object with exactly these keys: rows (number of data rows), longest_id (the id string that is longest), note_for_longest (the note of that row). JSON only."
  "Search the news for the Nordvine funding round. Report the exact amount they raised, the exact date, and quote the exact headline. Several similar companies raised rounds recently - make sure you have the right one."
  "Search the news for the Pulsegrid outage. Report the exact duration of the outage and the exact number of affected users. Another company had a shorter outage recently - do not confuse them."
  "Search the news: did the Kestrel DB 3.2 release or the Tesserion-Halcyon acquisition happen later? Name the later event and give its exact date."
  "Search the news and give me a combined summary of the three Nordic startup funding rounds: for each company the exact amount and exact date, then the exact total amount raised across all three rounds."
  "Read the two ACME quarterly documents in the sources directory. One is a later revision that supersedes the other. Report the FINAL corrected revenue, user count and churn rate, each exactly as stated in the final document."
  "Read the three regional sales files in the sources directory and report the exact total units sold across all three regions and the exact total revenue."
  "bigfile.txt in the current directory is a long deployment audit log containing eight credential-registry lines of the form salt_N = <64 hex value>. Read through the file and report every salt name with its exact value, character for character."
  "bigfile_small.txt in the current directory contains four credential-registry lines of the form salt_N = <64 hex value>. Read the ENTIRE file with the read tool using offset/limit until you have seen every line - do NOT use grep, find or any search tool. Then report all four salt names with their exact values, character for character."
)
# long-context fixture is generated (gitignored) — regenerate when missing
[ -f bench/fixtures/bigfile.txt ] || python bench/gen_bigfile.py >/dev/null
# optional task filter: bash pi/bench/bench.sh 3 json_from_csv search_token
if [ $# -ge 2 ]; then
  FILTERED=()
  for t in "${TASKS[@]}"; do
    for f in "${@:2}"; do [ "$t" = "$f" ] && FILTERED+=("$t"); done
  done
  TASKS=("${FILTERED[@]}")
fi
BASELINE_ENV="DH_DISABLE_ROUTER=1 DH_DISABLE_TEMPLATES=1 DH_DISABLE_CLOSER=1 DH_DISABLE_CHECKER=1 DH_DISABLE_DECIDE=1"

wpath() { cygpath -m "$1" 2>/dev/null || echo "$1"; }

MODEL="${PI_MODEL:-spark-local/Spark-X2.5-4B}"   # e.g. openrouter/xingchen-agi/xing4.0-29b-a4b:free

flaked() { # true when the run ended length-flaked or rate-limited (retryable)
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
}catch(e){process.exit(1)}" "$(wpath "$1")"
}

prompt_for() { # task name -> prompt text (index resolved against the FULL task list)
  local idx=0 j=0 t
  for t in "${TASKS_ALL[@]}"; do [ "$t" = "$1" ] && idx=$j && break; j=$((j+1)); done
  echo "${PROMPTS[$idx]}"
}

run_one() { # run_one <arm> <task> <i>
  local arm=$1 task=$2 i=$3
  local dir="$WORK/$arm/$task/$i"
  local prompt; prompt=$(prompt_for "$task")
  mkdir -p "$dir"
  cp "$BUGS_PRISTINE" "$FIXTURES_BUGS"   # restore fixture before every run
  local attempt
  for attempt in 1 2; do
    [ "$attempt" = 2 ] && { echo "    retry: $arm/$task/$i (length-flake)" >> "$WORK/notes.txt"; rm -f "$dir"/*.jsonl; }
    (
      cd bench/fixtures || exit 1
      # NB: `env VAR=1 pi ...` silently no-ops on Git Bash — export inside the subshell.
      if [ "$arm" = "without" ]; then
        eval "export $BASELINE_ENV"
      fi
      DH_DEBUG=1 pi -ne --extension "$ROOT/index.ts" \
        --model "$MODEL" -p --session-dir "$dir" "$prompt" < /dev/null 2>"$dir/stderr.log"
    )
    flaked "$dir" || break
  done
}

echo "# de-hallucination A/B benchmark — ${TS}" > "$RESULTS"
echo "" >> "$RESULTS"
echo "N=$N repeats per task per arm · model ${PI_MODEL:-Spark-X2.5-4B (local)} · pi 1.3.0" >> "$RESULTS"
echo "" >> "$RESULTS"
echo "| task | with ext | without ext | notes (with) |" >> "$RESULTS"
echo "|---|---|---|---|" >> "$RESULTS"

for task in "${TASKS[@]}"; do
  pass_with=0; pass_without=0
  for i in $(seq 1 "$N"); do
    run_one with "$task" "$i"
    out=$(node bench/score.js "$task" "$(wpath "$WORK/with/$task/$i")")
    [ "$out" = "PASS" ] && pass_with=$((pass_with+1)) || echo "    with/$task/$i: $out" >> "$WORK/notes.txt"
    run_one without "$task" "$i"
    out=$(node bench/score.js "$task" "$(wpath "$WORK/without/$task/$i")")
    [ "$out" = "PASS" ] && pass_without=$((pass_without+1)) || echo "    without/$task/$i: $out" >> "$WORK/notes.txt"
  done
  subs=$(grep -h "substitutions:" "$WORK/with/$task"/*/stderr.log 2>/dev/null | grep -c "substitutions: [1-9]")
  echo "| $task | $pass_with/$N | $pass_without/$N | ${subs:-0}/$N runs used template substitution |" >> "$RESULTS"
done
cp "$BUGS_PRISTINE" "$FIXTURES_BUGS"

echo "" >> "$RESULTS"
echo "## failure details" >> "$RESULTS"
sed 's/^/    /' "$WORK/notes.txt" >> "$RESULTS"

cat "$RESULTS"
echo ""
echo "full results: $RESULTS   (raw runs: $WORK)"
