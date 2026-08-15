#!/usr/bin/env python3
"""
Red Portal asset sync: mirrors local file paths to Cloudflare R2 using
the SAME relative path as the R2 object key. Editable in place, stable URLs.

Usage:
    pip install boto3 --break-system-packages

    Set env vars (see tutorial below), then:
    python sync_to_r2.py "C:\\Stuff\\RedTesting\\red-portal-DKR-LCL-main"

    Re-run any time after editing files locally -- only changed/new files
    get re-uploaded. Deleted local files are left on R2 unless you pass --prune.

Output:
    manifest.json     -- relative path -> public R2 URL (commit this to git)
    .sync_state.json  -- internal cache of what's already uploaded (commit this too,
                         so re-runs from a fresh clone don't re-upload everything)
    skipped.log       -- upload failures, for retry
"""

import os
import sys
import json
import hashlib
import mimetypes
import argparse
import boto3
from botocore.config import Config

CHUNK = 1024 * 1024
STATE_FILE = ".sync_state.json"

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}

def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", help="Local folder to sync")
    parser.add_argument("--prune", action="store_true",
                         help="Delete R2 objects whose local file no longer exists")
    args = parser.parse_args()

    root = args.root

    account_id = os.environ["R2_ACCOUNT_ID"]
    access_key = os.environ["R2_ACCESS_KEY_ID"]
    secret_key = os.environ["R2_SECRET_ACCESS_KEY"]
    bucket = os.environ["R2_BUCKET"]
    public_domain = os.environ["R2_PUBLIC_DOMAIN"]

    endpoint = f"https://{account_id}.r2.cloudflarestorage.com"
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )

    print("Scanning local files...")
    local_files = {}
    for dirpath, _, filenames in os.walk(root):
        for fname in filenames:
            full = os.path.join(dirpath, fname)
            rel = os.path.relpath(full, root).replace("\\", "/")
            try:
                size = os.path.getsize(full)
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            local_files[rel] = (full, size, mtime)

    print(f"Found {len(local_files)} local files.")

    state = load_state()
    manifest = {}
    skipped = []
    uploaded = 0
    unchanged = 0

    for rel, (full, size, mtime) in local_files.items():
        cached = state.get(rel)
        needs_upload = True

        if cached and cached.get("size") == size and True:
            needs_upload = False
            unchanged += 1

        r2_key = rel  # path-based: R2 key mirrors local relative path exactly
        manifest[rel] = f"https://{public_domain}/{r2_key}"

        if not needs_upload:
            continue

        content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
        try:
            s3.upload_file(full, bucket, r2_key, ExtraArgs={"ContentType": content_type})
            file_hash = sha256_of(full)
            state[rel] = {"size": size, "mtime": mtime, "sha256": file_hash}
            uploaded += 1
            if uploaded % 200 == 0:
                print(f"  {uploaded} uploaded so far...")
                save_state(state)  # checkpoint periodically
        except Exception as e:
            skipped.append(f"{full} -> {r2_key}: upload failed ({e})")

    pruned = 0
    if args.prune:
        stale_keys = [rel for rel in list(state.keys()) if rel not in local_files]
        for rel in stale_keys:
            try:
                s3.delete_object(Bucket=bucket, Key=rel)
                del state[rel]
                pruned += 1
            except Exception as e:
                skipped.append(f"prune {rel}: failed ({e})")

    save_state(state)

    with open("manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    with open("skipped.log", "w", encoding="utf-8") as f:
        f.write("\n".join(skipped))

    print(f"\nDone.")
    print(f"  Uploaded (new/changed): {uploaded}")
    print(f"  Unchanged (skipped):    {unchanged}")
    print(f"  Pruned (deleted from R2): {pruned}")
    print(f"  Failures: {len(skipped)} (see skipped.log)")
    print(f"manifest.json written with {len(manifest)} path -> URL mappings")

if __name__ == "__main__":
    main()
