"""Report generation for QC_Lite.

Formats a :class:`~qc.checker.QCReport` as plain-text console output or as a
structured JSON file suitable for archiving or downstream processing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

from qc.checker import QCReport


# ---------------------------------------------------------------------------
# Console (text) report
# ---------------------------------------------------------------------------

_PASS = "PASS"
_FAIL = "FAIL"
_SEP = "-" * 72


def format_text_report(report: QCReport) -> str:
    """Return a human-readable text report as a string."""
    lines = [
        _SEP,
        "QC_LITE — AUDIOBOOK QUALITY CONTROL REPORT",
        _SEP,
        f"Project : {report.project_title}",
        f"Author  : {report.author}",
        f"Narrator: {report.narrator}",
        _SEP,
    ]

    total = len(report.results)
    passed = len(report.passed_checks)
    failed = len(report.failed_checks)

    # Group results by filename for readability
    by_file: dict[str, list] = {}
    for r in report.results:
        by_file.setdefault(r.filename or "(project)", []).append(r)

    for filename, checks in by_file.items():
        lines.append(f"\n  {filename}")
        for chk in checks:
            status = _PASS if chk.passed else _FAIL
            line = f"    [{status}] {chk.check_name}"
            if chk.detail:
                line += f" — {chk.detail}"
            lines.append(line)

    lines.append("")
    lines.append(_SEP)
    lines.append(f"Summary: {passed}/{total} checks passed, {failed} failed.")
    overall = "OVERALL: PASS ✓" if report.passed else "OVERALL: FAIL ✗"
    lines.append(overall)
    lines.append(_SEP)

    return "\n".join(lines)


def print_report(report: QCReport) -> None:
    """Print the text report to stdout."""
    print(format_text_report(report))


# ---------------------------------------------------------------------------
# JSON report
# ---------------------------------------------------------------------------


def build_json_report(report: QCReport) -> dict:
    """Build a serialisable dictionary from *report*."""
    return {
        "project": {
            "title": report.project_title,
            "author": report.author,
            "narrator": report.narrator,
        },
        "summary": {
            "total_checks": len(report.results),
            "passed": len(report.passed_checks),
            "failed": len(report.failed_checks),
            "overall_passed": report.passed,
        },
        "results": [
            {
                "chapter_number": r.chapter_number,
                "filename": r.filename,
                "check_name": r.check_name,
                "passed": r.passed,
                "detail": r.detail,
            }
            for r in report.results
        ],
    }


def save_json_report(report: QCReport, output_path: str | Path) -> None:
    """Write the QC report as JSON to *output_path*."""
    output_path = Path(output_path)
    data = build_json_report(report)
    with output_path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
