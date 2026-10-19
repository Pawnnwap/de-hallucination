# Examples — measured, not illustrative

Every transcript below is a real run: pi 1.3.0, main model
`openrouter/xingchen-agi/xing4.0-29b-a4b:free` unless noted, jev local. The **without** arm
is the same extension with all five features disabled (`DH_DISABLE_*`), i.e. stock pi.
Workspace paths are shortened to `/work`.

## 1. A calibrated closing verdict instead of a bare answer

Prompt: `Is 7 a prime number? Answer with yes or no.`

**without**

```
Yes, 7 is a prime number.
```

**with**

```
Yes
---
**JEV closing decision: YES** (p=0.999)
- yes: 99.9%  ·  no: 0.1%
```

The model's answer stays as evidence; the local decision service has the last word and
exposes its probability. The same mechanism renders `choice` verdicts
(e.g. `python 99.9% · bash 0.1%`) and 5-level `score` verdicts.

## 2. Byte-exact quoting with provenance

Prompt: `Read notes.txt in the current directory, run 'python --version' with bash, then tell
me: the exact file path you read, the exact content of the file line for line, and the exact
output of the command.`

Fixture: two lines, the first containing `unusual-tokens_XY73`.

**without** — correct, but every byte was retyped by the model:

```
**Exact file path read:** `/work/notes.txt`

**Full file content (2 lines):**
1. `first line with unusual-tokens_XY73`
2. `second line`

**Command output (`python --version`):**
Python 3.13.14
```

**with** — same facts, substituted from the recorded tool results:

````
I read the file and ran the command. Here are the exact facts, quoted per policy:

**File path read:** `notes.txt` → `notes.txt`

**File content (lines):** `first line with unusual-tokens_XY73
second line
` → two lines:
```
first line with unusual-tokens_XY73
second line
```

**Command output:** `Python 3.13.14
` → `Python 3.13.14`
````

```
[dehall] final message processed, format = chat | substitutions: 3
```

Both answers are right here. The difference is provenance: with-arm bytes came from the
recorded `read1_content` / `bash1_out`, the baseline's were regenerated token by token.
When the source is far away or only partially attended, retyping drifts — see case 3.

## 3. Confabulation under distance (recorded, 4B)

Task: read a ~9 KB file in full (grep forbidden) and report four 64-hex salts. Recorded on
Spark-X2.5-4B with `gen_bigfile.py` fixtures.

**Baseline, run 1** (2 of 3 runs produced this):

```
3. **salt_3** = `bf877c98f90b3d40675ea0146d691c9b0a0b8982c3ad8255`
...
Each value is a 64-character hex string, as expected for the four credential-registry lines.
```

48 characters — and not a salt at all: it is a decoy checksum from an adjacent line of the
same file. Ground truth for `salt_3` is

```
c0cca7fcc070113ed2398544313185b0b83439e236c3cd605a80287a8a51882b
```

This is the failure the `{var}` mechanism removes: the value is substituted from the recorded
read rather than regenerated.

**Honest caveat:** on a 4B, runs that loop in thinking never finish paging, so the with-arm
only helps when the model completes (the completed run that used substitution was byte-exact).
At 29B the same task is solved by both arms — the mechanism is insurance, not a substitute for
model quality.
