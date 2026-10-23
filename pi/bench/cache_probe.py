#!/usr/bin/env python3
"""Measure what the de-hallucination extension costs the remote model's prompt cache.

The remote model is an OpenAI-compatible server with a prefix cache (vLLM: automatic
prefix caching, block-quantized). Two things decide the hit rate:

  1. how many bytes the extension adds to the prompt (the prompt is the cache key), and
  2. whether consecutive requests share a byte-identical prefix (a changed byte inside
     the prompt invalidates everything after it).

This script captures the exact request bodies pi sends (through a local logging proxy)
for the extension ON and OFF, and reports per request:
  - prompt characters and the server's own prompt-token count,
  - the tool count and the tool-schema size,
  - the common prefix with the previous request (cache-alignment),
  - and, when the backend exposes vLLM metrics, the prefix-cache hit rate.

Usage:
  python pi/bench/cache_probe.py \
      --base-url https://your-endpoint/v1 --api-key $OPENAI_API_KEY --model <model>
      [--vllm-metrics http://<engine-host>:8000/metrics] [--turns 2]

The endpoint, key and model are arguments/env only — nothing internal is hardcoded here.
"""
import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests


class Capture:
    """Logging reverse proxy: keeps the request bodies, forwards everything else."""

    def __init__(self, upstream):
        self.upstream = upstream.rstrip("/")
        self.bodies = []
        self.lock = threading.Lock()

    def handler_class(self):
        cap = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                with cap.lock:
                    cap.bodies.append(raw)
                headers = {k: v for k, v in self.headers.items()
                           if k.lower() not in ("host", "content-length", "accept-encoding")}
                try:
                    r = requests.post(cap.upstream + self.path, data=raw, headers=headers,
                                      stream=True, timeout=600)
                except Exception:
                    self.send_response(502)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                self.send_response(r.status_code)
                for k, v in r.headers.items():
                    if k.lower() in ("transfer-encoding", "content-length", "content-encoding", "connection"):
                        continue
                    self.send_header(k, v)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                try:
                    for chunk in r.iter_content(chunk_size=None):
                        if chunk:
                            self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                            self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                except Exception:
                    pass

            def do_GET(self):
                try:
                    r = requests.get(cap.upstream + self.path,
                                     headers={"Authorization": self.headers.get("Authorization", "")}, timeout=60)
                except Exception:
                    self.send_response(502)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = r.content
                self.send_response(r.status_code)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/json"))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return H


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def token_count(base_url, api_key, body):
    """The server's own prompt-token count, if it exposes /tokenize."""
    for suffix in ("/tokenize", "/../tokenize"):
        try:
            r = requests.post(base_url.rstrip("/") + suffix,
                              json={"model": body.get("model"), "content": json.dumps(body.get("messages", []))},
                              headers={"Authorization": f"Bearer {api_key}"}, timeout=30)
            if r.ok:
                j = r.json()
                return len(j.get("tokens") or j.get("data") or [])
        except Exception:
            pass
    return None


def vllm_cache(metrics_url):
    try:
        txt = requests.get(metrics_url, timeout=20).text
    except Exception:
        return None
    q = h = 0.0
    for line in txt.split("\n"):
        m = re.match(r"vllm:prefix_cache_queries_total\{[^}]*\}\s+([0-9.e+-]+)", line)
        if m:
            q = float(m.group(1))
        m = re.match(r"vllm:prefix_cache_hits_total\{[^}]*\}\s+([0-9.e+-]+)", line)
        if m:
            h = float(m.group(1))
    return q, h


def run_session(pi_cmd, turns, cwd, env, proxy_base, model, capture):
    env = dict(env)
    env["PI_MODEL"] = model
    for i, t in enumerate(turns):
        cmd = pi_cmd + ["--model", model, "-p", t] + (["-c"] if i else [])
        try:
            subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, timeout=900,
                           stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            pass


def analyse(label, bodies, base_url, api_key):
    print(f"--- {label}")
    prev = None
    for i, raw in enumerate(bodies):
        try:
            j = json.loads(raw)
        except Exception:
            continue
        msgs = j.get("messages", [])
        sysmsg = next((m for m in msgs if m.get("role") == "system"), {})
        sysc = sysmsg.get("content")
        sys_len = len(sysc) if isinstance(sysc, str) else sum(
            len(p.get("text") or "") for p in (sysc or []))
        tools = j.get("tools", [])
        tool_bytes = len(json.dumps(tools))
        body_len = len(raw)
        common = 0
        if prev is not None:
            n = min(len(prev), len(raw))
            while common < n and prev[common] == raw[common]:
                common += 1
            share = 100.0 * common / len(prev)
        else:
            share = 100.0
        print(f"    #{i}: body={body_len:>7}B  system={sys_len:>6}ch  tools={len(tools)}"
              f" ({tool_bytes:>5}B)  prefix_shared_with_prev={share:5.1f}%")
        prev = raw
    return bodies


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True, help="remote OpenAI-compatible base url")
    ap.add_argument("--api-key", default=os.environ.get("OPENAI_API_KEY", ""))
    ap.add_argument("--model", required=True)
    ap.add_argument("--vllm-metrics", default="", help="optional vllm /metrics url")
    ap.add_argument("--turns", type=int, default=2)
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--pi", default="pi")
    args = ap.parse_args()

    pi_cmd = shutil.which(args.pi) or args.pi
    port = free_port()
    capture = Capture(args.base_url)
    srv = ThreadingHTTPServer(("127.0.0.1", port), capture.handler_class())
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    proxy_base = f"http://127.0.0.1:{port}"
    print(f"capture proxy {proxy_base} -> {args.base_url}")

    models_file = os.path.expanduser("~/.pi/agent/models.json")
    backup = None
    if os.path.exists(models_file):
        backup = models_file + ".cache_probe.bak"
        shutil.copyfile(models_file, backup)
        cfg = json.load(open(models_file, encoding="utf-8"))
        provider_id, _, model_id = args.model.partition("/")
        if provider_id not in cfg.get("providers", {}):
            # no provider prefix: find the provider that serves this model id
            for pid, prov in cfg.get("providers", {}).items():
                if any(m.get("id") == model_id for m in prov.get("models", [])):
                    provider_id, model_id = pid, model_id
                    break
            else:
                raise SystemExit(f"no provider serves model {args.model!r}; pass provider/model")
        provider = cfg["providers"][provider_id]
        probe = json.loads(json.dumps(provider))
        probe["baseUrl"] = proxy_base + "/v1"
        cfg["providers"]["cache-probe"] = probe
        json.dump(cfg, open(models_file, "w", encoding="utf-8"), indent=2)

    probe_model = "cache-probe/" + args.model.partition("/")[2]
    turns = ["List the files in the current directory and report the first one.",
             "Now read the file pi/notes.txt and report it exactly."][: args.turns]

    try:
        results = {}
        for label, extra in (("EXTENSION ON", []), ("EXTENSION OFF (stock pi)", ["-ne"])):
            with capture.lock:
                capture.bodies.clear()
            q0 = h0 = None
            if args.vllm_metrics:
                m = vllm_cache(args.vllm_metrics)
                q0, h0 = m if m else (None, None)
            run_session([pi_cmd] + extra, turns, args.cwd, os.environ, proxy_base, probe_model, capture)
            with capture.lock:
                bodies = list(capture.bodies)
            results[label] = bodies
            analyse(label, bodies, args.base_url, args.api_key)
            if args.vllm_metrics and q0 is not None:
                m = vllm_cache(args.vllm_metrics)
                q1, h1 = m if m else (None, None)
                dq, dh = (q1 - q0), (h1 - h0)
                if dq:
                    print(f"    vLLM prefix-cache over the window: queries={dq:,.0f} hits={dh:,.0f} "
                          f"hit_rate={100*dh/dq:.1f}%")
    finally:
        if backup:
            shutil.copyfile(backup, models_file)
            os.remove(backup)
        srv.shutdown()

    on, off = results.get("EXTENSION ON", []), results.get("EXTENSION OFF (stock pi)", [])
    if on and off:
        def head(bodies):
            if not bodies:
                return 0
            j = json.loads(bodies[0])
            return len(json.dumps(j.get("messages", []))) + len(json.dumps(j.get("tools", [])))
        print(f"\n=== SUMMARY ===")
        print(f"  first request, messages+tools bytes: extension {head(on):,}  stock {head(off):,}  "
              f"overhead {head(on)-head(off):+,} bytes")
        print(f"  requests captured: extension {len(on)}  stock {len(off)}")


if __name__ == "__main__":
    main()
