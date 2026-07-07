"""Tests for qc.report module."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from qc.checker import CheckResult, QCReport
from qc.report import build_json_report, format_text_report, save_json_report


def make_report(passed: bool = True) -> QCReport:
    return QCReport(
        project_title="My Book",
        author="Auth",
        narrator="Narr",
        results=[
            CheckResult(1, "01_Intro.mp3", "file_exists", True),
            CheckResult(1, "01_Intro.mp3", "filename_convention", passed),
        ],
    )


class TestFormatTextReport:
    def test_contains_project_info(self):
        report = make_report()
        text = format_text_report(report)
        assert "My Book" in text
        assert "Auth" in text
        assert "Narr" in text

    def test_pass_overall(self):
        report = make_report(passed=True)
        text = format_text_report(report)
        assert "OVERALL: PASS" in text

    def test_fail_overall(self):
        report = make_report(passed=False)
        text = format_text_report(report)
        assert "OVERALL: FAIL" in text

    def test_summary_counts(self):
        report = make_report(passed=False)
        text = format_text_report(report)
        # 2 results, 1 passed, 1 failed
        assert "1/2" in text


class TestBuildJsonReport:
    def test_structure(self):
        report = make_report()
        data = build_json_report(report)
        assert data["project"]["title"] == "My Book"
        assert "summary" in data
        assert "results" in data
        assert data["summary"]["total_checks"] == 2

    def test_all_passed(self):
        report = make_report(passed=True)
        data = build_json_report(report)
        assert data["summary"]["overall_passed"] is True

    def test_failed(self):
        report = make_report(passed=False)
        data = build_json_report(report)
        assert data["summary"]["overall_passed"] is False
        assert data["summary"]["failed"] == 1


class TestSaveJsonReport:
    def test_saves_valid_json(self, tmp_path):
        report = make_report()
        output = tmp_path / "report.json"
        save_json_report(report, output)
        assert output.exists()
        data = json.loads(output.read_text())
        assert data["project"]["title"] == "My Book"
