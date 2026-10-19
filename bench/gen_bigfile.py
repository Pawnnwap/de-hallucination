#!/usr/bin/env python3
"""Generate bench/fixtures/bigfile.txt — a deterministic ~210KB (~55-60k token) deployment
audit log with eight 64-hex salt needles at controlled depths, plus expected_salts.json
for the scorer. Usage: python bench/gen_bigfile.py"""
import json
import random
import os
import secrets

random.seed(20261018)
# deterministic needles: seeded PRNG so the fixture is reproducible
NEEDLE_SECTIONS = [1, 4, 9, 14, 19, 23, 27, 30]
TOTAL_SECTIONS = 30
PARAGRAPHS_PER_SECTION = 40

SERVICES = ["ledger-api", "auth-gateway", "sync-worker", "billing-daemon", "trace-collector",
            "notify-relay", "search-indexer", "cache-warden", "mesh-router", "quota-sentinel"]
EVENTS = ["rebalanced connection pool", "flushed write-ahead log", "rotated signing certificate",
          "rescheduled partition leader", "compacted topic segments", "warmed route table",
          "drained stale sessions", "reloaded feature flags", "pruned token cache",
          "re-synced replica set", "throttled burst traffic", "snapshotted index shard"]
HOSTS = [f"node-{i:02d}.{az}.internal" for i in range(1, 15) for az in ("eu-a", "eu-b", "us-c")]


def paragraph(section: int) -> str:
    svc = random.choice(SERVICES)
    ev = random.choice(EVENTS)
    host = random.choice(HOSTS)
    ms = random.randint(2, 950)
    seq = random.randint(10_000, 99_999)
    extra = (
        f"Backpressure stayed within limits (queue depth {random.randint(0, 480)}), "
        f"and the health probe on port {random.randint(9000, 9800)} returned ok."
        if random.random() < 0.5 else
        f"Latency p99 was {random.randint(8, 320)}ms with an error rate of "
        f"{random.uniform(0.0, 0.4):.3f}%; no pages were emitted."
        if random.random() < 0.5 else
        f"A follow-up sweep verified {random.randint(3, 40)} in-flight batches; "
        f"{random.randint(0, 3)} required manual reconciliation."
    )
    return (f"[{section:02d}] {svc} on {host} {ev} in {ms}ms "
            f"(seq={seq}, region={random.choice(('eu', 'us', 'ap'))}). {extra}")


def salt_value(n: int) -> str:
    rng = random.Random(20261018 + n)  # deterministic per needle
    return "".join(rng.choice("0123456789abcdef") for _ in range(64))


def main():
    import sys
    small = "--small" in sys.argv  # local-slot variant: ~12KB, salts far apart in-context
    sections = 6 if small else TOTAL_SECTIONS
    needles = [1, 2, 4, 6] if small else NEEDLE_SECTIONS
    paras = 7 if small else PARAGRAPHS_PER_SECTION
    out_dir = os.path.join(os.path.dirname(__file__), "fixtures")
    salts = {}
    lines = ["deployment audit log — generated fixture (deterministic, seed 20261018)", ""]
    for s in range(1, sections + 1):
        lines.append(f"===== section {s:02d} =====")
        for _ in range(paras):
            lines.append(paragraph(s))
            lines.append("")
        if s in needles:
            n = needles.index(s) + 1
            val = salt_value(n)
            salts[f"salt_{n}"] = val
            lines.append(f"credential-registry: salt_{n} = {val}   # rotate at next window")
            lines.append("")
        else:  # decoy checksum line so scanning stays noisy
            rng = random.Random(7777 + s)
            decoy = "".join(rng.choice("0123456789abcdef") for _ in range(48))
            lines.append(f"integrity-check: checksum_{s} = {decoy}   (section digest)")
            lines.append("")
    stem = "bigfile_small" if small else "bigfile"
    path = os.path.join(out_dir, stem + ".txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    # answer key stays OUTSIDE the agent-visible fixtures dir
    with open(os.path.join(os.path.dirname(__file__), f"expected_salts{'_small' if small else ''}.json"), "w") as f:
        json.dump(salts, f, indent=1)
    size = os.path.getsize(path)
    print(f"wrote {path} ({size/1024:.0f} KB, ~{size//4//1000}k tokens est), salts: {len(salts)}")


if __name__ == "__main__":
    main()
