#!/usr/bin/env python3
"""QC_Lite — Audiobook Quality Control CLI.

Usage examples
--------------
Run all checks and print a text report::

    python qc_lite.py --manifest sample_data/sample_project.json --audio-dir /path/to/audio

Save results to a JSON file as well::

    python qc_lite.py --manifest project.json --audio-dir ./audio --output report.json

Exit codes
----------
0   All checks passed.
1   One or more checks failed.
2   Invalid arguments or manifest.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from qc.checker import run_qc
from qc.report import print_report, save_json_report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="qc_lite",
        description="Audiobook QC child application — validates audio files against a Main-app manifest.",
    )
    parser.add_argument(
        "--manifest",
        required=True,
        metavar="FILE",
        help="Path to the JSON manifest produced by the Main app.",
    )
    parser.add_argument(
        "--audio-dir",
        required=True,
        metavar="DIR",
        help="Directory containing the audio files to validate.",
    )
    parser.add_argument(
        "--output",
        metavar="FILE",
        default=None,
        help="Optional path to write a JSON report file.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    manifest_path = Path(args.manifest)
    audio_dir = Path(args.audio_dir)

    if not manifest_path.exists():
        print(f"ERROR: Manifest file not found: {manifest_path}", file=sys.stderr)
        return 2

    if not audio_dir.is_dir():
        print(f"ERROR: Audio directory not found: {audio_dir}", file=sys.stderr)
        return 2

    try:
        report = run_qc(manifest_path, audio_dir)
    except (ValueError, KeyError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    print_report(report)

    if args.output:
        save_json_report(report, args.output)
        print(f"\nJSON report saved to: {args.output}")

    return 0 if report.passed else 1


if __name__ == "__main__":
    sys.exit(main())
