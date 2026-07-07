"""Core QC checks for audiobook files.

This module validates audio files against a project manifest produced by the
Main app.  Each check returns a :class:`CheckResult` describing whether the
file passed or failed, along with an optional detail message.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

# Optional dependency – gracefully degrade when mutagen is not installed.
try:
    from mutagen import File as MutagenFile  # type: ignore
    from mutagen.mp3 import MP3  # type: ignore

    _MUTAGEN_AVAILABLE = True
except ImportError:  # pragma: no cover
    _MUTAGEN_AVAILABLE = False


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class CheckResult:
    """Result of a single QC check."""

    chapter_number: int
    filename: str
    check_name: str
    passed: bool
    detail: str = ""


@dataclass
class QCReport:
    """Aggregated results for an entire project."""

    project_title: str
    author: str
    narrator: str
    results: List[CheckResult] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(r.passed for r in self.results)

    @property
    def failed_checks(self) -> List[CheckResult]:
        return [r for r in self.results if not r.passed]

    @property
    def passed_checks(self) -> List[CheckResult]:
        return [r for r in self.results if r.passed]


# ---------------------------------------------------------------------------
# Manifest loading
# ---------------------------------------------------------------------------


def load_manifest(manifest_path: str | Path) -> Dict[str, Any]:
    """Load and validate a project manifest JSON file from the Main app.

    Parameters
    ----------
    manifest_path:
        Path to the JSON manifest produced by the Main app.

    Returns
    -------
    dict
        Parsed manifest dictionary.

    Raises
    ------
    ValueError
        If the manifest is missing required fields.
    FileNotFoundError
        If *manifest_path* does not exist.
    """
    manifest_path = Path(manifest_path)
    if not manifest_path.exists():
        raise FileNotFoundError(f"Manifest not found: {manifest_path}")

    with manifest_path.open("r", encoding="utf-8") as fh:
        data: Dict[str, Any] = json.load(fh)

    _validate_manifest_schema(data)
    return data


def _validate_manifest_schema(data: Dict[str, Any]) -> None:
    """Raise ValueError if mandatory top-level keys are absent."""
    required_top = {"project", "audio_specs", "chapters"}
    missing = required_top - set(data.keys())
    if missing:
        raise ValueError(f"Manifest is missing required keys: {missing}")

    required_project = {"title", "author", "narrator"}
    missing_proj = required_project - set(data.get("project", {}).keys())
    if missing_proj:
        raise ValueError(f"Manifest 'project' is missing keys: {missing_proj}")

    required_specs = {"format", "bitrate_kbps", "sample_rate_hz", "channels"}
    missing_specs = required_specs - set(data.get("audio_specs", {}).keys())
    if missing_specs:
        raise ValueError(f"Manifest 'audio_specs' is missing keys: {missing_specs}")

    if not isinstance(data.get("chapters"), list) or len(data["chapters"]) == 0:
        raise ValueError("Manifest 'chapters' must be a non-empty list.")

    for ch in data["chapters"]:
        required_ch = {"number", "title", "filename", "duration_seconds"}
        missing_ch = required_ch - set(ch.keys())
        if missing_ch:
            raise ValueError(
                f"Chapter entry is missing keys {missing_ch}: {ch}"
            )


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------


def check_file_exists(audio_dir: Path, chapter: Dict[str, Any]) -> CheckResult:
    """Check that the expected audio file is present in *audio_dir*."""
    filename = chapter["filename"]
    path = audio_dir / filename
    exists = path.is_file()
    return CheckResult(
        chapter_number=chapter["number"],
        filename=filename,
        check_name="file_exists",
        passed=exists,
        detail="" if exists else f"File not found: {path}",
    )


# Allowed characters in an audiobook filename (before the extension).
_VALID_FILENAME_RE = re.compile(r"^[\w\-. ]+$")


def check_filename_convention(chapter: Dict[str, Any]) -> CheckResult:
    """Check that the filename follows accepted naming conventions.

    Rules:
    - Must have a recognised audio extension (.mp3, .wav, .flac, .m4b, .aac).
    - Must not contain special characters outside ``[A-Za-z0-9_\\-. ]``.
    - Must start with a two-digit zero-padded chapter number (e.g. ``01_``).
    """
    filename = chapter["filename"]
    stem, _, ext = filename.rpartition(".")
    ext = ext.lower()

    allowed_extensions = {"mp3", "wav", "flac", "m4b", "aac"}
    if ext not in allowed_extensions:
        return CheckResult(
            chapter_number=chapter["number"],
            filename=filename,
            check_name="filename_convention",
            passed=False,
            detail=f"Unsupported extension '.{ext}'. Allowed: {allowed_extensions}",
        )

    if not _VALID_FILENAME_RE.match(stem):
        return CheckResult(
            chapter_number=chapter["number"],
            filename=filename,
            check_name="filename_convention",
            passed=False,
            detail=f"Filename '{filename}' contains invalid characters.",
        )

    # Expect zero-padded chapter number prefix (e.g. "01_", "02_", …)
    num = chapter["number"]
    expected_prefix = f"{num:02d}_"
    if not stem.startswith(expected_prefix):
        return CheckResult(
            chapter_number=chapter["number"],
            filename=filename,
            check_name="filename_convention",
            passed=False,
            detail=(
                f"Filename should start with zero-padded chapter number "
                f"'{expected_prefix}', got '{stem[:3]}'."
            ),
        )

    return CheckResult(
        chapter_number=chapter["number"],
        filename=filename,
        check_name="filename_convention",
        passed=True,
    )


def check_audio_properties(
    audio_dir: Path,
    chapter: Dict[str, Any],
    audio_specs: Dict[str, Any],
    duration_tolerance_seconds: float = 5.0,
) -> List[CheckResult]:
    """Check audio file properties against the expected spec.

    Requires *mutagen* to be installed.  If mutagen is not available, the
    check is skipped with a warning result.

    Checks performed:
    - Bitrate (kbps) – within 5 kbps of the expected value.
    - Sample rate (Hz) – exact match.
    - Channel count – exact match.
    - Duration – within *duration_tolerance_seconds* of the expected value.
    """
    filename = chapter["filename"]
    path = audio_dir / filename

    if not _MUTAGEN_AVAILABLE:
        return [
            CheckResult(
                chapter_number=chapter["number"],
                filename=filename,
                check_name="audio_properties",
                passed=True,
                detail="mutagen not installed – audio properties check skipped.",
            )
        ]

    if not path.is_file():
        # file_exists check will already flag this; skip here.
        return []

    results: List[CheckResult] = []

    try:
        audio = MutagenFile(str(path), easy=False)
    except Exception as exc:  # noqa: BLE001
        results.append(
            CheckResult(
                chapter_number=chapter["number"],
                filename=filename,
                check_name="audio_properties",
                passed=False,
                detail=f"Could not parse audio file: {exc}",
            )
        )
        return results

    if audio is None:
        results.append(
            CheckResult(
                chapter_number=chapter["number"],
                filename=filename,
                check_name="audio_properties",
                passed=False,
                detail=f"mutagen could not read audio file: {path}",
            )
        )
        return results

    # --- Duration ---
    expected_duration = float(chapter["duration_seconds"])
    actual_duration = getattr(audio.info, "length", None)
    if actual_duration is not None:
        diff = abs(actual_duration - expected_duration)
        passed = diff <= duration_tolerance_seconds
        results.append(
            CheckResult(
                chapter_number=chapter["number"],
                filename=filename,
                check_name="duration",
                passed=passed,
                detail=(
                    ""
                    if passed
                    else (
                        f"Expected {expected_duration:.1f}s, "
                        f"got {actual_duration:.1f}s "
                        f"(diff {diff:.1f}s > tolerance {duration_tolerance_seconds}s)."
                    )
                ),
            )
        )

    # --- Bitrate (MP3 only) ---
    expected_bitrate = int(audio_specs.get("bitrate_kbps", 0))
    actual_bitrate = getattr(audio.info, "bitrate", None)
    if actual_bitrate is not None and expected_bitrate:
        actual_kbps = actual_bitrate // 1000
        passed = abs(actual_kbps - expected_bitrate) <= 5
        results.append(
            CheckResult(
                chapter_number=chapter["number"],
                filename=filename,
                check_name="bitrate",
                passed=passed,
                detail=(
                    ""
                    if passed
                    else f"Expected ~{expected_bitrate} kbps, got {actual_kbps} kbps.",
                ),
            )
        )

    # --- Sample rate ---
    expected_sample_rate = int(audio_specs.get("sample_rate_hz", 0))
    actual_sample_rate = getattr(audio.info, "sample_rate", None)
    if actual_sample_rate is not None and expected_sample_rate:
        passed = actual_sample_rate == expected_sample_rate
        results.append(
            CheckResult(
                chapter_number=chapter["number"],
                filename=filename,
                check_name="sample_rate",
                passed=passed,
                detail=(
                    ""
                    if passed
                    else (
                        f"Expected {expected_sample_rate} Hz, "
                        f"got {actual_sample_rate} Hz."
                    )
                ),
            )
        )

    # --- Channels ---
    expected_channels = int(audio_specs.get("channels", 0))
    actual_channels = getattr(audio.info, "channels", None)
    if actual_channels is not None and expected_channels:
        passed = actual_channels == expected_channels
        results.append(
            CheckResult(
                chapter_number=chapter["number"],
                filename=filename,
                check_name="channels",
                passed=passed,
                detail=(
                    ""
                    if passed
                    else (
                        f"Expected {expected_channels} channel(s), "
                        f"got {actual_channels}."
                    )
                ),
            )
        )

    return results


def check_no_extra_files(
    audio_dir: Path,
    chapters: List[Dict[str, Any]],
    audio_extensions: Optional[set] = None,
) -> List[CheckResult]:
    """Check that no unexpected audio files exist in *audio_dir*.

    Any audio file present in the directory that is not listed in the manifest
    is flagged as an extra file.
    """
    if audio_extensions is None:
        audio_extensions = {"mp3", "wav", "flac", "m4b", "aac"}

    expected_filenames = {ch["filename"] for ch in chapters}
    results: List[CheckResult] = []

    for entry in sorted(audio_dir.iterdir()):
        if not entry.is_file():
            continue
        if entry.suffix.lstrip(".").lower() not in audio_extensions:
            continue
        if entry.name not in expected_filenames:
            results.append(
                CheckResult(
                    chapter_number=0,
                    filename=entry.name,
                    check_name="no_extra_files",
                    passed=False,
                    detail=f"Unexpected file found in directory: {entry.name}",
                )
            )

    return results


# ---------------------------------------------------------------------------
# High-level runner
# ---------------------------------------------------------------------------


def run_qc(manifest_path: str | Path, audio_dir: str | Path) -> QCReport:
    """Run all QC checks and return a :class:`QCReport`.

    Parameters
    ----------
    manifest_path:
        Path to the JSON manifest produced by the Main app.
    audio_dir:
        Directory containing the audio files to be checked.
    """
    manifest = load_manifest(manifest_path)
    audio_dir = Path(audio_dir)

    project = manifest["project"]
    audio_specs = manifest["audio_specs"]
    chapters = manifest["chapters"]

    report = QCReport(
        project_title=project["title"],
        author=project["author"],
        narrator=project["narrator"],
    )

    for chapter in chapters:
        # 1. File existence
        report.results.append(check_file_exists(audio_dir, chapter))

        # 2. Filename convention
        report.results.append(check_filename_convention(chapter))

        # 3. Audio properties (requires mutagen)
        report.results.extend(
            check_audio_properties(audio_dir, chapter, audio_specs)
        )

    # 4. Extra files
    report.results.extend(check_no_extra_files(audio_dir, chapters))

    return report
