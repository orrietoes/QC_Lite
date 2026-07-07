# QC_Lite
Lite version of QC tool for Audiobook QC check

## Overview

QC_Lite is a **child application** that validates audiobook audio files against
a project manifest produced by the **Main app**.  It runs a suite of QC checks
and produces both a human-readable console report and an optional structured
JSON output.

## Prerequisites

- Python 3.9+
- [mutagen](https://mutagen.readthedocs.io/) (for audio-property checks)

Install all dependencies:

```bash
pip install -r requirements.txt
```

## Usage

```bash
python qc_lite.py --manifest <path/to/manifest.json> --audio-dir <path/to/audio/> [--output report.json]
```

| Flag | Description |
|------|-------------|
| `--manifest` | *(required)* Path to the JSON manifest produced by the Main app |
| `--audio-dir` | *(required)* Directory containing the audio files to validate |
| `--output` | *(optional)* Path to write a JSON report file |

**Exit codes**

| Code | Meaning |
|------|---------|
| `0` | All checks passed |
| `1` | One or more checks failed |
| `2` | Invalid arguments or manifest |

### Example

```bash
python qc_lite.py \
  --manifest sample_data/sample_project.json \
  --audio-dir /path/to/audio \
  --output qc_report.json
```

## Main App Manifest Format

QC_Lite expects the Main app to produce a JSON manifest in the following format:

```json
{
  "project": {
    "title": "The Great Adventure",
    "author": "Jane Doe",
    "narrator": "John Smith",
    "isbn": "978-0-000-00000-0"
  },
  "audio_specs": {
    "format": "mp3",
    "bitrate_kbps": 128,
    "sample_rate_hz": 44100,
    "channels": 1
  },
  "chapters": [
    {
      "number": 1,
      "title": "Opening Credits",
      "filename": "01_Opening_Credits.mp3",
      "duration_seconds": 45.0
    }
  ]
}
```

A complete sample manifest is provided in [`sample_data/sample_project.json`](sample_data/sample_project.json).

## QC Checks

| Check | Description |
|-------|-------------|
| `file_exists` | Each chapter file listed in the manifest is present in the audio directory |
| `filename_convention` | Filenames use a valid audio extension, contain no special characters, and start with a zero-padded chapter number (e.g. `01_`) |
| `audio_properties` | Bitrate, sample rate, channel count, and duration match the manifest spec (requires mutagen) |
| `no_extra_files` | No unexpected audio files exist in the audio directory |

## Running Tests

```bash
python -m pytest tests/ -v
```
