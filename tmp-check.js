
/* ═══════════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════════ */
const S = {
    projectName:    null,
    sections:       [],
    currentSection: null,
    pdfAvailable:   false,
    pdfName:        null,
    pdfPage:        null,
    l2:             null,
    // alignment
    timestampMap:      {},   // scriptIndex → spokenIndex  (from server)
    reverseMap:        {},   // spokenIndex → scriptIndex  (built once on section load)
    transcWords:       [],   // [{word, start, end}]
    // script data (used for reliable PDF page lookups)
    tokens:            [],   // [{raw, pdf_page, ...}] or [{raw, index}]
    pageBoundaries:  {},   // {pageNumber: startTokenIndex}
    sectionScripts:  {},   // sectionId -> {tokens, timestampMap, transcWords, scriptSpans, pageBoundaries}
    // DOM
    scriptSpans:       [],
    // highlight
    currentHighlight: -1,
    // search
    searchMatches: [],
    searchCursor:  -1,
    // ticket edit
    editingTicketId: null,
    selectedTicket:  null,
    // session / markers
    session:  { last_section: null, last_time: 0, markers: [] },
    markers:  [],   // markers for the current section (filtered from session.markers)
    // zoom
    scriptZoom: 14,  // current font size in pixels (default 14px)
};

const audio = document.getElementById('audio');
let lastAutoComment = '';

/* ═══════════════════════════════════════════════════════════════
   WAVEFORM  (matching original L2new2.html exactly)
═══════════════════════════════════════════════════════════════ */
const wCanvas  = document.getElementById('waveform-canvas');
const wCtx     = wCanvas.getContext('2d');
const oCanvas  = document.getElementById('overlay-canvas');
const oCtx     = oCanvas.getContext('2d');
const rCanvas  = document.getElementById('ruler-canvas');
const rCtx     = rCanvas.getContext('2d');

let peaks = null;

const view = { start: 0, duration: 30 };
const FOLLOW_THRESHOLD = 0.85;

const dragScroll   = { active: false, startX: 0, startView: 0 };
const selectionDrag = { active: false };
const selection    = { active: false, start: 0, end: 0 };

function xToTime(x) {
    return view.start + (x / oCanvas.clientWidth) * view.duration;
}

function timeToX(t) {
    return ((t - view.start) / view.duration) * oCanvas.clientWidth;
}

function resizeCanvases() {
    const rect = document.getElementById('wave-area').getBoundingClientRect();
    const dpr  = window.devicePixelRatio || 1;
    const W = Math.floor(rect.width);
    const wH = Math.floor(rect.height - 28);   // minus ruler height
    const rH = 28;

    for (const [c, h] of [[wCanvas, wH], [oCanvas, wH]]) {
        c.width  = W * dpr;
        c.height = h * dpr;
        c.style.width  = W + 'px';
        c.style.height = h + 'px';
        c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    rCanvas.width  = W * dpr;
    rCanvas.height = rH * dpr;
    rCanvas.style.width  = W + 'px';
    rCanvas.style.height = rH + 'px';
    rCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resizeCanvases();
window.addEventListener('resize', () => { resizeCanvases(); renderFrame(); });

// ── draw waveform peaks ───────────────────────────────────────
function drawWaveform() {
    const W = wCanvas.clientWidth, H = wCanvas.clientHeight;
    const center = H / 2;
    wCtx.clearRect(0, 0, W, H);
    if (!peaks || !peaks.length || !audio.duration) return;

    const peaksPerSec = peaks.length / audio.duration;
    const startPeak   = Math.floor(view.start * peaksPerSec);
    const visiblePeaks = Math.floor(view.duration * peaksPerSec);
    const peaksPerPixel = visiblePeaks / W;

    wCtx.fillStyle = '#5a74ff';
    for (let x = 0; x < W; x++) {
        const idx  = startPeak + Math.floor(x * peaksPerPixel);
        const peak = peaks[idx] || 0;
        const h    = Math.abs(peak) * center * 0.9;
        wCtx.fillRect(x, center - h, 1, h * 2);
    }
}

// ── draw ruler ────────────────────────────────────────────────
function chooseStep(dur) {
    if (dur < 5)   return 0.5;
    if (dur < 10)  return 1;
    if (dur < 30)  return 5;
    if (dur < 120) return 10;
    if (dur < 300) return 30;
    return 60;
}
function fmtTime(s) {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2,'0')}`;
}

function drawRuler() {
    const W = rCanvas.clientWidth, H = rCanvas.clientHeight;
    rCtx.clearRect(0, 0, W, H);
    rCtx.fillStyle   = '#3a424d';
    rCtx.strokeStyle = '#3a424d';
    rCtx.font = '10px monospace';
    rCtx.lineWidth = 1;

    const step = chooseStep(view.duration);
    const end  = Math.min(view.start + view.duration, audio.duration || Infinity);
    for (let t = Math.ceil(view.start / step) * step; t < end; t += step) {
        const x = ((t - view.start) / view.duration) * W;
        rCtx.beginPath();
        rCtx.moveTo(x, H);
        rCtx.lineTo(x, H - 8);
        rCtx.stroke();
        rCtx.fillText(fmtTime(t), x + 2, 11);
    }
}

// ── draw overlay (playhead + selection + ticket markers) ──────
const TICKET_COLORS = {
    MISREAD:'#f85149', MISSING_WORD:'#a78bfa', MISSING_LINE:'#9ca3af',
    REPEATED_WORD:'#fbbf24', REPEATED_LINE:'#f97316', PRONUNCIATION:'#fb923c',
    NOISE:'#6b7280', PLOSIVE:'#38bdf8', DISTORTION:'#e879f9', OTHER:'#6b7280',
};

function drawTicketMarkers() {
    const tickets = allTickets();
    if (!tickets.length) return;
    const W = oCanvas.clientWidth;
    const viewEnd = view.start + view.duration;

    for (const t of tickets) {
        const time = parseFloat(getTicketStart(t));
        if (isNaN(time) || time < view.start || time > viewEnd) continue;

        const x   = ((time - view.start) / view.duration) * W;
        const col = TICKET_COLORS[normalizeTicketType(t.type || t.ticket_type)] || '#6b7280';

        oCtx.fillStyle = col;
        oCtx.fillRect(x - 1, 10, 2, 16);         // stem
        oCtx.beginPath();                          // triangle head
        oCtx.moveTo(x, 0);
        oCtx.lineTo(x - 5, 8);
        oCtx.lineTo(x + 5, 8);
        oCtx.closePath();
        oCtx.fill();
    }
}

function drawSessionMarkers() {
    if (!S.markers || !S.markers.length) return;
    const W = oCanvas.clientWidth, H = oCanvas.clientHeight;
    const viewEnd = view.start + view.duration;
    oCtx.save();
    for (const m of S.markers) {
        const t = parseFloat(m.time);
        if (isNaN(t) || t < view.start || t > viewEnd) continue;
        const x = ((t - view.start) / view.duration) * W;
        // amber vertical line
        oCtx.strokeStyle = '#f0c040';
        oCtx.lineWidth   = 1.5;
        oCtx.setLineDash([4, 3]);
        oCtx.beginPath(); oCtx.moveTo(x, 0); oCtx.lineTo(x, H); oCtx.stroke();
        oCtx.setLineDash([]);
        // pin diamond at top
        oCtx.fillStyle = '#f0c040';
        oCtx.beginPath();
        oCtx.moveTo(x, 0);
        oCtx.lineTo(x + 5, 7);
        oCtx.lineTo(x, 14);
        oCtx.lineTo(x - 5, 7);
        oCtx.closePath();
        oCtx.fill();
        // label
        oCtx.fillStyle = '#f0c040';
        oCtx.font = '9px sans-serif';
        oCtx.fillText(m.label, x + 4, 24);
    }
    oCtx.restore();
}

function drawSelection() {
    if (!selection.active) return;
    const W = oCanvas.clientWidth, H = oCanvas.clientHeight;
    const x1 = timeToX(selection.start), x2 = timeToX(selection.end);
    const x = Math.min(x1, x2), w = Math.abs(x2 - x1);
    oCtx.fillStyle = 'rgba(255,200,0,0.18)';
    oCtx.fillRect(x, 0, w, H);
    oCtx.strokeStyle = 'rgba(255,200,0,0.7)';
    oCtx.lineWidth = 1;
    for (const px of [x1, x2]) {
        oCtx.beginPath(); oCtx.moveTo(px, 0); oCtx.lineTo(px, H); oCtx.stroke();
    }
}

function drawPlayhead() {
    if (!audio.duration) return;
    const W = oCanvas.clientWidth, H = oCanvas.clientHeight;
    const x = timeToX(audio.currentTime);
    oCtx.fillStyle = '#e94560';
    oCtx.fillRect(x, 0, 2, H);

    // auto-follow
    const progress = (audio.currentTime - view.start) / view.duration;
    if (progress > FOLLOW_THRESHOLD && !audio.paused) {
        view.start = audio.currentTime - view.duration * 0.5;
        view.start = Math.max(0, Math.min(view.start, audio.duration - view.duration));
    }
}

function renderFrame() {
    if (!peaks || !peaks.length) return;
    drawWaveform();
    drawRuler();
    oCtx.clearRect(0, 0, oCanvas.clientWidth, oCanvas.clientHeight);
    drawTicketMarkers();
    drawSessionMarkers();
    drawSelection();
    drawPlayhead();
}

// ── animation loop ────────────────────────────────────────────
function animLoop() {
    renderFrame();
    requestAnimationFrame(animLoop);
}
requestAnimationFrame(animLoop);

// ── peaks loading ─────────────────────────────────────────────
function setWaveformMsg(msg) {
    const el = document.getElementById('waveform-msg');
    el.style.display = msg ? 'flex' : 'none';
    el.textContent = msg || '';
}

async function loadPeaks(audioFilename) {
    peaks = null;
    wCtx.clearRect(0, 0, wCanvas.clientWidth, wCanvas.clientHeight);
    setWaveformMsg('Loading waveform…');

    const peaksFile = audioFilename.replace(/\.(wav|mp3)$/i, '.peaks');
    try {
        const r = await fetch(`/api/audio/${peaksFile}`);
        if (!r.ok) throw new Error('not found');
        const json = await r.json();
        peaks = json.levels[0].data;
        setWaveformMsg('');
        renderFrame();
        return;
    } catch (_) {}

    // peaks file missing — try generating server-side (WAV only)
    setWaveformMsg('Generating waveform (first time only)…');
    try {
        const r = await fetch(`/api/generate-peaks/${audioFilename}`, { method: 'POST' });
        const json = await r.json();
        if (json.ok) {
            const r2 = await fetch(`/api/audio/${json.peaks_file}`);
            const p2 = await r2.json();
            peaks = p2.levels[0].data;
            setWaveformMsg('');
            renderFrame();
            return;
        }
        setWaveformMsg(json.error || 'Waveform unavailable');
    } catch (e) {
        setWaveformMsg('Waveform unavailable');
    }
}

// ── waveform interactions ─────────────────────────────────────
// Wheel on wave area = zoom
document.getElementById('wave-area').addEventListener('wheel', e => {
    e.preventDefault();
    const factor = 1.2;
    if (e.deltaY < 0) view.duration /= factor;
    else              view.duration *= factor;
    if (audio.duration) view.duration = Math.max(1, Math.min(view.duration, audio.duration));
    renderFrame();
}, { passive: false });

// Drag ruler to scroll
rCanvas.style.cursor = 'grab';
rCanvas.addEventListener('mousedown', e => {
    dragScroll.active    = true;
    dragScroll.startX    = e.clientX;
    dragScroll.startView = view.start;
    rCanvas.style.cursor = 'grabbing';
});

// Drag overlay for selection, click to seek
oCanvas.addEventListener('mousedown', e => {
    const rect = oCanvas.getBoundingClientRect();
    selection.start = xToTime(e.clientX - rect.left);
    selection.end   = selection.start;
    selection.active = true;
    selectionDrag.active = true;
});

oCanvas.addEventListener('click', e => {
    if (Math.abs(selection.end - selection.start) > 0.05) return; // was a drag
    const rect = oCanvas.getBoundingClientRect();
    const time = xToTime(e.clientX - rect.left);
    audio.currentTime = time;
    view.start = Math.max(0, time - view.duration * 0.3);
    renderFrame();
});

window.addEventListener('mousemove', e => {
    if (dragScroll.active) {
        const dx = e.clientX - dragScroll.startX;
        const spp = view.duration / (oCanvas.clientWidth || 1);
        view.start = dragScroll.startView - dx * spp;
        if (audio.duration) view.start = Math.max(0, Math.min(view.start, audio.duration - view.duration));
        renderFrame();
    }
    if (selectionDrag.active) {
        const rect = oCanvas.getBoundingClientRect();
        selection.end = xToTime(e.clientX - rect.left);
        renderFrame();
    }
});

window.addEventListener('mouseup', () => {
    if (dragScroll.active) {
        dragScroll.active = false;
        rCanvas.style.cursor = 'grab';
    }
    if (selectionDrag.active) {
        selectionDrag.active = false;
        if (Math.abs(selection.end - selection.start) > 0.05) {
            // keep the selection visible; snap playhead to selection start
            selection.active = true;
            audio.currentTime = Math.min(selection.start, selection.end);
        } else {
            // too small — treat as a plain click: seek and clear selection
            audio.currentTime = selection.start;
            selection.active = false;
        }
        renderFrame();
    }
});

/* ═══════════════════════════════════════════════════════════════
   AUDIO CONTROLS
═══════════════════════════════════════════════════════════════ */
const playBtn  = document.getElementById('play-btn');
const pauseBtn = document.getElementById('pause-btn');
const timeDisp = document.getElementById('time-display');

function fmtAudioTime(s) {
    if (!s || isNaN(s)) return '00:00.00';
    return formatTime(s);
}

audio.addEventListener('timeupdate', () => {
    timeDisp.textContent = `${fmtAudioTime(audio.currentTime)} / ${fmtAudioTime(audio.duration)}`;
    updatePdfReference();
});
audio.addEventListener('loadedmetadata', () => {
    timeDisp.textContent = `0:00 / ${fmtAudioTime(audio.duration)}`;
    view.start    = 0;
    view.duration = Math.min(30, audio.duration);
});
audio.addEventListener('ended', () => {
    playBtn.disabled  = false;
    pauseBtn.disabled = true;
});

playBtn.addEventListener('click',  () => { audio.play();  playBtn.disabled = true;  pauseBtn.disabled = false; });
pauseBtn.addEventListener('click', () => { audio.pause(); playBtn.disabled = false; pauseBtn.disabled = true; });
document.getElementById('stop-btn').addEventListener('click', () => {
    audio.pause(); audio.currentTime = 0;
    playBtn.disabled = false; pauseBtn.disabled = true;
});

// Speed
document.getElementById('speed-controls').addEventListener('click', e => {
    const btn = e.target.closest('.spd-btn');
    if (!btn) return;
    document.querySelectorAll('.spd-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    audio.playbackRate = parseFloat(btn.dataset.speed);
});

// Goto
(function () {
    function parseGoto(str) {
        const parts = str.trim().split(':');
        if (parts.length >= 2) return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
        return parseFloat(parts[0]);
    }
    function doGoto() {
        const t = parseGoto(document.getElementById('goto-input').value);
        if (isNaN(t) || t < 0) return;
        audio.currentTime = t;
        view.start = Math.max(0, t - view.duration * 0.3);
        renderFrame();
    }
    document.getElementById('goto-btn').addEventListener('click', doGoto);
    document.getElementById('goto-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doGoto(); }
    });
})();

/* ═══════════════════════════════════════════════════════════════
   HIGHLIGHTING  (reverse map built once per section load)
═══════════════════════════════════════════════════════════════ */
function buildReverseMap(fwdMap) {
    const rev = {};
    for (const [si, wi] of Object.entries(fwdMap)) {
        rev[Number(wi)] = Number(si);
    }
    return rev;
}

function findWord(time, words) {
    for (let i = 0; i < words.length; i++) {
        if (time >= words[i].start && time <= words[i].end) return i;
    }
    return -1;
}

function highlightLoop() {
    if (S.transcWords.length && S.scriptSpans.length) {
        const wi = findWord(audio.currentTime, S.transcWords);
        if (wi !== -1) {
            const si = S.reverseMap[wi];
            if (si !== undefined && si !== S.currentHighlight) {
                if (S.scriptSpans[S.currentHighlight])
                    S.scriptSpans[S.currentHighlight].classList.remove('active');
                if (S.scriptSpans[si]) {
                    S.scriptSpans[si].classList.add('active');
                    S.scriptSpans[si].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                }
                S.currentHighlight = si;
            }
        }
    }
    requestAnimationFrame(highlightLoop);
}
requestAnimationFrame(highlightLoop);

/* ═══════════════════════════════════════════════════════════════
   SESSION  (last position + markers)
═══════════════════════════════════════════════════════════════ */

// ── auto-save position (throttled to once per 5 s while playing) ──────────────
let _lastPositionSave = 0;
audio.addEventListener('timeupdate', () => {
    if (!S.currentSection || audio.paused) return;
    const now = Date.now();
    if (now - _lastPositionSave < 5000) return;
    _lastPositionSave = now;
    apiFetch('/api/session/position', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section_id: S.currentSection, time: audio.currentTime })
    });
});

// ── load session and maybe show resume banner ─────────────────────────────────
async function loadSession() {
    const r = await apiFetch('/api/session');
    if (!r.ok || !r.session) return;
    S.session = r.session;
    const { last_section, last_time, script_zoom } = r.session;
    
    // Load and apply script zoom level
    if (script_zoom) {
        S.scriptZoom = script_zoom;
        applyZoom();
    }
    
    if (last_section && S.sections.includes(last_section) && (last_time > 5 || last_section !== S.sections[0])) {
        const banner = document.getElementById('resume-banner');
        document.getElementById('resume-msg').textContent =
            `Resume from ${last_section} at ${fmtAudioTime(last_time)}?`;
        banner.style.display = 'flex';
        // store targets on banner for the button handlers
        banner.dataset.section = last_section;
        banner.dataset.time    = last_time;
    }
}

document.getElementById('resume-yes-btn').addEventListener('click', async () => {
    const banner  = document.getElementById('resume-banner');
    const secId   = banner.dataset.section;
    const t       = parseFloat(banner.dataset.time);
    banner.style.display = 'none';
    await loadSection(secId);
    // seek after audio is ready
    if (audio.readyState >= 1) {
        audio.currentTime = t;
    } else {
        audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; }, { once: true });
    }
});

document.getElementById('resume-no-btn').addEventListener('click', () => {
    document.getElementById('resume-banner').style.display = 'none';
});

// ── markers ───────────────────────────────────────────────────────────────────
let _markerCounter = 0; // used for auto-label numbering

async function addMarker() {
    if (!S.currentSection) return;
    _markerCounter++;
    const label = `Marker ${_markerCounter}`;
    const r = await apiFetch('/api/session/marker/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section_id: S.currentSection, time: audio.currentTime, label })
    });
    if (r.ok) {
        S.session.markers.push(r.marker);
        if (r.marker.section_id === S.currentSection) S.markers.push(r.marker);
        renderMarkers();
    }
}

async function removeMarker(id) {
    await apiFetch('/api/session/marker/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
    S.session.markers = S.session.markers.filter(m => m.id !== id);
    S.markers = S.markers.filter(m => m.id !== id);
    renderMarkers();
}

function refreshSectionMarkers() {
    S.markers = (S.session.markers || []).filter(m => m.section_id === S.currentSection);
    // derive counter from highest existing number across all markers
    const nums = (S.session.markers || []).map(m => {
        const match = /Marker (\d+)/.exec(m.label || '');
        return match ? parseInt(match[1]) : 0;
    });
    if (nums.length) _markerCounter = Math.max(_markerCounter, ...nums);
}

// ── collapse toggle ───────────────────────────────────────────────────────────
let _markersCollapsed = true;

document.getElementById('markers-header').addEventListener('click', e => {
    // don't toggle if the click was directly on the toggle button (it's inside header,
    // so the header listener fires too — deduplicate via a single handler here)
    _markersCollapsed = !_markersCollapsed;
    document.getElementById('markers-toggle').textContent = _markersCollapsed ? '▶' : '▼';
    document.getElementById('markers-list').classList.toggle('collapsed', _markersCollapsed);
});

// ── inline rename helpers ─────────────────────────────────────────────────────
async function saveMarkerLabel(id, newLabel, labelEl) {
    const trimmed = newLabel.trim();
    if (!trimmed) return; // ignore blank
    // update server
    await apiFetch('/api/session/marker/update', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, fields: { label: trimmed } })
    });
    // update local state
    const m = (S.session.markers || []).find(x => x.id === id);
    if (m) m.label = trimmed;
    const sm = (S.markers || []).find(x => x.id === id);
    if (sm) sm.label = trimmed;
    // swap input back to label span without full re-render
    if (labelEl) { labelEl.textContent = trimmed; labelEl.title = trimmed; }
    renderFrame(); // redraw waveform label
}

function startMarkerRename(id, row) {
    const labelEl = row.querySelector('.marker-label');
    if (!labelEl) return;
    const current = labelEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'marker-rename-input';
    input.value = current;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
        const val = input.value.trim() || current;
        input.replaceWith(labelEl);
        labelEl.textContent = val;
        labelEl.title = val;
        saveMarkerLabel(id, val, labelEl);
    }
    function cancel() { input.replaceWith(labelEl); }

    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
}

// ── section id display helper ─────────────────────────────────────────────────
function fmtSection(sectionId) {
    return sectionId.replace(/^sec_0*/, '§');
}

// ── render markers list ───────────────────────────────────────────────────────
function renderMarkers() {
    refreshSectionMarkers();
    const list = document.getElementById('markers-list');
    const allMarkers = S.session.markers || [];
    list.innerHTML = '';
    document.getElementById('marker-count').textContent = allMarkers.length;

    allMarkers.slice().sort((a, b) => {
        if (a.section_id !== b.section_id) return a.section_id.localeCompare(b.section_id);
        return a.time - b.time;
    }).forEach(m => {
        const row = document.createElement('div');
        row.className = 'marker-row';
        row.innerHTML = `
          <div class="marker-meta">
            <span class="marker-section" title="${escHtml(m.section_id)}">${escHtml(fmtSection(m.section_id))}</span>
            <span class="marker-time">${fmtAudioTime(m.time)}</span>
          </div>
          <span class="marker-label" title="${escHtml(m.label)}">${escHtml(m.label)}</span>
          <div class="marker-actions">
            <button class="marker-rename" title="Rename marker">✏</button>
            <button class="marker-jump"   title="Jump to marker">▶</button>
            <button class="marker-del"    title="Delete marker">×</button>
          </div>`;

        row.querySelector('.marker-label').addEventListener('dblclick', () => startMarkerRename(m.id, row));
        row.querySelector('.marker-rename').addEventListener('click',   () => startMarkerRename(m.id, row));

        row.querySelector('.marker-jump').addEventListener('click', async () => {
            if (m.section_id !== S.currentSection) await loadSection(m.section_id);
            if (audio.readyState >= 1) {
                audio.currentTime = m.time;
                view.start = Math.max(0, m.time - view.duration * 0.3);
                renderFrame();
            } else {
                audio.addEventListener('loadedmetadata', () => {
                    audio.currentTime = m.time;
                    view.start = Math.max(0, m.time - view.duration * 0.3);
                    renderFrame();
                }, { once: true });
            }
        });
        row.querySelector('.marker-del').addEventListener('click', () => removeMarker(m.id));
        list.appendChild(row);
    });

    renderFrame();
}

document.getElementById('mark-btn').addEventListener('click', addMarker);

/* ═══════════════════════════════════════════════════════════════
   PROJECT  OPEN
═══════════════════════════════════════════════════════════════ */
document.getElementById('open-btn').addEventListener('click', async () => {
    const folder = await window.electronAPI.openFolder();
    if (!folder) return;
    await loadProject();
});

document.getElementById('export-btn').addEventListener('click', exportExcelReport);

async function exportExcelReport() {
    if (!S.projectName) { alert('Open a project first.'); return; }
    const qcerName = (localStorage.getItem('qcerName') || '').trim();
    if (!qcerName) { alert('Please set your name first.'); showLogin(); return; }

    const exportBtn = document.getElementById('export-btn');
    const originalText = exportBtn.textContent;
    exportBtn.textContent = 'Exporting…';
    exportBtn.disabled = true;

    try {
        const res = await fetch('/api/export/report?qcer=' + encodeURIComponent(qcerName));
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: 'Export failed' }));
            alert('Export failed: ' + err.error);
            return;
        }

        const blob = await res.blob();
        const disp = res.headers.get('content-disposition') || '';
        let filename = `${S.projectName}_QC_Report.xlsx`;
        const match = disp.match(/filename\*=UTF-8''([^;]+)/);
        if (match) filename = decodeURIComponent(match[1].replace(/['"]/g, ''));

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (e) {
        alert('Export error: ' + e.message);
    } finally {
        exportBtn.textContent = originalText;
        exportBtn.disabled = false;
    }
}

async function loadProject() {
    showLoading(true);
    const data = await apiFetch('/api/project');
    if (!data.ok) { alert('Could not load project: ' + (data.error || 'unknown error')); showLoading(false); return; }

    S.projectName = data.name;
    S.sections    = data.sections;
    S.pdfAvailable = Boolean(data.pdf_available);
    S.pdfName = data.pdf_name || null;
    S.pdfPage = null;
    S.sectionScripts = {};  // clear per-project section cache
    S.pageBoundaries = {};   // current section page boundaries
    const projectNameEl = document.getElementById('project-name');
    projectNameEl.textContent = data.name;
    projectNameEl.classList.add('loaded');
    document.getElementById('export-btn').disabled = false;
    document.getElementById('all-tickets-btn').disabled = false;

    const sel = document.getElementById('section-select');
    sel.innerHTML = '';
    sel.disabled  = false;
    for (const s of data.sections) {
        const o = document.createElement('option');
        o.value = o.textContent = s;
        sel.appendChild(o);
    }

    const l2r = await apiFetch('/api/l2');
    S.l2 = l2r.l2 || { sections: {} };

    if (data.sections.length) await loadSection(data.sections[0]);

    // load session after first section so banner can compare against loaded sections
    await loadSession();
    renderMarkers();
    showLoading(false);
}

/* ═══════════════════════════════════════════════════════════════
   SECTION  LOAD
═══════════════════════════════════════════════════════════════ */
document.getElementById('section-select').addEventListener('change', async e => {
    await loadSection(e.target.value);
});

async function loadSection(sectionId) {
    // save current position before switching away
    if (S.currentSection && !audio.paused) {
        apiFetch('/api/session/position', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section_id: S.currentSection, time: audio.currentTime })
        });
    }

    // cache the current section's script data so the all-tickets panel can
    // recompute pages for any section the user has already loaded.
    if (S.currentSection) {
        S.sectionScripts[S.currentSection] = {
            tokens:         S.tokens,
            timestampMap:   S.timestampMap,
            transcWords:    S.transcWords,
            scriptSpans:    S.scriptSpans,
            pageBoundaries: S.pageBoundaries
        };
    }

    S.currentSection    = sectionId;
    S.currentHighlight  = -1;
    S.scriptSpans       = [];
    S.searchMatches     = [];
    S.searchCursor      = -1;

    // update section select dropdown to match
    const sel = document.getElementById('section-select');
    if (sel.value !== sectionId) sel.value = sectionId;

    showLoading(true);

    try {
        const data = await apiFetch(`/api/section/${sectionId}/script`);
        if (!data.success) throw new Error(data.error || 'Script load failed');

        // Store alignment data — build reverse map ONCE here
        S.timestampMap = data.timestamp_map || {};
        S.reverseMap   = buildReverseMap(S.timestampMap);
        S.transcWords  = data.transcription_words || [];
        S.tokens       = data.tokens || [];
        S.pageBoundaries = data.page_boundaries || {};

        renderScript(data);

        // Cache the section we just loaded so the all-tickets panel can recompute pages.
        S.sectionScripts[sectionId] = {
            tokens:         S.tokens,
            timestampMap:   S.timestampMap,
            transcWords:    S.transcWords,
            scriptSpans:    S.scriptSpans,
            pageBoundaries: S.pageBoundaries
        };

        // Load audio
        if (data.audio_filename) {
            audio.src = `/api/audio/${data.audio_filename}`;
            audio.load();
            await loadPeaks(data.audio_filename);
        }

        renderTickets();
        refreshSectionMarkers();
        renderFrame();
    } catch (e) {
        console.error(e);
        document.getElementById('script-content').textContent = 'Error: ' + e.message;
    }

    showLoading(false);
}

/* ═══════════════════════════════════════════════════════════════
   SCRIPT  RENDERING
═══════════════════════════════════════════════════════════════ */
// ── map script spans by time range ───────────────────────────
// Returns a contiguous slice from first→last matched word, filling in
// unaligned/punctuation tokens in between so coverage has no gaps.
function spansInTimeRange(tStart, tEnd) {
    let minIdx = Infinity, maxIdx = -1;
    S.scriptSpans.forEach((span, i) => {
        const wi = S.timestampMap[i];
        if (wi === undefined || !S.transcWords[wi]) return;
        const t = S.transcWords[wi].start;
        if (t >= tStart - 0.05 && t <= tEnd + 0.05) {
            if (i < minIdx) minIdx = i;
            if (i > maxIdx) maxIdx = i;
        }
    });
    if (maxIdx === -1) return [];
    return S.scriptSpans.slice(minIdx, maxIdx + 1);
}

// Repaint ticket coverage across entire script. Call after renderTickets.
function markTicketCoverage() {
    // clear existing coverage marks
    S.scriptSpans.forEach(s => s.classList.remove('ticket-covered', 'ticket-selected'));
    const tickets = allTickets();
    // mark every word covered by any ticket
    tickets.forEach(t => {
        const start = parseFloat(getTicketStart(t));
        const end   = parseFloat(getTicketEnd(t));
        if (isNaN(start)) return;
        spansInTimeRange(start, Math.max(end, start + 0.1)).forEach(s => s.classList.add('ticket-covered'));
    });
    // re-apply selected ticket highlight on top
    if (S.selectedTicket) {
        const start = parseFloat(getTicketStart(S.selectedTicket));
        const end   = parseFloat(getTicketEnd(S.selectedTicket));
        if (!isNaN(start)) {
            spansInTimeRange(start, Math.max(end, start + 0.1)).forEach(s => {
                s.classList.remove('ticket-covered');
                s.classList.add('ticket-selected');
            });
        }
    }
}

function renderScript(data) {
    const container = document.getElementById('script-content');
    container.innerHTML = '';
    S.scriptSpans = [];

    const tokens = (Array.isArray(data.tokens) && data.tokens.length) ? data.tokens : null;
    const words  = tokens ? tokens.map(t => t.raw || '') : (data.script || '').split(/\s+/);
    const pageBoundaries = data.page_boundaries || {};

    let lastPage = null;
    words.forEach((word, i) => {
        const page = getPageFromToken(tokens ? tokens[i] : null, pageBoundaries, i);
        if (page !== null && page !== lastPage) {
            const pm = document.createElement('span');
            pm.className = 'page-marker';
            pm.textContent = `— Page ${page} —`;
            container.appendChild(pm);
            lastPage = page;
        }
        const span = document.createElement('span');
        span.className   = 'token';
        span.dataset.idx = i;
        if (page !== null) span.dataset.page = page;
        span.textContent = word + ' ';

        // click → seek
        span.addEventListener('click', () => {
            const wi = S.timestampMap[i];
            if (wi !== undefined && S.transcWords[wi]) {
                const t = S.transcWords[wi].start;
                audio.currentTime = t;
                view.start = Math.max(0, t - view.duration * 0.3);
            }
        });

        container.appendChild(span);
        S.scriptSpans.push(span);
    });
    
    // Apply current zoom level
    applyZoom();
    updatePdfReference();
}

/* ═══════════════════════════════════════════════════════════════
   TICKETS  — helpers
═══════════════════════════════════════════════════════════════ */

// ── time formatting ──────────────────────────────────────────
function formatTime(seconds) {
    const s = Math.max(0, parseFloat(seconds) || 0);
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    const hund = Math.floor((s % 1) * 100);
    return `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}.${String(hund).padStart(2,'0')}`;
}
function parseTime(str) {
    if (!str) return 0;
    const clean = String(str).trim();
    if (/^\d+(\.\d+)?$/.test(clean)) return parseFloat(clean);
    const m = clean.match(/^(?:(\d+):)?(\d{1,2})(?:\.(\d{1,2}))?$/);
    if (!m) return 0;
    const mins = parseInt(m[1] || '0', 10);
    const secs = parseInt(m[2] || '0', 10);
    const hund = parseInt((m[3] || '0').padEnd(2,'0'), 10);
    return mins * 60 + secs + hund / 100;
}

// ── ticket type / severity normalisation ─────────────────────
function normalizeTicketType(type) {
    const t = String(type || 'OTHER').toUpperCase().replace(/-/g,'_');
    const map = {
        MR:'MISREAD', MW:'MISSING_WORD', ML:'MISSING_LINE',
        RW:'REPEATED_WORD', RL:'REPEATED_LINE',
        PRON:'PRONUNCIATION', NZ:'NOISE', PL:'PLOSIVE', DIST:'DISTORTION',
        MISREAD:'MISREAD', MISSING_WORD:'MISSING_WORD', MISSING_LINE:'MISSING_LINE',
        REPEATED_WORD:'REPEATED_WORD', REPEATED_LINE:'REPEATED_LINE',
        PRONUNCIATION:'PRONUNCIATION', NOISE:'NOISE', PLOSIVE:'PLOSIVE',
        DISTORTION:'DISTORTION', OTHER:'OTHER'
    };
    return map[t] || 'OTHER';
}
function normalizeSeverity(sev) {
    const s = String(sev || 'DISTRACTING').toUpperCase();
    return ['DISTRACTING','CRITICAL','MINOR'].includes(s) ? s : 'DISTRACTING';
}
function getTicketStart(t) { return t.start_time ?? t.start ?? t.timing ?? 0; }
function getTicketEnd(t)   { return t.end_time   ?? t.end   ?? getTicketStart(t); }

// ── waveform selection helpers ────────────────────────────────
function getAudioSelectionTimes() {
    if (!selection.active || Math.abs(selection.end - selection.start) <= 0.05) return null;
    return { start: Math.min(selection.start, selection.end),
             end:   Math.max(selection.start, selection.end) };
}

// ── page helper ───────────────────────────────────────────────
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
    // Old format: token has pdf_page directly.
    if (token.pdf_page) return String(token.pdf_page);
    // New format: token has an index and section has page_boundaries {page: startIndex}.
    if (pageBoundaries && Object.keys(pageBoundaries).length) {
        const idx = token.index !== undefined ? token.index : tokenIndex;
        const page = getPageFromBoundaries(idx, pageBoundaries);
        if (page !== null) return String(page);
    }
    return null;
}

function getPageAtTime(time, scriptData = null) {
    time = parseFloat(time) || 0;
    const sd = scriptData || S;
    const tokens = sd.tokens || [];
    const spans  = sd.scriptSpans || [];
    const timestampMap = sd.timestampMap || {};
    const transcWords  = sd.transcWords || [];
    const pageBoundaries = sd.pageBoundaries || {};

    // Determine the first/last PDF page from the source tokens or rendered spans.
    let firstPage = null;
    let lastPage  = null;
    for (let i = 0; i < tokens.length; i++) {
        const p = getPageFromToken(tokens[i], pageBoundaries, i);
        if (p !== null) {
            if (firstPage === null) firstPage = p;
            lastPage = p;
        }
    }
    if (firstPage === null) {
        for (const span of spans) {
            if (span.dataset.page) {
                const p = span.dataset.page;
                if (firstPage === null) firstPage = p;
                lastPage = p;
            }
        }
    }

    // Default to the first script PDF page, not hardcoded 1, so tickets in the
    // pre-script intro still report the correct PDF page.
    let bestPage = firstPage || '1';

    // Collect aligned script tokens with their spoken-word times.
    const aligned = [];
    const tokenCount = tokens.length || spans.length;
    for (let i = 0; i < tokenCount; i++) {
        const wi = timestampMap[i];
        if (wi === undefined || !transcWords[wi]) continue;
        aligned.push({ i, wi, start: transcWords[wi].start });
    }
    if (!aligned.length) return bestPage;

    // Ensure we search by chronological order, not script-index order.
    aligned.sort((a, b) => a.start - b.start);

    // Before the first aligned word -> first page; after the last -> last page.
    if (time < aligned[0].start) return firstPage || '1';
    if (time > aligned[aligned.length - 1].start) {
        const lastIndex = aligned[aligned.length - 1].i;
        const pageFromToken = getPageFromToken(tokens[lastIndex], pageBoundaries, lastIndex);
        return pageFromToken || (spans[lastIndex] && spans[lastIndex].dataset.page) || lastPage || '1';
    }

    // In the aligned range: keep the page of the last aligned word at or before time.
    for (const a of aligned) {
        if (a.start <= time) {
            const pageFromToken = getPageFromToken(tokens[a.i], pageBoundaries, a.i);
            if (pageFromToken) bestPage = pageFromToken;
            else if (spans[a.i] && spans[a.i].dataset.page) bestPage = spans[a.i].dataset.page;
        }
    }
    return bestPage;
}

function getCurrentPage() {
    return getPageAtTime(audio.currentTime);
}

function updatePdfReference(force = false) {
    const button = document.getElementById('view-pdf-btn');
    const panel = document.getElementById('pdf-panel');
    const title = document.getElementById('pdf-title');
    if (!S.pdfAvailable) {
        button.disabled = true;
        button.textContent = 'View PDF';
        title.textContent = 'Reference PDF unavailable';
        return;
    }

    const page = getCurrentPage();
    button.disabled = false;
    button.textContent = `View PDF · p${page}`;
    title.textContent = `${S.pdfName || 'Reference PDF'} · Page ${page}`;
    if (!panel.classList.contains('open') || (!force && S.pdfPage === page)) return;

    S.pdfPage = page;
    document.getElementById('pdf-frame').src = `/api/pdf#page=${encodeURIComponent(page)}`;
}

document.getElementById('view-pdf-btn').addEventListener('click', () => {
    const panel = document.getElementById('pdf-panel');
    panel.classList.toggle('open');
    updatePdfReference(true);
});

document.getElementById('pdf-close-btn').addEventListener('click', () => {
    document.getElementById('pdf-panel').classList.remove('open');
});

// ── script context helper ─────────────────────────────────────
function getScriptContextAroundTime(time) {
    if (!S.transcWords || !S.scriptSpans) return '';
    let bestIdx = -1, bestDiff = Infinity;
    S.scriptSpans.forEach((span, i) => {
        const wi = S.timestampMap ? S.timestampMap[i] : undefined;
        if (wi === undefined || !S.transcWords[wi]) return;
        const diff = Math.abs(S.transcWords[wi].start - time);
        if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    });
    if (bestIdx === -1) return '';
    const s = Math.max(0, bestIdx - 8);
    const e = Math.min(S.scriptSpans.length, bestIdx + 9);
    return S.scriptSpans.slice(s, e).map(sp => sp.textContent).join('').trim();
}

// ── script text selection helper ─────────────────────────────
// Returns { text, startTime, endTime } — times are null if no alignment found.
function getScriptSelectionText() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text) return null;

    const range = sel.getRangeAt(0);
    let startTime = null, endTime = null;

    S.scriptSpans.forEach((span, i) => {
        if (!range.intersectsNode(span)) return;
        const wi = S.timestampMap[i];
        if (wi === undefined || !S.transcWords[wi]) return;
        const word = S.transcWords[wi];
        if (startTime === null || word.start < startTime) startTime = word.start;
        const wordEnd = word.end ?? (word.start + 0.3);
        if (endTime === null || wordEnd > endTime) endTime = wordEnd;
    });

    return { text, startTime, endTime };
}

// ── auto-comment generator ────────────────────────────────────
function generateAutoComment(type, spoken, expected) {
    const sp = (spoken   || '').trim();
    const ex = (expected || '').trim();
    const t  = (type     || 'OTHER').toUpperCase();

    // A misread is the only error type that is defined by both what was said
    // and what should have been said.
    if (sp && ex && (t === 'MISREAD' || t === 'OTHER')) return `misread - '${ex}' as '${sp}'`;
    if (t === 'MISSING_WORD'   && ex)       return `missing word '${ex}'`;
    if (t === 'MISSING_LINE'   && ex)       return `missing line '${ex}'`;
    if (t === 'REPEATED_WORD'  && sp)       return `repeated word '${sp}'`;
    if (t === 'REPEATED_LINE'  && sp)       return `repeated line '${sp}'`;
    if (t === 'PRONUNCIATION'  && sp)       return `pronunciation issue with '${sp}'`;
    if (t === 'NOISE')                      return 'noise issue';
    if (t === 'PLOSIVE')                    return 'plosive issue';
    if (t === 'DISTORTION')                 return 'distortion issue';
    return '';
}

function allTickets() {
    if (!S.l2 || !S.currentSection) return [];
    const sec = S.l2.sections[S.currentSection];
    if (!sec) return [];
    return [...(sec.tickets || []), ...(sec.manual_tickets || [])];
}

function renderTickets() {
    const list    = document.getElementById('tickets-list');
    list.innerHTML = '';
    const tickets = allTickets().slice().sort((a, b) =>
        parseFloat(getTicketStart(a)) - parseFloat(getTicketStart(b))
    );
    document.getElementById('ticket-count').textContent = tickets.length;

    tickets.forEach(t => {
        const type  = normalizeTicketType(t.type || t.ticket_type);
        const sev   = normalizeSeverity(t.severity);

        const card = document.createElement('div');
        card.className   = 'ticket-card';
        card.dataset.tid = t.ticket_id;
        card.dataset.sev = sev;
        if (S.selectedTicket && S.selectedTicket.ticket_id === t.ticket_id)
            card.classList.add('selected');
        const start = getTicketStart(t);
        const end   = getTicketEnd(t);
        const note  = (t.comment || t.note || '').trim();

        // Recompute the PDF page from the current section's alignment so tickets
        // created before the page fix display the correct page number.
        const page = getPageAtTime(parseFloat(start) || 0);
        const pageLabel = page ? `<span class="tc-page">Page ${escHtml(page)}</span>` : '';
        card.innerHTML = `
          <div class="tc-header">
            <span class="tc-type tc-${type.toLowerCase()}">${type}</span>
            <span class="tc-severity">${sev}</span>
            <button class="tc-delete" title="Delete">×</button>
          </div>
          <div class="tc-time">${pageLabel}${formatTime(start)} – ${formatTime(end)}</div>
          ${note ? `<div class="tc-note">${escHtml(note)}</div>` : ''}`;

        // single click  → seek + waveform highlight only
        // (e.detail >= 2 means this click is part of a dblclick — skip it)
        card.addEventListener('click', e => {
            if (e.target.classList.contains('tc-delete')) return;
            if (e.detail >= 2) return;
            selectTicket(t, card);
        });
        // double click → seek + open editor sidebar
        card.addEventListener('dblclick', e => {
            if (e.target.classList.contains('tc-delete')) return;
            selectTicket(t, card);
            openTicketDetails(t);
        });
        card.querySelector('.tc-delete').addEventListener('click', () => deleteTicket(t.ticket_id));
        list.appendChild(card);
    });

    // refresh ticket markers on waveform + script coverage
    renderFrame();
    markTicketCoverage();
}

function selectTicket(ticket, cardEl) {
    document.querySelectorAll('.ticket-card').forEach(c => c.classList.remove('selected'));
    if (cardEl) cardEl.classList.add('selected');
    S.selectedTicket  = ticket;
    S.editingTicketId = ticket.ticket_id;

    const start = parseFloat(getTicketStart(ticket));
    const end   = parseFloat(getTicketEnd(ticket));

    // seek to ticket start
    audio.currentTime = start;
    view.start = Math.max(0, start - view.duration * 0.3);

    // show selection on waveform if the ticket has a real span
    if (!isNaN(end) && end > start + 0.05) {
        selection.active = true;
        selection.start  = start;
        selection.end    = end;
    } else {
        selection.active = false;
    }
    renderFrame();

    // highlight ticket words in script and scroll to them
    markTicketCoverage();
    const ticketSpans = spansInTimeRange(start, Math.max(isNaN(end) ? start : end, start + 0.1));
    if (ticketSpans.length) ticketSpans[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ── sidebar helpers ───────────────────────────────────────────
function openSidebar() {
    document.getElementById('ticket-details-panel').classList.add('open');
    document.getElementById('td-overlay').classList.add('open');
}
function closeTicketDetails() {
    const panel = document.getElementById('ticket-details-panel');
    // return keyboard focus to body so Space/shortcuts work immediately
    if (panel.contains(document.activeElement)) document.activeElement.blur();
    panel.classList.remove('open');
    document.getElementById('td-overlay').classList.remove('open');
    S.editingTicketId = null;
    document.querySelectorAll('.ticket-card').forEach(c => c.classList.remove('selected'));
    S.selectedTicket = null;
    // redraw coverage without a selected ticket
    markTicketCoverage();
}

// ── open new ticket in sidebar ────────────────────────────────
document.getElementById('add-ticket-btn').addEventListener('click', openNewTicket);

function openNewTicket() {
    if (!S.currentSection) return;
    S.editingTicketId = null;
    S.selectedTicket  = null;
    document.querySelectorAll('.ticket-card').forEach(c => c.classList.remove('selected'));

    const sel   = getAudioSelectionTimes();
    const start = sel ? sel.start : audio.currentTime;
    const end   = sel ? sel.end   : audio.currentTime;
    const creation = sel ? 'waveform' : 'manual';
    const script = getScriptContextAroundTime(start);
    const page   = getPageAtTime(start);

    const badge = document.getElementById('td-source-badge');
    badge.dataset.source   = 'manual';
    badge.dataset.creation = creation;
    document.getElementById('td-title').textContent           = 'New Ticket';
    badge.textContent                                         = `MANUAL • ${creation.toUpperCase()}`;
    document.getElementById('td-comment').value              = '';
    document.getElementById('td-spoken').value               = '';
    document.getElementById('td-expected').value             = '';
    document.getElementById('td-type').value                 = 'OTHER';
    document.getElementById('td-severity').value             = 'DISTRACTING';
    document.getElementById('td-start').value                = formatTime(start);
    document.getElementById('td-end').value                  = formatTime(end);
    document.getElementById('td-script').value               = script;
    document.getElementById('td-page').value                 = page;
    document.getElementById('td-ticket-id').value            = '';
    document.getElementById('td-section-id').value           = S.currentSection;
    document.getElementById('td-save').textContent           = 'Create Ticket';
    document.getElementById('td-delete').style.display      = 'none';
    lastAutoComment = '';
    openSidebar();
    // don't steal focus — user keeps keyboard control (Space = play/pause)
}

// ── open existing ticket in sidebar ──────────────────────────
function openTicketDetails(ticket) {
    if (!ticket) return;
    S.editingTicketId = ticket.ticket_id;

    const type     = normalizeTicketType(ticket.type || ticket.ticket_type);
    const start    = getTicketStart(ticket);
    const end      = getTicketEnd(ticket);
    const source   = ticket.source || 'manual';
    const creation = ticket.creation_source || source;

    const badge = document.getElementById('td-source-badge');
    badge.dataset.source   = source;
    badge.dataset.creation = creation;
    document.getElementById('td-title').textContent       = 'Ticket Details';
    badge.textContent                                     = `${source.toUpperCase()} • ${creation.toUpperCase()}`;
    document.getElementById('td-comment').value          = ticket.comment || ticket.note || '';
    document.getElementById('td-spoken').value           = ticket.spoken  || '';
    document.getElementById('td-expected').value         = ticket.expected || '';
    document.getElementById('td-type').value             = type;
    document.getElementById('td-severity').value         = normalizeSeverity(ticket.severity);
    document.getElementById('td-start').value            = formatTime(start);
    document.getElementById('td-end').value              = formatTime(end);
    document.getElementById('td-script').value           = ticket.script || getScriptContextAroundTime(start);
    // Recompute the PDF page from the current section's alignment so old tickets
    // that were saved with a wrong page are corrected when opened.
    document.getElementById('td-page').value             = getPageAtTime(start);
    document.getElementById('td-ticket-id').value        = ticket.ticket_id;
    document.getElementById('td-section-id').value       = ticket.section_id || S.currentSection;
    document.getElementById('td-save').textContent       = 'Update Ticket';
    document.getElementById('td-delete').style.display  = 'block';
    lastAutoComment = '';
    openSidebar();
}

// ── gather form fields ────────────────────────────────────────
function gatherTicketFields() {
    const start  = parseTime(document.getElementById('td-start').value);
    const end    = parseTime(document.getElementById('td-end').value) || start;
    const badge  = document.getElementById('td-source-badge');
    const source   = badge.dataset.source   || 'manual';
    const creation = badge.dataset.creation || source;
    return {
        type:            document.getElementById('td-type').value,
        ticket_type:     document.getElementById('td-type').value,
        severity:        document.getElementById('td-severity').value,
        start_time: start,  end_time: Math.max(start, end),
        start,              end: Math.max(start, end),
        spoken:    document.getElementById('td-spoken').value.trim(),
        expected:  document.getElementById('td-expected').value.trim(),
        comment:   document.getElementById('td-comment').value.trim(),
        script:    document.getElementById('td-script').value.trim(),
        page:      document.getElementById('td-page').value.trim(),
        source:          'manual',
        creation_source: creation,
    };
}

// ── save ticket ───────────────────────────────────────────────
async function saveTicket() {
    if (!S.currentSection) return;
    updateAutoComment();
    const fields = gatherTicketFields();

    if (S.editingTicketId) {
        const r = await apiFetch('/api/l2/ticket/update', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket_id: S.editingTicketId, fields })
        });
        if (r.ok) {
            const sec = S.l2.sections[S.currentSection];
            for (const arr of [sec.tickets, sec.manual_tickets]) {
                const t = arr && arr.find(x => x.ticket_id === S.editingTicketId);
                if (t) { Object.assign(t, fields); break; }
            }
        }
    } else {
        const ticket = { ...fields, ticket_id: `manual_${Date.now()}` };
        const r = await apiFetch('/api/l2/ticket/add', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ section_id: S.currentSection, ticket })
        });
        if (r.ok) {
            if (!S.l2.sections[S.currentSection])
                S.l2.sections[S.currentSection] = { confidence: null, tickets: [], manual_tickets: [] };
            S.l2.sections[S.currentSection].manual_tickets.push(r.ticket || ticket);
        }
    }
    closeTicketDetails();
    renderTickets();
}

// ── timestamp / script helpers ────────────────────────────────
function updateTimestampFromSelection() {
    const sel = getAudioSelectionTimes();
    if (!sel) { alert('No audio selection — drag on the waveform first.'); return; }
    document.getElementById('td-start').value = formatTime(sel.start);
    document.getElementById('td-end').value   = formatTime(sel.end);
    document.getElementById('td-page').value  = getPageAtTime(sel.start);
}

function useCurrentScriptSelection() {
    const sel = getScriptSelectionText();
    if (!sel) { alert('No script text selected — highlight text in the script panel first.'); return; }

    // Replace script context with the new selection
    document.getElementById('td-script').value = sel.text;

    // If single word and spoken is empty, pre-fill it
    if (!sel.text.includes(' ') && !document.getElementById('td-spoken').value.trim())
        document.getElementById('td-spoken').value = sel.text;

    updateAutoComment();

    // Update timestamps + waveform selection if alignment info is available
    if (sel.startTime !== null) {
        document.getElementById('td-start').value = formatTime(sel.startTime);
        document.getElementById('td-end').value   = formatTime(sel.endTime ?? sel.startTime);

        // Mirror on waveform so the user can see the range
        selection.active = true;
        selection.start  = sel.startTime;
        selection.end    = sel.endTime ?? sel.startTime;
        audio.currentTime = sel.startTime;
        view.start = Math.max(0, sel.startTime - view.duration * 0.3);
        renderFrame();
    }
}

// ── auto comment ──────────────────────────────────────────────
function updateAutoComment() {
    const typeEl  = document.getElementById('td-type');
    const comment = document.getElementById('td-comment');
    if (!typeEl || !comment) return;

    const spoken   = document.getElementById('td-spoken').value;
    const expected = document.getElementById('td-expected').value;
    const sp = (spoken   || '').trim();
    const ex = (expected || '').trim();

    // If both spoken and expected are provided, the error is a misread.
    if (sp && ex && typeEl.value === 'OTHER') typeEl.value = 'MISREAD';

    const auto    = generateAutoComment(typeEl.value, spoken, expected);
    const current = comment.value.trim();
    if (!current || current === lastAutoComment) {
        comment.value = auto;
        lastAutoComment = auto;
    }
}

// ── delete ticket ─────────────────────────────────────────────
async function deleteTicket(ticketId) {
    if (!confirm('Delete this ticket?')) return;
    await apiFetch('/api/l2/ticket/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section_id: S.currentSection, ticket_id: ticketId })
    });
    const sec = S.l2.sections[S.currentSection];
    if (sec) {
        sec.tickets        = (sec.tickets        || []).filter(t => t.ticket_id !== ticketId);
        sec.manual_tickets = (sec.manual_tickets || []).filter(t => t.ticket_id !== ticketId);
    }
    if (S.selectedTicket && S.selectedTicket.ticket_id === ticketId) {
        S.selectedTicket  = null;
        S.editingTicketId = null;
    }
    closeTicketDetails();
    renderTickets();
}

// ── sidebar event listeners ───────────────────────────────────
document.getElementById('td-save').addEventListener('click', saveTicket);
document.getElementById('td-update-time').addEventListener('click', updateTimestampFromSelection);
document.getElementById('td-use-script').addEventListener('click', useCurrentScriptSelection);
document.getElementById('td-delete').addEventListener('click', () => { if (S.editingTicketId) deleteTicket(S.editingTicketId); });
document.getElementById('td-type').addEventListener('change', updateAutoComment);
document.getElementById('td-spoken').addEventListener('change', updateAutoComment);
document.getElementById('td-expected').addEventListener('change', updateAutoComment);
document.getElementById('td-close-btn').addEventListener('click', closeTicketDetails);
document.getElementById('td-overlay').addEventListener('click', closeTicketDetails);

// ── ticket navigation ─────────────────────────────────────────
function jumpToTicket(dir) {
    const tickets = allTickets().slice().sort((a, b) =>
        parseFloat(getTicketStart(a)) - parseFloat(getTicketStart(b))
    );
    if (!tickets.length) return;
    const cur = audio.currentTime;
    let idx = dir === 'next'
        ? tickets.findIndex(t => parseFloat(getTicketStart(t)) > cur + 0.1)
        : [...tickets].reverse().findIndex(t => parseFloat(getTicketStart(t)) < cur - 0.1);

    if (dir === 'prev' && idx !== -1) idx = tickets.length - 1 - idx;
    if (idx === -1) idx = dir === 'next' ? 0 : tickets.length - 1;
    const ticket = tickets[idx];
    if (!ticket) return;

    const cardEl = document.querySelector(`.ticket-card[data-tid="${ticket.ticket_id}"]`);
    selectTicket(ticket, cardEl);
    if (cardEl) cardEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ═══════════════════════════════════════════════════════════════
   ALL TICKETS  (project-wide list)
═══════════════════════════════════════════════════════════════ */
function getAllProjectTickets() {
    if (!S.l2 || !S.l2.sections) return [];
    const all = [];
    for (const [sectionId, sec] of Object.entries(S.l2.sections)) {
        if (!sec) continue;
        for (const arr of [sec.tickets || [], sec.manual_tickets || []]) {
            for (const t of arr) {
                if (!t) continue;
                const ticket = { ...t };
                if (!ticket.section_id) ticket.section_id = sectionId;
                all.push(ticket);
            }
        }
    }
    return all.sort((a, b) => {
        if (a.section_id !== b.section_id) return a.section_id.localeCompare(b.section_id);
        return parseFloat(getTicketStart(a)) - parseFloat(getTicketStart(b));
    });
}

function renderAllTicketsPanel() {
    const list = document.getElementById('all-tickets-list');
    list.innerHTML = '';
    const tickets = getAllProjectTickets();
    document.getElementById('at-count').textContent = tickets.length;

    if (!tickets.length) {
        list.innerHTML = '<div class="at-empty">No tickets found in this project.</div>';
        return;
    }

    tickets.forEach(t => {
        const type = normalizeTicketType(t.type || t.ticket_type);
        const sev  = normalizeSeverity(t.severity);
        const start = getTicketStart(t);
        const end   = getTicketEnd(t);
        const note  = (t.comment || t.note || '').trim();
        // Recompute page from the section's cached script data if available; otherwise fall
        // back to the stored value (which may be stale for tickets saved before the fix).
        const cached = t.section_id && S.sectionScripts[t.section_id];
        const page = cached
            ? getPageAtTime(parseFloat(start) || 0, cached)
            : (t.page || '');
        const pageLabel = page ? `<span class="at-page">Page ${escHtml(page)}</span>` : '';
        const color = TICKET_COLORS[type] || '#6b7280';
        const row = document.createElement('div');
        row.className = 'at-ticket';
        row.dataset.tid = t.ticket_id;
        row.dataset.sev = sev;
        row.innerHTML = `
          <div class="at-row">
            <div class="at-meta">
              <span class="at-section">${escHtml(fmtSection(t.section_id))}</span>
              <span class="at-type" style="color:${color}">${type}</span>
            </div>
            <button class="at-go" title="Go to ticket">Go</button>
          </div>
          <div class="at-time">${pageLabel}${formatTime(start)} – ${formatTime(end)}</div>
          ${note ? `<div class="at-note">${escHtml(note)}</div>` : ''}`;
        row.addEventListener('click', e => {
            if (e.target.closest('.at-go')) return;
            goToTicket(t);
        });
        row.querySelector('.at-go').addEventListener('click', e => {
            e.stopPropagation();
            goToTicket(t);
        });
        list.appendChild(row);
    });
}

function openAllTicketsPanel() {
    if (!S.projectName) { alert('Open a project first.'); return; }
    renderAllTicketsPanel();
    document.getElementById('all-tickets-panel').classList.add('open');
}

function closeAllTicketsPanel() {
    document.getElementById('all-tickets-panel').classList.remove('open');
}

function toggleAllTicketsPanel() {
    const panel = document.getElementById('all-tickets-panel');
    if (panel.classList.contains('open')) closeAllTicketsPanel();
    else openAllTicketsPanel();
}

async function goToTicket(ticket) {
    if (!ticket) return;
    const sectionId = ticket.section_id || ticket._sectionId;
    if (!sectionId) return;
    if (sectionId !== S.currentSection) await loadSection(sectionId);
    const sec = S.l2.sections[sectionId];
    let t = null;
    if (sec) {
        for (const arr of [sec.tickets || [], sec.manual_tickets || []]) {
            t = arr.find(x => x.ticket_id === ticket.ticket_id);
            if (t) break;
        }
    }
    if (!t) t = ticket;
    if (!t.section_id) t.section_id = sectionId;
    const cardEl = document.querySelector(`.ticket-card[data-tid="${t.ticket_id}"]`);
    selectTicket(t, cardEl);
    closeAllTicketsPanel();
    if (cardEl) cardEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.getElementById('all-tickets-btn').addEventListener('click', openAllTicketsPanel);
document.getElementById('at-close').addEventListener('click', closeAllTicketsPanel);

/* ═══════════════════════════════════════════════════════════════
   SEARCH
═══════════════════════════════════════════════════════════════ */
document.getElementById('search-btn').addEventListener('click', doSearch);
document.getElementById('search-box').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
document.getElementById('search-next-btn').addEventListener('click', nextSearchResult);

/* ═══════════════════════════════════════════════════════════════
   ZOOM
═══════════════════════════════════════════════════════════════ */
const MIN_ZOOM = 10;
const MAX_ZOOM = 32;
const DEFAULT_ZOOM = 14;

document.getElementById('zoom-in-btn').addEventListener('click', zoomIn);
document.getElementById('zoom-out-btn').addEventListener('click', zoomOut);
document.getElementById('zoom-reset-btn').addEventListener('click', resetZoom);

function zoomIn() {
    if (S.scriptZoom < MAX_ZOOM) {
        S.scriptZoom = Math.min(S.scriptZoom + 2, MAX_ZOOM);
        applyZoom();
    }
}

function zoomOut() {
    if (S.scriptZoom > MIN_ZOOM) {
        S.scriptZoom = Math.max(S.scriptZoom - 2, MIN_ZOOM);
        applyZoom();
    }
}

function resetZoom() {
    S.scriptZoom = DEFAULT_ZOOM;
    applyZoom();
}

function applyZoom() {
    const scriptContent = document.getElementById('script-content');
    if (scriptContent) {
        scriptContent.style.fontSize = S.scriptZoom + 'px';
    }
    updateZoomIndicator();
    
    // Persist zoom level to server
    apiFetch('/api/session/zoom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script_zoom: S.scriptZoom })
    });
}

function updateZoomIndicator() {
    const zoomLevel = document.getElementById('zoom-level');
    if (zoomLevel) {
        const percentage = Math.round((S.scriptZoom / DEFAULT_ZOOM) * 100);
        zoomLevel.textContent = percentage + '%';
    }
}

function doSearch() {
    const q = document.getElementById('search-box').value.trim().toLowerCase();
    S.scriptSpans.forEach(s => s.classList.remove('search-match', 'search-active'));
    S.searchMatches = [];
    S.searchCursor  = -1;
    if (!q) return;
    S.scriptSpans.forEach((span, i) => {
        if (span.textContent.trim().toLowerCase().includes(q)) {
            span.classList.add('search-match');
            S.searchMatches.push(i);
        }
    });
    if (S.searchMatches.length) nextSearchResult();
}

function nextSearchResult() {
    if (!S.searchMatches.length) return;
    if (S.searchCursor >= 0 && S.scriptSpans[S.searchMatches[S.searchCursor]])
        S.scriptSpans[S.searchMatches[S.searchCursor]].classList.remove('search-active');
    S.searchCursor = (S.searchCursor + 1) % S.searchMatches.length;
    const span = S.scriptSpans[S.searchMatches[S.searchCursor]];
    if (span) { span.classList.add('search-active'); span.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

/* ═══════════════════════════════════════════════════════════════
   KEYBOARD  SHORTCUTS
═══════════════════════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
    const tag = document.activeElement.tagName;
    const inFormField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (inFormField) {
        // Suppress all shortcuts while typing. Only Escape escapes.
        if (e.key === 'Escape') { e.target.blur(); closeTicketDetails(); }
        return;
    }

    if (e.code === 'Space') {
        e.preventDefault();
        if (audio.paused) { audio.play(); playBtn.disabled = true; pauseBtn.disabled = false; }
        else              { audio.pause(); playBtn.disabled = false; pauseBtn.disabled = true; }
    }
    if (e.key === 't' || e.key === 'T') { e.preventDefault(); openNewTicket(); }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); addMarker(); }
    if (e.key === 'a' || e.key === 'A') { e.preventDefault(); toggleAllTicketsPanel(); }
    if (e.key === ']') { e.preventDefault(); jumpToTicket('next'); }
    if (e.key === '[') { e.preventDefault(); jumpToTicket('prev'); }
    if (e.key === 'Delete' && S.selectedTicket) { e.preventDefault(); deleteTicket(S.selectedTicket.ticket_id); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 5); }
    if (e.key === 'ArrowRight') { e.preventDefault(); audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5); }
    
    // Zoom shortcuts
    if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomIn(); }
        if (e.key === '-') { e.preventDefault(); zoomOut(); }
        if (e.key === '0') { e.preventDefault(); resetZoom(); }
    }
    
    if (e.key === 'Escape') {
        if (document.getElementById('all-tickets-panel').classList.contains('open')) {
            closeAllTicketsPanel();
        } else if (document.getElementById('ticket-details-panel').classList.contains('open')) {
            closeTicketDetails();
        } else if (selection.active) {
            selection.active = false;
            renderFrame();
        }
    }
});

/* ═══════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════ */
async function apiFetch(url, opts) {
    const r = await fetch(url, opts);
    return r.json();
}

function showLoading(show) {
    document.getElementById('loading').classList.toggle('hidden', !show);
}

function escHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/* ═══════════════════════════════════════════════════════════════
   QC'ER NAME / LOGIN
═══════════════════════════════════════════════════════════════ */
function updateQcerDisplay() {
    const name = localStorage.getItem('qcerName') || '';
    const display = document.getElementById('qcer-name');
    const editBtn = document.getElementById('qcer-edit-btn');
    if (display) display.textContent = name ? `QC'er: ${name}` : '';
    if (editBtn) editBtn.textContent = name ? 'Change' : 'Set Name';
}

function showLogin() {
    const overlay = document.getElementById('login-overlay');
    const input = document.getElementById('login-name-input');
    if (overlay) overlay.classList.remove('hidden');
    if (input) input.value = localStorage.getItem('qcerName') || '';
}

function hideLogin() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.classList.add('hidden');
}

function saveLoginName() {
    const input = document.getElementById('login-name-input');
    const name = input ? input.value.trim() : '';
    if (!name) return;
    localStorage.setItem('qcerName', name);
    if (input) input.value = '';
    updateQcerDisplay();
    hideLogin();
}

document.getElementById('login-save-btn').addEventListener('click', saveLoginName);
document.getElementById('login-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveLoginName();
});
document.getElementById('qcer-edit-btn').addEventListener('click', showLogin);

if (localStorage.getItem('qcerName')) {
    updateQcerDisplay();
    hideLogin();
}
console.log('[QC Lite] page helper v2 loaded — using token-based PDF page lookup');
