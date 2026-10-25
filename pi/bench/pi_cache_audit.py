#!/usr/bin/env python3
"""Audit pi x de-hallucination prompt-cache behaviour end to end.

Runs pi twice (extension auto-loaded vs -ne stock) through a local capture proxy that
records BOTH the exact request bodies and the usage object of every response, so we can
report real cache_read per request, body-LCP drift positions and their byte context,
and whether the [vars:] trailer ever reaches model context. The proxy injects
stream_options.include_usage so streaming responses carry per-request usage.

Usage:
  python pi/bench/pi_cache_audit.py --base-url http://<engine-proxy-host>:<port> \
      --model <provider>/<model-id> [--turns 2] [--cwd <repo>]

Endpoint and model id come from arguments only — nothing internal is hardcoded here.
It temporarily registers a "cache-audit" provider in ~/.pi/agent/models.json
(backed up and restored in finally).
"""
import argparse, copy, json, os, re, shutil, socket, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class Capture:
    def __init__(self, upstream):
        self.upstream = upstream.rstrip("/")
        self.rt = []  # (request_body_bytes, usage_dict_or_None)
        self.lock = threading.Lock()
        self.dir = tempfile.mkdtemp(prefix="pi_cache_audit_")

    def handler_class(self):
        cap = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                try:
                    j = json.loads(raw)
                    if isinstance(j.get("stream_options"), (dict, type(None))) and j.get("stream") is True:
                        j["stream_options"] = {"include_usage": True}
                    fwd = json.dumps(j).encode()
                except Exception:
                    fwd = raw
                headers = {k: v for k, v in self.headers.items()
                           if k.lower() not in ("host", "content-length", "accept-encoding")}
                body_path = os.path.join(cap.dir, f"req_{len(cap.rt)}.json")
                with open(body_path, "wb") as f:
                    f.write(raw)
                try:
                    r = requests.post(cap.upstream + self.path, data=fwd, headers=headers,
                                      stream=True, timeout=600)
                    self.send_response(r.status_code)
                    for k, v in r.headers.items():
                        if k.lower() in ("transfer-encoding", "content-length", "content-encoding", "connection"):
                            continue
                        self.send_header(k, v)
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    acc = bytearray()
                    try:
                        for chunk in r.iter_content(chunk_size=None):
                            if not chunk:
                                continue
                            acc.extend(chunk)
                            self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                            self.wfile.flush()
                    except Exception:
                        pass
                    else:
                        self.wfile.write(b"0\r\n\r\n")
                    usage = parse_last_usage(bytes(acc))
                except Exception:
                    self.send_response(502)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    usage = None
                with cap.lock:
                    cap.rt.append((raw, usage))

        return H


def parse_last_usage(payload):
    usages = []
    for m in re.finditer(rb'data: (\{[^\n]*\})', payload):
        try:
            j = json.loads(m.group(1).decode("utf-8", errors="replace"))
        except Exception:
            continue
        if isinstance(j, dict) and j.get("usage"):
            usages.append(j["usage"])
    if not usages and payload:
        try:
            j = json.loads(payload.decode("utf-8", errors="replace"))
            if isinstance(j, dict) and j.get("usage"):
                usages.append(j["usage"])
        except Exception:
            pass
    return usages[-1] if usages else None


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def render(i, prev, body, usage):
    try:
        j = json.loads(body)
    except Exception:
        print(f"  #{i}: unparseable body")
        return body
    msgs = j.get("messages") or j.get("input") or []
    sysmsg = next((m for m in msgs if (m.get("role") or m.get("type")) == "system"), None)
    sysc = sysmsg.get("content") if sysmsg else None
    sys_len = (len(sysc) if isinstance(sysc, str) else
               sum(len(p.get("text") or "") for p in (sysc or []))) if sysc else 0
    tools = j.get("tools", [])
    vars_hits = 0
    policy_hits = 0
    for m in msgs:
        blob = ""
        c = m.get("content")
        if isinstance(c, str):
            blob = c
        elif isinstance(c, list):
            blob = " ".join((p.get("text") or "") for p in c if isinstance(p, dict))
        if "[vars:" in blob:
            vars_hits += 1
        if "de-hallucination policy" in blob or "[de-hallucination]" in blob:
            policy_hits += 1
    drift_info = ""
    if prev is not None:
        n = min(len(prev), len(body))
        off = 0
        while off < n and prev[off] == body[off]:
            off += 1
        drift_info = f" LCP={100.0 * off / len(prev):5.1f}%"
        if off < len(prev):
            ctx = body[max(0, off - 90):off + 150].decode("utf-8", errors="replace").replace("\n", "\\n")[:240]
            drift_info += f"  drift@{off}: {ctx}"
    hit_info = ""
    if usage:
        it = usage.get("prompt_tokens") or usage.get("input_tokens") or 0
        d = usage.get("prompt_tokens_details") or usage.get("input_tokens_details") or {}
        c = d.get("cached_tokens") or 0
        hit_info = f" p={it} cached={c}" + (f" hit={100*c/it:.1f}%" if it else "")
    print(f"  #{i}: body={len(body)}B items={len(msgs)} system={sys_len}ch "
          f"tools={len(tools)}({len(json.dumps(tools))}B) vars_trailer_items={vars_hits} "
          f"policy_sections={policy_hits}{hit_info}{drift_info}")
    return body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", required=True, help="provider/model id as registered in models.json")
    ap.add_argument("--turns", type=int, default=2)
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--pi", default="pi")
    args = ap.parse_args()

    port = free_port()
    cap = Capture(args.base_url)
    srv = ThreadingHTTPServer(("127.0.0.1", port), cap.handler_class())
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    print(f"audit proxy {base} -> {args.base_url}")

    models_file = os.path.expanduser("~/.pi/agent/models.json")
    backup = None
    provider_id, _, model_id = args.model.partition("/")
    if provider_id not in json.load(open(models_file, encoding="utf-8")).get("providers", {}):
        raise SystemExit(f"provider {provider_id!r} not in models.json")
    if os.path.exists(models_file):
        backup = models_file + ".cache_audit.bak"
        shutil.copyfile(models_file, backup)
        cfg = json.load(open(models_file, encoding="utf-8"))
        probe = copy.deepcopy(cfg["providers"][provider_id])
        probe["baseUrl"] = base + "/v1"
        cfg["providers"]["cache-audit"] = probe
        json.dump(cfg, open(models_file, "w", encoding="utf-8"), indent=2)
    probe_model = "cache-audit/" + model_id

    turns = ["List the files in the current directory and report the first one.",
             "Now read the file pi/notes.txt and report it exactly."][: args.turns]

    results = {}
    try:
        for label, extra in (("EXT ON", []), ("EXT OFF (-ne stock)", ["-ne"])):
            with cap.lock:
                cap.rt.clear()
            for i, t in enumerate(turns):
                cmd = [shutil.which(args.pi) or args.pi] + extra + ["--model", probe_model, "-p", t] + (["-c"] if i else [])
                try:
                    subprocess.run(cmd, cwd=args.cwd, env=dict(os.environ), capture_output=True,
                                   timeout=900, stdin=subprocess.DEVNULL)
                except subprocess.TimeoutExpired:
                    print(f"  [{label}] turn {i} TIMED OUT")
            with cap.lock:
                rts = list(cap.rt)
            bodies = [b for b, u in rts]
            uses = [u for b, u in rts]
            print(f"\n--- {label}: {len(bodies)} requests")
            prev = None
            for i, (body, usage) in enumerate(zip(bodies, uses)):
                prev = render(i, prev, body, usage)
            results[label] = (bodies, uses)
    finally:
        if backup:
            shutil.copyfile(backup, models_file)
            os.remove(backup)
        srv.shutdown()

    bo, uo = results.get("EXT ON", ([], []))
    bf, uf = results.get("EXT OFF (-ne stock)", ([], []))
    print("\n=== SUMMARY ===")

    def usage_line(bodies, uses, tag):
        hits = []
        for b, u in zip(bodies, uses):
            if u:
                it = (u.get("prompt_tokens") or u.get("input_tokens") or 0)
                d = u.get("prompt_tokens_details") or u.get("input_tokens_details") or {}
                c = d.get("cached_tokens") or 0
                hits.append((it, c))
        per = " ".join(f"{100*c/it:.0f}%" if it else "-" for it, c in hits)
        tot = sum(it for it, c in hits) or 1
        tw = 100.0 * sum(c for it, c in hits) / tot
        print(f"  {tag}: per-request hit [{per}]  token-weighted={tw:.1f}%")
        return tw

    if bo and uo:
        usage_line(bo, uo, "EXT ON")
    if bf and uf:
        usage_line(bf, uf, "EXT OFF")
    if bo and bf:
        def head(bodies):
            j = json.loads(bodies[0])
            return len(json.dumps(j.get("messages", []))) + len(json.dumps(j.get("tools", [])))
        print(f"  first-request bytes: ext {head(bo):,} stock {head(bf):,} overhead {head(bo)-head(bf):+,}")


if __name__ == "__main__":
    main()
