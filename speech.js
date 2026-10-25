// Speech → words with timing, using whisper.cpp (whisper-cli) and an English model. Only the candidate windows are
// written down, never the whole stream, so a CPU-only Dell keeps up (small.en ran ~3x faster than real time on 4 threads).
const fs = require("fs");
const path = require("path");
const { TOOLS, run, round } = require("./tools");

// Words that are really sound labels, not speech: Whisper writes these for music, laughter, applause…
const SOUND_LABEL = /^[\[(](music|singing|laughter|laughs|applause|silence|blank_audio|inaudible|cheering|♪)[\])]$/i;
const MUSIC = /[\[(](music|singing)[\])]|♪/i;

// Word timing: Whisper's normal token times wander (measured: from 1 s early to 0.2 s late), which made captions feel
// out of sync. Its DTW mode (needs flash attention off, ~20% slower) lands every word ~0.23 s late, steadily, so we
// use it and take that lag off. The DTW preset is the model's name (small.en, medium…).
const DTW_LAG = 0.22;
const dtwPreset = () => (/(tiny|base|small|medium)(\.en)?/.exec(path.basename(TOOLS.whisperModel())) || [""])[0];

// Writes down [start, end] of a file. Returns { words: [{ w, t0, t1 }], sentences: [{ text, t0, t1, words }], music }
// with times in seconds from the start of the FILE (not of the window).
async function transcribe(file, start, end, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const base = path.join(workDir, `speech-${Math.round(start * 1000)}`);
  await run(TOOLS.ffmpeg(), ["-y", "-v", "error", "-ss", String(start), "-to", String(end), "-i", file,
    "-vn", "-ar", "16000", "-ac", "1", `${base}.wav`]);
  const dtw = dtwPreset();
  await run(TOOLS.whisper(), ["-m", TOOLS.whisperModel(), "-f", `${base}.wav`, "-t", String(TOOLS.threads()),
    "-l", "en", "-ojf", "-of", base, "-np", ...(dtw ? ["-dtw", dtw, "-nfa"] : [])]);
  const json = JSON.parse(fs.readFileSync(`${base}.json`, "utf8"));
  fs.rmSync(`${base}.wav`, { force: true });
  return fromWhisper(json, start);
}

// Whisper gives tokens (pieces of words). A token that starts with a space begins a new word; the others (and
// punctuation) stick to the word before. Special tokens like [_BEG_] and the lone dash Whisper writes when someone
// breaks off mid-sentence ("we were in, -") are skipped.
const HAS_LETTER = /[\p{L}\p{N}]/u;
function fromWhisper(json, offset = 0) {
  const words = [], sentences = [];
  let music = false;
  for (const seg of json.transcription || []) {
    if (MUSIC.test(seg.text)) music = true;
    const first = words.length;
    for (const tok of seg.tokens || []) {
      const text = tok.text;
      if (!text || /^\[_/.test(text.trim()) || /^<\|.*\|>$/.test(text.trim())) continue; // [_BEG_], [_TT_150], <|endoftext|>
      if (/^\s+[-–—]+\s*$/.test(text)) continue;
      const from = tok.t_dtw >= 0 ? tok.t_dtw / 100 - DTW_LAG : tok.offsets.from / 1000; // t_dtw is in 10 ms steps
      const t0 = round(offset + Math.max(0, from)), t1 = round(offset + tok.offsets.to / 1000);
      if ((/^\s/.test(text) && HAS_LETTER.test(text)) || !words.length || words.length === first && HAS_LETTER.test(text)) {
        words.push({ w: text.trim(), t0, t1 });
      } else {
        const last = words[words.length - 1];
        last.w += text;
        last.t1 = Math.max(last.t1, t1);
      }
    }
    const segWords = words.splice(first).filter((w) => HAS_LETTER.test(w.w) && !SOUND_LABEL.test(w.w));
    words.push(...segWords);
    if (segWords.length) {
      sentences.push({ text: segWords.map((w) => w.w).join(" "), t0: segWords[0].t0, t1: segWords[segWords.length - 1].t1,
        words: segWords });
    }
  }
  // Starts and ends from two different clocks: keep every word in order, ending after it starts and before the next.
  words.forEach((w, i) => {
    if (i && w.t0 <= words[i - 1].t0) w.t0 = round(words[i - 1].t0 + 0.01);
    if (w.t1 < w.t0 + 0.1) w.t1 = round(w.t0 + 0.25);
  });
  words.forEach((w, i) => { if (i + 1 < words.length && w.t1 > words[i + 1].t0) w.t1 = words[i + 1].t0; });
  for (const s of sentences) { s.t0 = s.words[0].t0; s.t1 = s.words[s.words.length - 1].t1; }
  return { words, sentences, music };
}

module.exports = { transcribe, fromWhisper };
