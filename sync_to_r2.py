#!/usr/bin/env python3
"""
Red Portal asset sync: mirrors local file paths to Cloudflare R2 using
the SAME relative path as the R2 object key. Editable in place, stable URLs.

Usage:
    pip install boto3 --break-system-packages

    Set env vars (see below), then:
    python sync_to_r2.py "C:\\Stuff\\RedTesting\\red-portal-DKR-LCL-main"

    Re-run any time after editing files locally -- only changed/new files
    get re-uploaded.

Fixing files that are missing on R2 even though the sync thinks it sent them:
    python sync_to_r2.py <root> --repair

    Lists the bucket and re-uploads any local file that is not actually in
    it. Uploads only -- it never deletes. Worth running whenever a game is
    on the site but 404s.

Mirroring (deleting remote files that no longer exist locally):
    python sync_to_r2.py <root> --prune            # DRY RUN: writes prune-plan.txt
    python sync_to_r2.py <root> --prune --yes      # actually delete

    --prune without --yes never deletes anything. Read prune-plan.txt first;
    it is the exact list. --max-deletes guards against a mistake wiping the
    bucket (default 500; raise it deliberately once you have read the plan).

Output:
    manifest.json     -- relative path -> public R2 URL (Red Portal reads this
                         FROM R2 to build its game lists)
    .sync_state.json  -- local upload cache; never uploaded
    skipped.log       -- upload failures, for retry
    prune-plan.txt    -- what --prune would delete
"""

import os
import sys
import json
import time
import hashlib
import mimetypes
import argparse
import boto3
from botocore.config import Config

CHUNK = 1024 * 1024
STATE_FILE = ".sync_state.json"
MANIFEST_FILE = "manifest.json"
PLAN_FILE = "prune-plan.txt"

# Never upload these. They are either private (credentials, git history),
# enormous and pointless on a CDN (dependency trees), or bookkeeping this
# script writes itself. .git in particular is a disclosure problem: served
# from a public bucket it hands out the entire repository history.
EXCLUDE_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".idea", ".vscode", ".pytest_cache", ".mypy_cache", ".next", ".cache",
}
EXCLUDE_FILES = {STATE_FILE, PLAN_FILE, "skipped.log", ".DS_Store", "Thumbs.db"}
EXCLUDE_PREFIXES = (".env",)          # .env, .env.local, .env.production, ...
EXCLUDE_SUFFIXES = (".pem", ".key", ".pfx", ".p12")


def is_excluded_file(name):
    if name in EXCLUDE_FILES:
        return True
    if name.startswith(EXCLUDE_PREFIXES):
        return True
    if name.endswith(EXCLUDE_SUFFIXES):
        return True
    return False


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
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError) as e:
            print("  !  " + STATE_FILE + " unreadable (" + str(e) + "); treating everything as new.")
    return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)


def scan_local(root):
    """Relative path -> (full path, size, mtime), excluding the ignore lists."""
    local_files = {}
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune ignored directories in place so os.walk never descends into them.
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fname in filenames:
            if is_excluded_file(fname):
                continue
            full = os.path.join(dirpath, fname)
            rel = os.path.relpath(full, root).replace("\\", "/")
            try:
                st = os.stat(full)
            except OSError:
                continue
            local_files[rel] = (full, st.st_size, st.st_mtime)
    return local_files


def needs_upload(cached, size, mtime, full, verify_hash):
    """Size AND mtime, not size alone.

    Comparing only size meant an edit that happened to preserve the file's
    length was never re-uploaded -- silently stale on R2 forever. When the
    size matches but the mtime moved (a rebuild, a fresh checkout) the file
    usually has not really changed, so hash it before spending the upload.
    """
    if not cached:
        return True, None
    if cached.get("size") != size:
        return True, None
    if cached.get("mtime") == mtime and not verify_hash:
        return False, None
    digest = sha256_of(full)
    if cached.get("sha256") != digest:
        return True, digest
    return False, digest


def list_bucket_keys(s3, bucket):
    """Every key actually in the bucket -- not just the ones this machine
    happens to have uploaded. The old prune walked .sync_state.json, so
    objects from an earlier run, another machine, or a since-deleted state
    file were invisible to it and survived forever."""
    keys = set()
    token = None
    pages = 0
    while True:
        kwargs = {"Bucket": bucket}
        if token:
            kwargs["ContinuationToken"] = token
        resp = s3.list_objects_v2(**kwargs)
        for obj in resp.get("Contents", []):
            keys.add(obj["Key"])
        pages += 1
        if pages % 20 == 0:
            print("  ...listed " + str(len(keys)) + " remote objects so far")
        if not resp.get("IsTruncated"):
            break
        token = resp.get("NextContinuationToken")
    return keys


def _flush_delete(s3, bucket, batch, deleted, failed):
    try:
        resp = s3.delete_objects(Bucket=bucket, Delete={"Objects": batch, "Quiet": True})
        errors = resp.get("Errors", [])
        for err in errors:
            failed.append("prune " + str(err.get("Key")) + ": " + str(err.get("Message")))
        deleted += len(batch) - len(errors)
        print("  deleted " + str(deleted) + " objects...")
    except Exception as e:
        failed.append("prune batch of " + str(len(batch)) + ": " + str(e))
    return deleted, failed


def delete_keys(s3, bucket, keys):
    """R2 accepts 1000 keys per delete_objects call."""
    deleted = 0
    failed = []
    batch = []
    for key in keys:
        batch.append({"Key": key})
        if len(batch) == 1000:
            deleted, failed = _flush_delete(s3, bucket, batch, deleted, failed)
            batch = []
    if batch:
        deleted, failed = _flush_delete(s3, bucket, batch, deleted, failed)
    return deleted, failed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", help="Local folder to sync")
    parser.add_argument("--prune", action="store_true",
                        help="Mirror: plan deletion of every remote object with no local file")
    parser.add_argument("--yes", action="store_true",
                        help="Actually perform the pruning deletions (without this, --prune is a dry run)")
    parser.add_argument("--max-deletes", type=int, default=500,
                        help="Refuse to delete more than this many objects (default 500)")
    parser.add_argument("--verify-hash", action="store_true",
                        help="Hash every file rather than trusting size+mtime")
    parser.add_argument("--repair", action="store_true",
                        help="List the bucket and re-upload any local file that is missing from it")
    args = parser.parse_args()

    root = args.root

    try:
        account_id = os.environ["R2_ACCOUNT_ID"]
        access_key = os.environ["R2_ACCESS_KEY_ID"]
        secret_key = os.environ["R2_SECRET_ACCESS_KEY"]
        bucket = os.environ["R2_BUCKET"]
        public_domain = os.environ["R2_PUBLIC_DOMAIN"]
    except KeyError as e:
        sys.exit("Missing required environment variable: " + e.args[0])

    endpoint = "https://" + account_id + ".r2.cloudflarestorage.com"
    s3 = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )

    print("Scanning local files...")
    local_files = scan_local(root)
    print("Found " + str(len(local_files)) + " local files (excluding "
          + ", ".join(sorted(EXCLUDE_DIRS)) + ").")

    # One bucket listing serves both --repair and --prune.
    #
    # --repair exists because .sync_state.json is a record of what this
    # machine BELIEVES it uploaded, and that is not the same as what the
    # bucket holds. Anything that goes missing remotely -- a half-finished
    # upload, an earlier prune, a manual delete -- stays missing forever,
    # because the state says "already uploaded" and the file has not changed
    # since. Found on the live bucket: Testing/Polytrack had all 149 files
    # recorded as uploaded and listed in the manifest, and every one of them
    # 404s. Nothing short of comparing against the bucket finds that.
    remote = None
    if args.repair or args.prune:
        print("Listing remote objects (this is a full bucket listing)...")
        remote = list_bucket_keys(s3, bucket)
        print("Found " + str(len(remote)) + " remote objects.")

    state = load_state()
    manifest = {}
    skipped = []
    uploaded = 0
    unchanged = 0
    repaired = 0

    for rel, (full, size, mtime) in local_files.items():
        r2_key = rel  # path-based: R2 key mirrors local relative path exactly
        manifest[rel] = "https://" + public_domain + "/" + r2_key

        upload, digest = needs_upload(state.get(rel), size, mtime, full, args.verify_hash)
        if not upload and remote is not None and r2_key not in remote:
            upload = True
            repaired += 1
        if not upload:
            unchanged += 1
            # Refresh the recorded mtime so an unchanged file is not re-hashed
            # on every future run.
            entry = state.get(rel)
            if entry is not None:
                entry["mtime"] = mtime
                if digest:
                    entry["sha256"] = digest
            continue

        content_type = mimetypes.guess_type(full)[0] or "application/octet-stream"
        try:
            s3.upload_file(full, bucket, r2_key, ExtraArgs={"ContentType": content_type})
            state[rel] = {
                "size": size,
                "mtime": mtime,
                "sha256": digest or sha256_of(full),
            }
            uploaded += 1
            if uploaded % 200 == 0:
                print("  " + str(uploaded) + " uploaded so far...")
                save_state(state)  # checkpoint periodically
        except Exception as e:
            skipped.append(full + " -> " + r2_key + ": upload failed (" + str(e) + ")")

    # Drop state entries for files that no longer exist locally, so the cache
    # does not grow without bound.
    for rel in [k for k in state if k not in local_files]:
        del state[rel]
    save_state(state)

    # -- manifest.json ------------------------------------------------
    # Write it, then upload it EXPLICITLY.
    #
    # It used to reach R2 only because the directory walk happened to pick it
    # up -- but the walk runs before this file is written, so what landed on
    # R2 was always the PREVIOUS run's manifest. Red Portal reads the manifest
    # from R2 to build its game lists, so each sync's newly added games stayed
    # invisible until the run after that. Measured on the live bucket: the
    # manifest R2 was serving lacked 11 files of a game added that same day.
    manifest[MANIFEST_FILE] = "https://" + public_domain + "/" + MANIFEST_FILE
    with open(MANIFEST_FILE, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    try:
        s3.upload_file(MANIFEST_FILE, bucket, MANIFEST_FILE,
                       ExtraArgs={"ContentType": "application/json"})
        print("Uploaded " + MANIFEST_FILE + " (" + str(len(manifest)) + " entries).")
    except Exception as e:
        skipped.append(MANIFEST_FILE + ": upload failed (" + str(e) + ")")
        print("  !  " + MANIFEST_FILE + " failed to upload (" + str(e)
              + ") -- Red Portal will keep serving a stale game list.")

    # -- prune --------------------------------------------------------
    pruned = 0
    if args.prune:
        keep = set(local_files) | {MANIFEST_FILE}
        stale = sorted(remote - keep)

        with open(PLAN_FILE, "w", encoding="utf-8") as f:
            f.write("\n".join(stale))
        print("")
        print("  Remote objects:      " + str(len(remote)))
        print("  Local files:         " + str(len(local_files)))
        print("  Would delete:        " + str(len(stale)) + "   (written to " + PLAN_FILE + ")")

        if not stale:
            pass
        elif not args.yes:
            print("")
            print("  DRY RUN -- nothing deleted. Read " + PLAN_FILE + ", then re-run with --yes.")
        elif len(stale) > args.max_deletes:
            print("")
            print("  REFUSING to delete " + str(len(stale)) + " objects: over --max-deletes ("
                  + str(args.max_deletes) + ").")
            print("  Read " + PLAN_FILE + ". If it is correct, re-run with --max-deletes "
                  + str(len(stale)) + ".")
        else:
            print("")
            print("  Deleting " + str(len(stale)) + " objects...")
            started = time.time()
            pruned, prune_failures = delete_keys(s3, bucket, stale)
            skipped.extend(prune_failures)
            print("  Pruning took " + format(time.time() - started, ".1f") + "s")

    with open("skipped.log", "w", encoding="utf-8") as f:
        f.write("\n".join(skipped))

    print("")
    print("Done.")
    print("  Uploaded (new/changed):   " + str(uploaded))
    if remote is not None:
        print("  Re-uploaded (missing on R2 but recorded as uploaded): " + str(repaired))
    print("  Unchanged (skipped):      " + str(unchanged))
    print("  Pruned (deleted from R2): " + str(pruned))
    print("  Failures: " + str(len(skipped)) + " (see skipped.log)")
    print("manifest.json written and uploaded with " + str(len(manifest)) + " path -> URL mappings")


if __name__ == "__main__":
    main()
