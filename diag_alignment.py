import sys, json, re
from difflib import SequenceMatcher

def normalize_text_token(word):
    if not word: return ""
    word = word.lower()
    word = re.sub(r"['\u2019]", "", word)
    word = re.sub(r"[^\w\s]", "", word)
    word = re.sub(r"\s+", " ", word).strip()
    return word

def phrase_similarity(phrase1, phrase2):
    if len(phrase1) != len(phrase2): return False
    exact = similar = 0
    for t1, t2 in zip(phrase1, phrase2):
        if t1 == t2: exact += 1; similar += 1
        elif SequenceMatcher(None, t1, t2).ratio() >= 0.8: similar += 1
    return (exact / len(phrase1)) >= 0.7 or (similar / len(phrase1)) >= 0.8

def tokens_match(a, b):
    return a == b or SequenceMatcher(None, a, b).ratio() >= 0.8

def backward_align(script, spoken, sc, wc):
    while sc > 0 and wc > 0:
        if tokens_match(script[sc-1], spoken[wc-1]): sc -= 1; wc -= 1
        else: break
    return sc, wc

def find_intro_anchor_strict(script_tokens, spoken_tokens):
    PL = 12; THRESH = 0.85; RARE = 5
    if len(script_tokens) < PL: return 0, 0.0
    freq = {}
    for t in script_tokens: freq[t] = freq.get(t,0)+1
    for ss in range(len(script_tokens)-PL+1):
        sp = script_tokens[ss:ss+PL]
        if not any(freq.get(t,0) <= RARE for t in sp): continue
        for ws in range(len(spoken_tokens)-PL+1):
            wp = spoken_tokens[ws:ws+PL]
            hits = sum(1 for a,b in zip(sp,wp) if a==b)
            if hits/PL >= THRESH:
                print(f"  INTRO ANCHOR: script_start={ss}, spoken_start={ws}, python returns ({ws},{ws})")
                return ws, ws
    return 0, 0.0

def generate_progressive_anchors(script, spoken, start):
    SPACING=80; PL=8
    anchors=[{'script_index':start,'spoken_index':start,'time':None}]
    cs=cw=start
    while cs < len(script):
        ns = cs+SPACING
        if ns >= len(script): break
        phrase = script[ns:ns+PL]
        if len(phrase)<PL: break
        found=False
        for i in range(cw+20, len(spoken)-PL+1):
            if phrase_similarity(phrase, spoken[i:i+PL]):
                anchors.append({'script_index':ns,'spoken_index':i,'time':None})
                cs=ns; cw=i; found=True; break
        if not found: break
    return anchors

def tolerant_segment_alignment(script_seg, spoken_seg, so, wo):
    if not script_seg or not spoken_seg: return {}
    m = {}
    matcher = SequenceMatcher(None, script_seg, spoken_seg)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        sc = script_seg[i1:i2]; wc = spoken_seg[j1:j2]
        if tag == 'equal':
            for k in range(len(sc)): m[so+i1+k] = wo+j1+k
        elif tag == 'replace':
            for k in range(min(len(sc),len(wc))):
                if SequenceMatcher(None,sc[k],wc[k]).ratio() >= 0.8:
                    m[so+i1+k] = wo+j1+k
    return m

def run_alignment(script_tokens, words):
    spoken = [normalize_text_token(w['word']) for w in words]
    ia, ss = find_intro_anchor_strict(script_tokens, spoken)
    ts, tw = backward_align(script_tokens, spoken, ss, ia)
    print(f"After backward_align: script_start={ts}, spoken_start={tw}")
    ia = tw; ss = ts
    anchors = generate_progressive_anchors(script_tokens, spoken, ia)
    for a in anchors:
        if a['spoken_index'] < len(words): a['time'] = words[a['spoken_index']]['start']
    gm = {}
    for i in range(len(anchors)-1):
        a1,a2 = anchors[i], anchors[i+1]
        seg = tolerant_segment_alignment(
            script_tokens[a1['script_index']:a2['script_index']],
            spoken[a1['spoken_index']:a2['spoken_index']],
            a1['script_index'], a1['spoken_index'])
        gm.update(seg)
    if anchors:
        last=anchors[-1]
        seg = tolerant_segment_alignment(script_tokens[last['script_index']:], spoken[last['spoken_index']:],
            last['script_index'], last['spoken_index'])
        gm.update(seg)
    return gm, anchors

with open(r"C:\Users\ariel\Documents\AuriO_QC\projects\861f4c82-dd03-46d0-a804-e97bb2d40d82\script.json", encoding='utf-8') as f:
    s = json.load(f)
with open(r"C:\Users\ariel\Documents\AuriO_QC\projects\861f4c82-dd03-46d0-a804-e97bb2d40d82\qc\transcription.json", encoding='utf-8') as f:
    t = json.load(f)

tokens = s['sections']['sec_001']['tokens']
words  = t['sections']['sec_001']['words']
script_tokens = [normalize_text_token(tk.get('raw','')) for tk in tokens]

print(f"Script tokens: {len(script_tokens)}, Spoken words: {len(words)}")
print(f"Script[0:5]: {script_tokens[:5]}")
print(f"Spoken[0:5]: {[w['word'] for w in words[:5]]}")

m, anchors = run_alignment(script_tokens, words)
print(f"\nMap size: {len(m)}, Anchors: {len(anchors)}")
print("First anchor:", anchors[0])
print("\nFirst 20 map entries:")
for si, wi in sorted(m.items())[:20]:
    sw = tokens[si]['raw'] if si < len(tokens) else '?'
    ww = words[wi]['word'] if wi < len(words) else '?'
    wt = words[wi]['start'] if wi < len(words) else '?'
    print(f"  si={si} [{sw}] -> wi={wi} [{ww}] @{wt}s")

# t=100s check
for wi,w in enumerate(words):
    if w['start'] <= 100 <= w['end']:
        rev = {v:k for k,v in m.items()}
        si = rev.get(wi)
        print(f"\nAt t=100s: wi={wi} [{w['word']}] -> si={si} [{tokens[si]['raw'] if si else 'UNMAPPED'}]")
        break
