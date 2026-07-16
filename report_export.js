'use strict';

const path  = require('path');
const fs    = require('fs');
const ExcelJS = require('exceljs');
const { normalizeTextToken, progressiveAnchorAlignment } = require('./alignment');

const TEMPLATE_PATH = path.join(__dirname, 'report_templates', 'qc_full_report_template.xlsx');
const FULL_QC_SHEET = 'Full QC report';
const FULL_QC_START_ROW = 9;
const FULL_QC_END_ROW   = 862;

// ── error-type mapping (QC Lite type → QC Suite code) ────────────────────────
const TYPE_MAP = {
    misread:         'MR',
    mr:              'MR',
    pronunciation:   'PRON',
    pron:            'PRON',
    diction:         'DIC',
    dic:             'DIC',
    noise:           'NZ',
    nz:              'NZ',
    plosive:         'PL',
    pl:              'PL',
    distortion:      'DIST',
    dist:            'DIST',
    missing_word:    'MW',
    missingword:     'MW',
    mw:              'MW',
    missing_line:    'ML',
    missingline:     'ML',
    ml:              'ML',
    repeated_word:   'RW',
    repeatedword:    'RW',
    rw:              'RW',
    repeated_line:   'RL',
    repeatedline:    'RL',
    rl:              'RL',
    character_voice: 'CHAR',
    character:       'CHAR',
    char:            'CHAR',
    edit:            'EDIT',
    pacing:          'EDIT',
    sound_effect:    'SFX',
    sfx:             'SFX',
    mix:             'MIX',
    other:           'OTHER',
};

function mapType(rawType) {
    const key = String(rawType || 'other').toLowerCase().replace(/[^a-z_]/g, '');
    return TYPE_MAP[key] || 'OTHER';
}

// ── severity mapping (QC Lite → QC Suite display label) ──────────────────────
function mapSeverity(rawSeverity) {
    switch (String(rawSeverity || '').toUpperCase()) {
        case 'CRITICAL': case 'HIGH':        return 'Critical';
        case 'DESTRUCTIVE': case 'MEDIUM':   return 'Destructive';
        case 'DISTRACTING': case 'LOW':
        case 'MINOR': default:               return 'Distracting';
    }
}

// ── timestamp: seconds → HH:MM:SS ─────────────────────────────────────────────
function fmtHMS(seconds) {
    const s = Math.max(0, parseFloat(seconds) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}

// ── ticket start helper ───────────────────────────────────────────────────────
function ticketStart(t) {
    return parseFloat(t.start_time ?? t.start ?? t.timing ?? 0) || 0;
}

// ── load project data ─────────────────────────────────────────────────────────
function loadJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function getProjectMeta(projectFolder) {
    const scriptPath = path.join(projectFolder, 'script.json');
    if (!fs.existsSync(scriptPath)) return { sections: {} };
    try { return loadJson(scriptPath); } catch { return { sections: {} }; }
}

function getL2(projectFolder) {
    const l2Path = path.join(projectFolder, 'qc', 'l2.json');
    if (!fs.existsSync(l2Path)) return { sections: {} };
    try { return loadJson(l2Path); } catch { return { sections: {} }; }
}

function getTranscriptionData(projectFolder) {
    const p = path.join(projectFolder, 'qc', 'transcription.json');
    if (!fs.existsSync(p)) return { sections: {} };
    try { return loadJson(p); } catch { return { sections: {} }; }
}

// ── derive the PDF page for a ticket from the section's alignment ───────────
function getPageFromBoundaries(tokenIndex, pageBoundaries) {
    if (!pageBoundaries || typeof pageBoundaries !== 'object') return null;
    let bestPage = null;
    let bestStart = -1;
    for (const [pageStr, startIdx] of Object.entries(pageBoundaries)) {
        const page  = parseInt(pageStr, 10);
        const start = parseInt(startIdx, 10);
        if (isNaN(page) || isNaN(start)) continue;
        if (start <= tokenIndex && start > bestStart) {
            bestStart = start;
            bestPage = page;
        }
    }
    return bestPage;
}

function getPageFromToken(token, pageBoundaries, tokenIndex) {
    if (!token) return null;
    if (token.pdf_page) return String(token.pdf_page);
    if (pageBoundaries && Object.keys(pageBoundaries).length) {
        const idx = token.index !== undefined ? token.index : tokenIndex;
        const page = getPageFromBoundaries(idx, pageBoundaries);
        if (page !== null) return String(page);
    }
    return null;
}

function getTicketPage(ticket, sectionData, transcWords) {
    const start = ticketStart(ticket);
    const tokens = (sectionData && sectionData.tokens) || [];
    const pageBoundaries = (sectionData && sectionData.page_boundaries) || {};
    if (!tokens.length) return (ticket.page || '').toString().trim() || 'N/A';

    // First/last PDF pages present in the script tokens or page_boundaries
    let firstPage = null;
    let lastPage = null;
    for (let i = 0; i < tokens.length; i++) {
        const p = getPageFromToken(tokens[i], pageBoundaries, i);
        if (p !== null) {
            if (firstPage === null) firstPage = p;
            lastPage = p;
        }
    }
    if (!firstPage) return (ticket.page || '').toString().trim() || 'N/A';

    let bestPage = firstPage;

    if (!transcWords || !transcWords.length) {
        return (ticket.page || '').toString().trim() || firstPage;
    }

    // Compute alignment on the fly for this section
    const scriptTokens = tokens.map(t => normalizeTextToken(t.raw || ''));
    let timestampMap;
    try {
        const result = progressiveAnchorAlignment(scriptTokens, transcWords);
        timestampMap = result.timestampMap;
    } catch (e) {
        return (ticket.page || '').toString().trim() || firstPage;
    }

    // Collect aligned script tokens with their spoken-word times
    const aligned = [];
    for (let i = 0; i < tokens.length; i++) {
        const wi = timestampMap[i];
        if (wi === undefined || !transcWords[wi]) continue;
        aligned.push({ i, start: transcWords[wi].start });
    }
    if (!aligned.length) return bestPage;

    if (start < aligned[0].start) return firstPage;
    if (start > aligned[aligned.length - 1].start) {
        return getPageFromToken(tokens[aligned[aligned.length - 1].i], pageBoundaries, aligned[aligned.length - 1].i) || lastPage || firstPage;
    }

    for (const a of aligned) {
        if (a.start <= start) {
            const p = getPageFromToken(tokens[a.i], pageBoundaries, a.i);
            if (p !== null) bestPage = p;
        }
    }
    return bestPage;
}

// ── derive section number string ("001") from section_id ("sec_001") ─────────
function sectionNumber(sectionId) {
    const num = sectionId.replace(/^sec_/i, '');
    const n   = parseInt(num, 10);
    if (!isNaN(n)) return String(n).padStart(3, '0');
    return num;
}

// ── derive display name for a section ────────────────────────────────────────
function sectionName(sectionId, scriptSection) {
    // Try audio filename without extension first
    const audio = scriptSection && (scriptSection.audio_filename || scriptSection.audio || scriptSection.file);
    if (audio) {
        const base = path.basename(audio, path.extname(audio));
        if (base) return base;
    }
    return sectionId;
}

// ── build sorted row list from l2.json ────────────────────────────────────────
function buildRows(projectFolder) {
    const l2     = getL2(projectFolder);
    const script = getProjectMeta(projectFolder);
    const scriptSections = script.sections || {};
    const transcription = getTranscriptionData(projectFolder);

    // Cache alignments per section (some sections have many tickets)
    const alignmentCache = {};
    function getSectionWords(secId) {
        const secTrans = (transcription.sections || {})[secId] || {};
        return secTrans.words || null;
    }

    // Sort section IDs by their numeric value
    const sectionIds = Object.keys(l2.sections || {}).sort((a, b) => {
        const na = parseInt(a.replace(/^sec_/i, ''), 10) || 0;
        const nb = parseInt(b.replace(/^sec_/i, ''), 10) || 0;
        return na - nb || a.localeCompare(b);
    });

    const rows = [];
    for (const secId of sectionIds) {
        const sec     = l2.sections[secId] || {};
        const wavNum  = sectionNumber(secId);
        const secName = sectionName(secId, scriptSections[secId]);
        const transcWords = getSectionWords(secId);

        // Combine auto-detected tickets and manually created tickets
        const allTickets = [
            ...(sec.tickets        || []),
            ...(sec.manual_tickets || []),
        ].sort((a, b) => ticketStart(a) - ticketStart(b));

        for (const t of allTickets) {
            const page = getTicketPage(t, scriptSections[secId], transcWords);
            rows.push({
                wav_number:   wavNum,
                section_name: secName,
                page:         page || 'N/A',
                start_seconds: ticketStart(t),
                type_code:    mapType(t.type || t.ticket_type),
                comment:      (t.comment || t.note || '').trim(),
                severity:     mapSeverity(t.severity),
            });
        }
    }

    // Assign sequential pickup numbers
    rows.forEach((r, i) => { r.pickup_number = i + 1; });
    return rows;
}

// ── main export function ──────────────────────────────────────────────────────
async function generateExcelReport(projectFolder, qcerName = '') {
    if (!fs.existsSync(TEMPLATE_PATH)) {
        throw new Error(`Excel template not found at: ${TEMPLATE_PATH}`);
    }

    const rows = buildRows(projectFolder);
    const projectName = path.basename(projectFolder);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(TEMPLATE_PATH);

    const ws = wb.getWorksheet(FULL_QC_SHEET);
    if (!ws) {
        throw new Error(`Template is missing the "${FULL_QC_SHEET}" sheet`);
    }

    // The template's conditional formatting for the Severity column applies
    // strikethrough to every severity label. The report should show normal text,
    // so we remove the strikethrough effect while preserving any colour fills.
    for (const cf of ws.conditionalFormattings || []) {
        for (const rule of cf.rules || []) {
            if (rule.style && rule.style.font) {
                rule.style.font.strike = false;
            }
        }
    }

    // Keep all template sheets intact (including any dropdown/source sheets).

    // Fill header cells
    ws.getCell('C2').value = qcerName;   // Name of QC'er (adjacent to template label in B2)
    ws.getCell('C3').value = new Date(); // date of report (template format will display it)

    // Helper: set only the value, preserving existing template formatting
    function setValue(r, c, value) {
        ws.getCell(r, c).value = value;
    }

    // Clear existing data rows (rows 9 – end of used range, up to FULL_QC_END_ROW)
    const lastUsed = Math.min(ws.rowCount, FULL_QC_END_ROW);
    for (let r = FULL_QC_START_ROW; r <= lastUsed; r++) {
        for (let c = 2; c <= 9; c++) setValue(r, c, null);
    }

    // Write ticket rows
    let outputRow = FULL_QC_START_ROW;
    for (const row of rows) {
        if (outputRow > FULL_QC_END_ROW) break;

        const wavNum = row.wav_number;
        setValue(outputRow, 2, /^\d+$/.test(wavNum) ? parseInt(wavNum, 10) : wavNum); // B
        setValue(outputRow, 3, row.pickup_number);                                     // C
        setValue(outputRow, 4, row.section_name);                                      // D
        setValue(outputRow, 5, row.page);                                              // E
        setValue(outputRow, 6, fmtHMS(row.start_seconds));                            // F
        setValue(outputRow, 7, row.type_code);                                        // G
        setValue(outputRow, 8, row.comment || row.type_code);                         // H
        setValue(outputRow, 9, row.severity);                                         // I

        outputRow++;
    }

    const buffer = await wb.xlsx.writeBuffer();
    return { buffer, projectName, ticketCount: rows.length };
}

module.exports = { generateExcelReport };
