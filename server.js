'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { normalizeTextToken, progressiveAnchorAlignment } = require('./alignment');
const { generateExcelReport } = require('./report_export');

const app = express();
app.use(express.json());

// ── project folder set by main process ──────────────────────────────────────
let PROJECT_FOLDER = null;

function setProjectFolder(folderPath) {
    PROJECT_FOLDER = folderPath;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function loadJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function ensureL2(projectFolder) {
    const qcDir  = path.join(projectFolder, 'qc');
    const l2Path = path.join(qcDir, 'l2.json');
    if (!fs.existsSync(l2Path)) {
        fs.mkdirSync(qcDir, { recursive: true });
        saveJson(l2Path, { sections: {} });
    }
    return l2Path;
}

function getScriptData(projectFolder) {
    const p = path.join(projectFolder, 'script.json');
    if (!fs.existsSync(p)) return null;
    return loadJson(p);
}

function getTranscriptionData(projectFolder) {
    const p = path.join(projectFolder, 'qc', 'transcription.json');
    if (!fs.existsSync(p)) return null;
    return loadJson(p);
}

function getPrecomputedAlignment(projectFolder, sectionId, scriptData) {
    if (!scriptData) scriptData = getScriptData(projectFolder);
    const sectionData = (scriptData && scriptData.sections || {})[sectionId] || {};
    if (sectionData.timestamp_map && Object.keys(sectionData.timestamp_map).length) {
        return {
            timestampMap: sectionData.timestamp_map,
            scriptStartTime: sectionData.script_start_time || 0
        };
    }

    const p = path.join(projectFolder, 'qc', 'alignment.json');
    if (!fs.existsSync(p)) return null;
    try {
        const alignmentData = loadJson(p);
        const sec = (alignmentData.sections || {})[sectionId] || {};
        if (sec.timestamp_map && Object.keys(sec.timestamp_map).length) {
            return {
                timestampMap: sec.timestamp_map,
                scriptStartTime: sec.script_start_time || 0
            };
        }
    } catch (e) {
        console.error('Error reading alignment.json:', e);
    }
    return null;
}

function getAudioFile(projectFolder, sectionId) {
    const audioDir = path.join(projectFolder, 'audio');
    if (!fs.existsSync(audioDir)) return null;
    const num = sectionId.replace('sec_', '');
    const numNoZero = num.replace(/^0+/, '') || '0';
    const files = fs.readdirSync(audioDir);
    for (const f of files) {
        const fl = f.toLowerCase();
        if ((fl.startsWith(num) || fl.startsWith(numNoZero)) &&
            (fl.endsWith('.mp3') || fl.endsWith('.wav'))) {
            return f;
        }
    }
    return null;
}

function getProjectPdfFile(projectFolder) {
    const files = fs.readdirSync(projectFolder, { withFileTypes: true });
    const pdf = files.find(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf');
    return pdf ? path.join(projectFolder, pdf.name) : null;
}

// ── WAV peaks generation (pure Node stdlib) ──────────────────────────────────
function generatePeaksFromWav(wavPath) {
    const buf = fs.readFileSync(wavPath);

    // parse WAV header
    const riff      = buf.toString('ascii', 0, 4);
    if (riff !== 'RIFF') throw new Error('Not a valid WAV file');
    const format    = buf.toString('ascii', 8, 12);
    if (format !== 'WAVE') throw new Error('Not a valid WAVE file');

    let offset = 12;
    let fmtFound = false, dataOffset = 0, dataSize = 0;
    let sampleRate = 44100, numChannels = 1, bitsPerSample = 16;

    while (offset < buf.length - 8) {
        const chunkId   = buf.toString('ascii', offset, offset + 4);
        const chunkSize = buf.readUInt32LE(offset + 4);
        offset += 8;

        if (chunkId === 'fmt ') {
            numChannels  = buf.readUInt16LE(offset + 2);
            sampleRate   = buf.readUInt32LE(offset + 4);
            bitsPerSample = buf.readUInt16LE(offset + 14);
            fmtFound = true;
        } else if (chunkId === 'data') {
            dataOffset = offset;
            dataSize   = chunkSize;
            break;
        }
        offset += chunkSize + (chunkSize & 1); // pad to word
    }

    if (!fmtFound || dataOffset === 0) throw new Error('Malformed WAV file');

    const bytesPerSample = bitsPerSample / 8;
    // Use actual buffer capacity as safety bound (file may be truncated)
    const maxSamples     = Math.floor((buf.length - dataOffset) / (bytesPerSample * numChannels));
    const totalSamples   = Math.min(Math.floor(dataSize / (bytesPerSample * numChannels)), maxSamples);
    const levels = [];

    for (const block of [256, 1024, 4096]) {
        const data = [];
        for (let i = 0; i < totalSamples; i += block) {
            let mn = Infinity, mx = -Infinity;
            const end = Math.min(i + block, totalSamples);
            for (let s = i; s < end; s++) {
                const bytePos = dataOffset + s * bytesPerSample * numChannels;
                if (bytePos + bytesPerSample > buf.length) break; // safety guard
                let v = 0;
                if (bitsPerSample === 16) {
                    v = buf.readInt16LE(bytePos) / 32768.0;
                } else if (bitsPerSample === 24) {
                    const lo = buf[bytePos], mid = buf[bytePos+1], hi = buf.readInt8(bytePos+2);
                    v = ((hi << 16) | (mid << 8) | lo) / 8388608.0;
                } else if (bitsPerSample === 32) {
                    v = buf.readInt32LE(bytePos) / 2147483648.0;
                }
                if (v < mn) mn = v;
                if (v > mx) mx = v;
            }
            data.push(mn === Infinity ? 0 : mn);
            data.push(mx === -Infinity ? 0 : mx);
        }
        levels.push({ block, data });
    }

    return { sr: sampleRate, levels };
}

// ── static UI ────────────────────────────────────────────────────────────────
// Prevent stale HTML/JS/CSS from being cached across app restarts.
app.use(express.static(path.join(__dirname, 'ui'), {
    setHeaders: (res, path) => {
        if (path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// ── project info ─────────────────────────────────────────────────────────────
app.get('/api/project', (req, res) => {
    if (!PROJECT_FOLDER) return res.json({ ok: false, error: 'No project loaded' });

    const scriptData = getScriptData(PROJECT_FOLDER);
    const sections   = scriptData ? Object.keys(scriptData.sections || {}) : [];
    const name       = path.basename(PROJECT_FOLDER);
    const pdfPath    = getProjectPdfFile(PROJECT_FOLDER);

    res.json({ ok: true, name, sections, folder: PROJECT_FOLDER, pdf_available: Boolean(pdfPath), pdf_name: pdfPath && path.basename(pdfPath) });
});

app.get('/api/pdf', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).send('No project');
    const pdfPath = getProjectPdfFile(PROJECT_FOLDER);
    if (!pdfPath) return res.status(404).send('No PDF found');
    res.type('application/pdf').sendFile(pdfPath);
});

// ── section script + alignment ────────────────────────────────────────────────
app.get('/api/section/:sectionId/script', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ success: false, error: 'No project loaded' });

    const { sectionId } = req.params;
    const scriptData = getScriptData(PROJECT_FOLDER);
    if (!scriptData) return res.status(404).json({ success: false, error: 'script.json not found' });

    const sectionData   = (scriptData.sections || {})[sectionId] || {};
    const sectionText   = sectionData.text || '';
    const sectionTokens = sectionData.tokens || [];

    const audioFilename = sectionData.audio_filename || sectionData.audio || sectionData.file ||
                          getAudioFile(PROJECT_FOLDER, sectionId);

    // Build normalized script tokens for alignment
    let scriptTokens;
    if (sectionTokens.length) {
        scriptTokens = sectionTokens.map(t => normalizeTextToken(t.raw || ''));
    } else {
        scriptTokens = sectionText.split(/\s+/).map(normalizeTextToken);
    }

    // Attempt alignment
    let timestampMap       = {};
    let scriptStartTime    = 0;
    let transcriptionWords = [];

    const transcData = getTranscriptionData(PROJECT_FOLDER);
    if (transcData) {
        const secTrans = (transcData.sections || {})[sectionId] || {};
        transcriptionWords = secTrans.words || [];

        // 1. Prefer precomputed alignment from the QC package
        const precomputed = getPrecomputedAlignment(PROJECT_FOLDER, sectionId, scriptData);
        if (precomputed && transcriptionWords.length) {
            timestampMap = precomputed.timestampMap;
            scriptStartTime = precomputed.scriptStartTime;
        }

        // 2. Fallback to on-the-fly alignment
        if (!Object.keys(timestampMap).length && transcriptionWords.length && scriptTokens.length) {
            try {
                const result = progressiveAnchorAlignment(scriptTokens, transcriptionWords);
                timestampMap    = result.timestampMap;
                scriptStartTime = result.scriptStartTime;
            } catch (e) {
                console.error('Alignment error:', e);
            }
        }
    }

    res.json({
        success: true,
        script: sectionText,
        tokens: sectionTokens,
        timestamp_map: timestampMap,
        script_start_time: scriptStartTime,
        audio_filename: audioFilename,
        transcription_words: transcriptionWords,
        page_boundaries: sectionData.page_boundaries || {},
        total_words: sectionTokens.length || sectionText.split(/\s+/).length
    });
});

// ── transcription ─────────────────────────────────────────────────────────────
app.get('/api/section/:sectionId/transcription', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ success: false });
    const { sectionId } = req.params;
    const transcData = getTranscriptionData(PROJECT_FOLDER);
    if (!transcData) return res.json({ success: false, transcription: null });
    const sec   = (transcData.sections || {})[sectionId] || {};
    const words = sec.words || [];
    if (!words.length) return res.json({ success: false, transcription: null });
    res.json({ success: true, transcription: { words } });
});

// ── audio + peaks file serving ────────────────────────────────────────────────
app.get('/api/audio/:filename', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).send('No project');
    const filePath = path.join(PROJECT_FOLDER, 'audio', req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    res.sendFile(filePath);
});

// ── on-demand peaks generation (WAV only, no Python needed) ──────────────────
app.post('/api/generate-peaks/:audioFilename', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false });

    const audioFilename = req.params.audioFilename;
    const audioPath = path.join(PROJECT_FOLDER, 'audio', audioFilename);
    if (!fs.existsSync(audioPath)) return res.status(404).json({ ok: false, error: 'Audio file not found' });

    const peaksFilename = audioFilename.replace(/\.(wav|mp3)$/i, '.peaks');
    const peaksPath = path.join(PROJECT_FOLDER, 'audio', peaksFilename);

    // Return cached peaks if they already exist
    if (fs.existsSync(peaksPath)) {
        return res.json({ ok: true, peaks_file: peaksFilename, cached: true });
    }

    const ext = path.extname(audioFilename).toLowerCase();
    if (ext !== '.wav') {
        return res.status(400).json({ ok: false, error: 'Only WAV files can be processed without Python. Please regenerate from the main QC Suite.' });
    }

    try {
        console.log(`[peaks] Generating peaks for ${audioFilename}…`);
        const peaks = generatePeaksFromWav(audioPath);
        fs.writeFileSync(peaksPath, JSON.stringify(peaks));
        console.log(`[peaks] Saved ${peaksFilename}`);
        res.json({ ok: true, peaks_file: peaksFilename, cached: false });
    } catch (e) {
        console.error('[peaks] Error:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── session (last position + markers) ────────────────────────────────────────
function ensureSession(projectFolder) {
    const qcDir      = path.join(projectFolder, 'qc');
    const sessPath   = path.join(qcDir, 'session.json');
    if (!fs.existsSync(sessPath)) {
        fs.mkdirSync(qcDir, { recursive: true });
        saveJson(sessPath, { last_section: null, last_time: 0, markers: [], script_zoom: 14 });
    }
    return sessPath;
}

app.get('/api/session', (req, res) => {
    if (!PROJECT_FOLDER) return res.json({ ok: false, session: null });
    const sessPath = ensureSession(PROJECT_FOLDER);
    res.json({ ok: true, session: loadJson(sessPath) });
});

app.post('/api/session/position', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false });
    const { section_id, time } = req.body;
    const sessPath = ensureSession(PROJECT_FOLDER);
    const sess = loadJson(sessPath);
    sess.last_section = section_id;
    sess.last_time    = time;
    saveJson(sessPath, sess);
    res.json({ ok: true });
});

app.post('/api/session/marker/add', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false });
    const { section_id, time, label } = req.body;
    const sessPath = ensureSession(PROJECT_FOLDER);
    const sess = loadJson(sessPath);
    const marker = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), section_id, time, label: label || 'Marker' };
    sess.markers = sess.markers || [];
    sess.markers.push(marker);
    saveJson(sessPath, sess);
    res.json({ ok: true, marker });
});

app.post('/api/session/marker/remove', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false });
    const { id } = req.body;
    const sessPath = ensureSession(PROJECT_FOLDER);
    const sess = loadJson(sessPath);
    sess.markers = (sess.markers || []).filter(m => m.id !== id);
    saveJson(sessPath, sess);
    res.json({ ok: true });
});

app.post('/api/session/marker/update', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false });
    const { id, fields } = req.body;
    const sessPath = ensureSession(PROJECT_FOLDER);
    const sess = loadJson(sessPath);
    const marker = (sess.markers || []).find(m => m.id === id);
    if (!marker) return res.status(404).json({ ok: false, error: 'Marker not found' });
    Object.assign(marker, fields);
    saveJson(sessPath, sess);
    res.json({ ok: true, marker });
});

app.post('/api/session/zoom', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false });
    const { script_zoom } = req.body;
    const sessPath = ensureSession(PROJECT_FOLDER);
    const sess = loadJson(sessPath);
    sess.script_zoom = script_zoom;
    saveJson(sessPath, sess);
    res.json({ ok: true });
});

// ── L2 ticket CRUD ────────────────────────────────────────────────────────────
app.get('/api/l2', (req, res) => {
    if (!PROJECT_FOLDER) return res.json({ ok: false });
    const l2Path = ensureL2(PROJECT_FOLDER);
    res.json({ ok: true, l2: loadJson(l2Path) });
});

app.post('/api/l2/ticket/add', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false });
    const { section_id, ticket } = req.body;
    const l2Path = ensureL2(PROJECT_FOLDER);
    const l2 = loadJson(l2Path);

    if (!l2.sections[section_id]) {
        l2.sections[section_id] = { confidence: null, tickets: [], manual_tickets: [] };
    }

    if (!ticket.ticket_id) {
        ticket.ticket_id = 'manual_' + Math.random().toString(36).slice(2, 10);
    }
    ticket.source = 'manual';

    l2.sections[section_id].manual_tickets.push(ticket);
    saveJson(l2Path, l2);
    res.json({ ok: true, ticket });
});

app.post('/api/l2/ticket/update', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false });
    const { ticket_id, fields } = req.body;
    const l2Path = ensureL2(PROJECT_FOLDER);
    const l2 = loadJson(l2Path);

    let found = false;
    for (const sec of Object.values(l2.sections)) {
        for (const arr of [sec.tickets || [], sec.manual_tickets || []]) {
            const t = arr.find(t => t.ticket_id === ticket_id);
            if (t) { Object.assign(t, fields); found = true; break; }
        }
        if (found) break;
    }

    if (!found) return res.status(404).json({ ok: false, error: 'Ticket not found' });
    saveJson(l2Path, l2);
    res.json({ ok: true });
});

app.post('/api/l2/ticket/remove', (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false });
    const { section_id, ticket_id } = req.body;
    const l2Path = ensureL2(PROJECT_FOLDER);
    const l2 = loadJson(l2Path);

    const sec = l2.sections[section_id];
    if (!sec) return res.status(404).json({ ok: false });

    for (const key of ['tickets', 'manual_tickets']) {
        sec[key] = (sec[key] || []).filter(t => t.ticket_id !== ticket_id);
    }

    saveJson(l2Path, l2);
    res.json({ ok: true });
});

// ── Excel report export ─────────────────────────────────────────────────────
app.get('/api/export/report', async (req, res) => {
    if (!PROJECT_FOLDER) return res.status(400).json({ ok: false, error: 'No project loaded' });

    try {
        const qcerName = String(req.query.qcer || '').trim();
        const { buffer, projectName, ticketCount } = await generateExcelReport(PROJECT_FOLDER, qcerName);
        const filename = `${projectName}_QC_Report.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.send(buffer);
    } catch (e) {
        console.error('[export] Report generation failed:', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── start ─────────────────────────────────────────────────────────────────────
function startServer(port) {
    return new Promise((resolve, reject) => {
        const s = app.listen(port, '127.0.0.1', () => resolve(s));
        s.on('error', reject);
    });
}

module.exports = { app, startServer, setProjectFolder };
