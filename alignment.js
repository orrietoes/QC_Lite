'use strict';

/**
 * Progressive Anchor Alignment — JS port of Python app.py
 *
 * Key porting notes:
 *   - normalizeTextToken uses /[^\p{L}\p{N}\s]/gu  (Unicode property escapes, Node ≥10)
 *     so that Devanagari and other non-ASCII scripts are handled the same way Python's
 *     re.sub(r"[^\w\s]", ...) does with its Unicode-aware \w.
 *   - sequenceMatcherRatio uses character-level LCS (= Python SequenceMatcher.ratio())
 *   - tolerantSegmentAlignment groups consecutive delete+insert blocks into replace pairs
 *     (= Python SequenceMatcher 'replace' opcode handling)
 */

// ── normalisation ─────────────────────────────────────────────────────────────

function normalizeTextToken(word) {
    if (!word) return '';
    word = word.toLowerCase();
    // remove apostrophes / curly apostrophes (contractions)
    word = word.replace(/['\u2019]/g, '');
    // remove anything that is not a Unicode letter, digit, or whitespace
    // IMPORTANT: use the `u` flag + \p{L}\p{N} so that Devanagari, CJK, etc.
    // are kept (same behaviour as Python 3's Unicode-aware re.sub(r"[^\w\s]",...))
    word = word.replace(/[^\p{L}\p{N}\s]/gu, '');
    word = word.replace(/\s+/g, ' ').trim();
    return word;
}

// ── character-level similarity (= Python SequenceMatcher.ratio()) ─────────────

function sequenceMatcherRatio(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const m = a.length, n = b.length;
    // rolling 1-D DP for space efficiency
    let prev = new Int32Array(n + 1);
    let curr = new Int32Array(n + 1);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            curr[j] = a[i - 1] === b[j - 1]
                ? prev[j - 1] + 1
                : Math.max(prev[j], curr[j - 1]);
        }
        [prev, curr] = [curr, prev];
        curr.fill(0);
    }
    const lcs = prev[n];
    return (2 * lcs) / (m + n);
}

// ── token-level helpers ───────────────────────────────────────────────────────

function tokensMatch(t1, t2) {
    return t1 === t2 || sequenceMatcherRatio(t1, t2) >= 0.8;
}

function phraseSimilarity(phrase1, phrase2) {
    if (phrase1.length !== phrase2.length) return false;
    let exact = 0, similar = 0;
    for (let i = 0; i < phrase1.length; i++) {
        if (phrase1[i] === phrase2[i]) { exact++; similar++; }
        else if (sequenceMatcherRatio(phrase1[i], phrase2[i]) >= 0.8) similar++;
    }
    const len = phrase1.length;
    return (exact / len) >= 0.7 || (similar / len) >= 0.8;
}

// ── backward alignment ────────────────────────────────────────────────────────

function backwardAlign(scriptTokens, spokenTokens, anchorScript, anchorSpoken) {
    let s = anchorScript, w = anchorSpoken;
    while (s > 0 && w > 0) {
        if (tokensMatch(scriptTokens[s - 1], spokenTokens[w - 1])) { s--; w--; }
        else break;
    }
    return [s, w];
}

// ── intro anchor detection ────────────────────────────────────────────────────

function findIntroAnchorStrict(scriptTokens, spokenTokens) {
    const PHRASE_LEN = 12;
    const THRESHOLD  = 0.85;
    const RARE_MAX   = 5;

    if (scriptTokens.length < PHRASE_LEN) return [0, 0];

    // word frequencies across script
    const freq = {};
    for (const t of scriptTokens) freq[t] = (freq[t] || 0) + 1;

    for (let si = 0; si <= scriptTokens.length - PHRASE_LEN; si++) {
        const scriptPhrase = scriptTokens.slice(si, si + PHRASE_LEN);
        // must have at least one rare (distinctive) token
        if (!scriptPhrase.some(t => (freq[t] || 0) <= RARE_MAX)) continue;

        for (let wi = 0; wi <= spokenTokens.length - PHRASE_LEN; wi++) {
            const spokenPhrase = spokenTokens.slice(wi, wi + PHRASE_LEN);
            let hits = 0;
            for (let k = 0; k < PHRASE_LEN; k++) {
                if (scriptPhrase[k] === spokenPhrase[k]) hits++;
            }
            if (hits / PHRASE_LEN >= THRESHOLD) {
                // Match Python exactly: return (spoken_start, spoken_start)
                // Python returns (wi, wi) — both set to the spoken position.
                // The backward-align step then finds the true starts.
                return [wi, wi];
            }
        }
    }
    return [0, 0];
}

// ── progressive anchor generation ─────────────────────────────────────────────

function generateProgressiveAnchors(scriptTokens, spokenTokens, startAnchor) {
    const SPACING    = 80;
    const PHRASE_LEN = 8;

    const anchors = [{ scriptIndex: startAnchor, spokenIndex: startAnchor, time: null }];
    let curScript = startAnchor;
    let curSpoken = startAnchor;

    while (curScript < scriptTokens.length) {
        const nextScript = curScript + SPACING;
        if (nextScript >= scriptTokens.length) break;

        const anchorPhrase = scriptTokens.slice(nextScript, nextScript + PHRASE_LEN);
        if (anchorPhrase.length < PHRASE_LEN) break;

        const searchStart = curSpoken + 20;
        let found = false;

        for (let i = searchStart; i <= spokenTokens.length - PHRASE_LEN; i++) {
            if (phraseSimilarity(anchorPhrase, spokenTokens.slice(i, i + PHRASE_LEN))) {
                anchors.push({ scriptIndex: nextScript, spokenIndex: i, time: null });
                curScript = nextScript;
                curSpoken = i;
                found = true;
                break;
            }
        }
        if (!found) break;
    }
    return anchors;
}

// ── segment alignment ─────────────────────────────────────────────────────────
//
// Matches Python's tolerant_segment_alignment which uses SequenceMatcher opcodes:
//   equal   → map each token pair directly
//   replace → fuzzy-match each aligned pair (min length side)
//   delete / insert → no mapping
//
// Our LCS backtrack produces only equal/del/ins.  We post-process to group
// consecutive del+ins blocks into "replace" pairs, exactly as SequenceMatcher does.

function tolerantSegmentAlignment(scriptSeg, spokenSeg, scriptOff, spokenOff) {
    const map = {};
    if (!scriptSeg.length || !spokenSeg.length) return map;

    const m = scriptSeg.length, n = spokenSeg.length;

    // 2-D LCS DP
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = scriptSeg[i - 1] === spokenSeg[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }

    // Backtrack → list of raw ops
    const ops = [];   // {tag:'equal'|'del'|'ins', si, wi}
    let i = m, j = n;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && scriptSeg[i - 1] === spokenSeg[j - 1]) {
            ops.push({ tag: 'equal', si: i - 1, wi: j - 1 });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            ops.push({ tag: 'ins', wi: j - 1 });
            j--;
        } else {
            ops.push({ tag: 'del', si: i - 1 });
            i--;
        }
    }
    ops.reverse();

    // Process ops: map equal blocks, group del+ins into replace blocks
    let k = 0;
    while (k < ops.length) {
        const op = ops[k];

        if (op.tag === 'equal') {
            map[scriptOff + op.si] = spokenOff + op.wi;
            k++;

        } else if (op.tag === 'del' || op.tag === 'ins') {
            // Collect a run of consecutive del and ins (in any order)
            const dels = [], ins = [];
            while (k < ops.length && (ops[k].tag === 'del' || ops[k].tag === 'ins')) {
                if (ops[k].tag === 'del') dels.push(ops[k].si);
                else                     ins.push(ops[k].wi);
                k++;
            }
            // Pair them up as a "replace" block and fuzzy-match
            const pairs = Math.min(dels.length, ins.length);
            for (let p = 0; p < pairs; p++) {
                if (sequenceMatcherRatio(scriptSeg[dels[p]], spokenSeg[ins[p]]) >= 0.8) {
                    map[scriptOff + dels[p]] = spokenOff + ins[p];
                }
            }

        } else {
            k++;
        }
    }

    return map;
}

// ── main alignment entry point ────────────────────────────────────────────────

function progressiveAnchorAlignment(scriptTokens, transcriptionWords) {
    const spokenTokens = transcriptionWords.map(w => normalizeTextToken(w.word));

    // Step 1: find intro anchor — returns [spokenStart, spokenStart] (same as Python)
    let [introSpoken, introScript] = findIntroAnchorStrict(scriptTokens, spokenTokens);

    // Step 2: backward-align from the intro anchor to the true start
    const [trueScript, trueSpoken] = backwardAlign(scriptTokens, spokenTokens, introScript, introSpoken);
    introSpoken = trueSpoken;
    introScript = trueScript;

    // Step 3: generate progressive anchors
    const anchors = generateProgressiveAnchors(scriptTokens, spokenTokens, introSpoken);

    // Step 4: fill anchor timestamps
    for (const anchor of anchors) {
        if (anchor.spokenIndex < transcriptionWords.length) {
            anchor.time = transcriptionWords[anchor.spokenIndex].start;
        }
    }

    // Step 5: segment alignment between consecutive anchors
    const globalMap = {};

    for (let a = 0; a < anchors.length - 1; a++) {
        const a1 = anchors[a], a2 = anchors[a + 1];
        const scriptSeg = scriptTokens.slice(a1.scriptIndex, a2.scriptIndex);
        const spokenSeg = spokenTokens.slice(a1.spokenIndex, a2.spokenIndex);
        const seg = tolerantSegmentAlignment(scriptSeg, spokenSeg, a1.scriptIndex, a1.spokenIndex);
        Object.assign(globalMap, seg);
    }

    // Step 6: final segment (last anchor → end)
    if (anchors.length) {
        const last = anchors[anchors.length - 1];
        const seg = tolerantSegmentAlignment(
            scriptTokens.slice(last.scriptIndex),
            spokenTokens.slice(last.spokenIndex),
            last.scriptIndex, last.spokenIndex
        );
        Object.assign(globalMap, seg);
    }

    // Step 7: compute scriptStartTime from first mapped token
    let scriptStartTime = 0;
    const mappedScriptIndices = Object.keys(globalMap).map(Number);
    if (mappedScriptIndices.length) {
        const firstScript = Math.min(...mappedScriptIndices);
        const firstSpoken = globalMap[firstScript];
        if (firstSpoken < transcriptionWords.length) {
            scriptStartTime = transcriptionWords[firstSpoken].start;
        }
    } else if (introSpoken < transcriptionWords.length) {
        scriptStartTime = transcriptionWords[introSpoken].start;
    }

    return { scriptStartTime, timestampMap: globalMap, anchors };
}

module.exports = { normalizeTextToken, progressiveAnchorAlignment };
