#!/usr/bin/env python3
"""Trigger pikan-bot's historical-post workflow for a Japan-time slot."""

import argparse
import json
import os
import sys
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


def main() -> int:
    parser = argparse.ArgumentParser(description="Dispatch a pikan-bot historical post.")
    parser.add_argument("post_slot", choices=("0730", "1205", "1815"))
    parser.add_argument("--prepare-only", action="store_true", help="do not publish to X")
    args = parser.parse_args()

    repository = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    workflow_id = os.environ.get("PIKAN_WORKFLOW_ID", "post-historical-events.yml")
    ref = os.environ.get("PIKAN_GITHUB_REF", "main")
    if repository.count("/") != 1:
        parser.error("GITHUB_REPOSITORY must be set as owner/repository")
    if not token:
        parser.error("GH_TOKEN or GITHUB_TOKEN must be set")

    posting_date = datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()
    payload = {
        "ref": ref,
        "inputs": {
            "post_slot": args.post_slot,
            "posting_date": posting_date,
            "post_to_x": "false" if args.prepare_only else "true",
        },
    }
    request = Request(
        f"https://api.github.com/repos/{repository}/actions/workflows/{workflow_id}/dispatches",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "pikan-bot-vps-dispatch",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=30) as response:
            if response.status != 204:
                print(f"GitHub API returned HTTP {response.status}", file=sys.stderr)
                return 1
    except HTTPError as error:
        print(f"GitHub API rejected the dispatch (HTTP {error.code}).", file=sys.stderr)
        return 1
    except (URLError, TimeoutError) as error:
        print(f"Could not reach GitHub API: {error}", file=sys.stderr)
        return 1

    print(f"Dispatched {posting_date}-{args.post_slot} (post_to_x={not args.prepare_only}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())