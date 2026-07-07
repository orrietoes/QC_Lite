"""Tests for qc.checker module."""

from __future__ import annotations

import json
import os
import struct
import tempfile
from pathlib import Path

import pytest

from qc.checker import (
    CheckResult,
    QCReport,
    check_file_exists,
    check_filename_convention,
    check_no_extra_files,
    load_manifest,
    run_qc,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SAMPLE_MANIFEST = {
    "project": {
        "title": "Test Book",
        "author": "Test Author",
        "narrator": "Test Narrator",
    },
    "audio_specs": {
        "format": "mp3",
        "bitrate_kbps": 128,
        "sample_rate_hz": 44100,
        "channels": 1,
    },
    "chapters": [
        {
            "number": 1,
            "title": "Opening Credits",
            "filename": "01_Opening_Credits.mp3",
            "duration_seconds": 45.0,
        },
        {
            "number": 2,
            "title": "Chapter 1",
            "filename": "02_Chapter_01.mp3",
            "duration_seconds": 120.0,
        },
    ],
}


def write_manifest(tmp_path: Path, data: dict) -> Path:
    p = tmp_path / "manifest.json"
    p.write_text(json.dumps(data), encoding="utf-8")
    return p


def touch_audio_files(audio_dir: Path, filenames: list) -> None:
    """Create empty placeholder audio files."""
    for name in filenames:
        (audio_dir / name).write_bytes(b"")


# ---------------------------------------------------------------------------
# load_manifest
# ---------------------------------------------------------------------------


class TestLoadManifest:
    def test_valid_manifest(self, tmp_path):
        p = write_manifest(tmp_path, SAMPLE_MANIFEST)
        data = load_manifest(p)
        assert data["project"]["title"] == "Test Book"
        assert len(data["chapters"]) == 2

    def test_file_not_found(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            load_manifest(tmp_path / "nonexistent.json")

    def test_missing_top_level_key(self, tmp_path):
        bad = {k: v for k, v in SAMPLE_MANIFEST.items() if k != "audio_specs"}
        p = write_manifest(tmp_path, bad)
        with pytest.raises(ValueError, match="audio_specs"):
            load_manifest(p)

    def test_missing_project_fields(self, tmp_path):
        bad = {**SAMPLE_MANIFEST, "project": {"title": "Only Title"}}
        p = write_manifest(tmp_path, bad)
        with pytest.raises(ValueError, match="author"):
            load_manifest(p)

    def test_empty_chapters(self, tmp_path):
        bad = {**SAMPLE_MANIFEST, "chapters": []}
        p = write_manifest(tmp_path, bad)
        with pytest.raises(ValueError, match="chapters"):
            load_manifest(p)

    def test_chapter_missing_fields(self, tmp_path):
        bad_chapter = {"number": 1, "title": "Only title"}
        bad = {**SAMPLE_MANIFEST, "chapters": [bad_chapter]}
        p = write_manifest(tmp_path, bad)
        with pytest.raises(ValueError, match="filename"):
            load_manifest(p)


# ---------------------------------------------------------------------------
# check_file_exists
# ---------------------------------------------------------------------------


class TestCheckFileExists:
    def test_file_present(self, tmp_path):
        (tmp_path / "01_Opening_Credits.mp3").write_bytes(b"")
        chapter = SAMPLE_MANIFEST["chapters"][0]
        result = check_file_exists(tmp_path, chapter)
        assert result.passed is True
        assert result.check_name == "file_exists"

    def test_file_missing(self, tmp_path):
        chapter = SAMPLE_MANIFEST["chapters"][0]
        result = check_file_exists(tmp_path, chapter)
        assert result.passed is False
        assert "not found" in result.detail.lower()


# ---------------------------------------------------------------------------
# check_filename_convention
# ---------------------------------------------------------------------------


class TestCheckFilenameConvention:
    def test_valid_filename(self):
        chapter = {"number": 1, "filename": "01_Opening_Credits.mp3"}
        result = check_filename_convention(chapter)
        assert result.passed is True

    def test_invalid_extension(self):
        chapter = {"number": 1, "filename": "01_Chapter.ogg"}
        result = check_filename_convention(chapter)
        assert result.passed is False
        assert "extension" in result.detail.lower()

    def test_invalid_characters(self):
        chapter = {"number": 1, "filename": "01_Chapter@Bad!.mp3"}
        result = check_filename_convention(chapter)
        assert result.passed is False
        assert "invalid characters" in result.detail.lower()

    def test_wrong_chapter_prefix(self):
        chapter = {"number": 3, "filename": "01_Chapter.mp3"}
        result = check_filename_convention(chapter)
        assert result.passed is False
        assert "03_" in result.detail

    def test_valid_wav_filename(self):
        chapter = {"number": 2, "filename": "02_Chapter_01.wav"}
        result = check_filename_convention(chapter)
        assert result.passed is True

    def test_valid_m4b_filename(self):
        chapter = {"number": 5, "filename": "05_Chapter_04.m4b"}
        result = check_filename_convention(chapter)
        assert result.passed is True


# ---------------------------------------------------------------------------
# check_no_extra_files
# ---------------------------------------------------------------------------


class TestCheckNoExtraFiles:
    def test_no_extras(self, tmp_path):
        touch_audio_files(tmp_path, ["01_Opening_Credits.mp3", "02_Chapter_01.mp3"])
        results = check_no_extra_files(tmp_path, SAMPLE_MANIFEST["chapters"])
        assert results == []

    def test_with_extra_file(self, tmp_path):
        touch_audio_files(
            tmp_path,
            ["01_Opening_Credits.mp3", "02_Chapter_01.mp3", "extra_file.mp3"],
        )
        results = check_no_extra_files(tmp_path, SAMPLE_MANIFEST["chapters"])
        assert len(results) == 1
        assert results[0].filename == "extra_file.mp3"
        assert results[0].passed is False

    def test_non_audio_files_ignored(self, tmp_path):
        touch_audio_files(tmp_path, ["01_Opening_Credits.mp3"])
        (tmp_path / "README.txt").write_text("notes")
        results = check_no_extra_files(tmp_path, SAMPLE_MANIFEST["chapters"])
        # README.txt is not an audio file, should be ignored
        assert all(r.filename != "README.txt" for r in results)


# ---------------------------------------------------------------------------
# QCReport properties
# ---------------------------------------------------------------------------


class TestQCReport:
    def test_passed_when_all_pass(self):
        report = QCReport(
            project_title="T",
            author="A",
            narrator="N",
            results=[
                CheckResult(1, "f.mp3", "check1", True),
                CheckResult(2, "g.mp3", "check2", True),
            ],
        )
        assert report.passed is True
        assert len(report.passed_checks) == 2
        assert len(report.failed_checks) == 0

    def test_failed_when_any_fail(self):
        report = QCReport(
            project_title="T",
            author="A",
            narrator="N",
            results=[
                CheckResult(1, "f.mp3", "check1", True),
                CheckResult(2, "g.mp3", "check2", False, "bad"),
            ],
        )
        assert report.passed is False
        assert len(report.failed_checks) == 1


# ---------------------------------------------------------------------------
# run_qc integration
# ---------------------------------------------------------------------------


class TestRunQC:
    def test_all_files_present_and_valid(self, tmp_path):
        manifest_path = write_manifest(tmp_path, SAMPLE_MANIFEST)
        audio_dir = tmp_path / "audio"
        audio_dir.mkdir()
        touch_audio_files(
            audio_dir, ["01_Opening_Credits.mp3", "02_Chapter_01.mp3"]
        )
        report = run_qc(manifest_path, audio_dir)

        assert report.project_title == "Test Book"
        # file_exists and filename_convention checks must pass
        existence_results = [r for r in report.results if r.check_name == "file_exists"]
        assert all(r.passed for r in existence_results)
        convention_results = [
            r for r in report.results if r.check_name == "filename_convention"
        ]
        assert all(r.passed for r in convention_results)

    def test_missing_files_flagged(self, tmp_path):
        manifest_path = write_manifest(tmp_path, SAMPLE_MANIFEST)
        audio_dir = tmp_path / "audio"
        audio_dir.mkdir()
        # Don't create any files
        report = run_qc(manifest_path, audio_dir)

        missing = [r for r in report.results if r.check_name == "file_exists" and not r.passed]
        assert len(missing) == 2

    def test_extra_files_flagged(self, tmp_path):
        manifest_path = write_manifest(tmp_path, SAMPLE_MANIFEST)
        audio_dir = tmp_path / "audio"
        audio_dir.mkdir()
        touch_audio_files(
            audio_dir,
            [
                "01_Opening_Credits.mp3",
                "02_Chapter_01.mp3",
                "99_Unknown_Chapter.mp3",
            ],
        )
        report = run_qc(manifest_path, audio_dir)

        extra = [r for r in report.results if r.check_name == "no_extra_files"]
        assert len(extra) == 1
        assert extra[0].filename == "99_Unknown_Chapter.mp3"
        assert extra[0].passed is False
