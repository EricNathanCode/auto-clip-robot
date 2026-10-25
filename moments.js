// Finds candidate moments in a long stream the cheap way, from the sound alone (no AI yet):
//   🔊 loud spikes (screams, laughs, hype) compared with how loud this stream usually is
//   💥 "silence → explosion": a quiet stretch followed by a sudden burst (classic reaction moment)
//   📈 optional extra clues from outside (YouTube "most replayed", Twitch chat spikes), as { t, weight } lists
// The slow speech AI and the brain only look at the windows found here.
const { TOOLS, run, round } = require("./tools");

const STEP = 0.25; // seconds per loudness reading

// Loudness (RMS, dBFS) every 0.25 s for the whole file. FFmpeg prints one reading per chunk to stdout.
async function loudness(file) {
  const out = await run(TOOLS.ffmpeg(), ["-v", "error", "-i", file, "-vn", "-af",
    `aresample=16000,pan=mono|c0=c0,asetnsamples=n=${16000 * STEP}:p=0,astats=metadata=1:reset=1,` +
    "ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-", "-f", "null", "-"]);
  const levels = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/RMS_level=(\S+)/);
    if (m) levels.push(Number.isFinite(Number(m[1])) ? Number(m[1]) : -90); // "-inf" = digital silence
  }
  return levels;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Turns the loudness list into a "how exciting is it here" score per reading (0 = normal for this stream).
function excitement(levels) {
  const voiced = levels.filter((l) => l > -60);
  const mid = median(voiced.length ? voiced : levels);
  const spread = Math.max(1.5, median(voiced.map((l) => Math.abs(l - mid)))); // typical wobble, in dB
  const z = levels.map((l) => (l - mid) / spread);
  const win = Math.round(1 / STEP); // 1 s smoothing so one clap doesn't count as a moment
  const smooth = z.map((_, i) => mean(z.slice(Math.max(0, i - win + 1), i + 1)));
  const bonus = smooth.map((_, i) => {
    const before = z.slice(Math.max(0, i - 3 * win), Math.max(0, i - win)); // 1-3 s earlier
    const quiet = before.filter((x) => x < -1).length / Math.max(1, before.length); // short pauses in talk don't count
    return before.length >= win && quiet >= 0.7 && smooth[i] > 1.2 ? 1.5 : 0;
  });
  return { score: smooth.map((s, i) => s + bonus[i]), bonus, mid, spread };
}

// Picks the best peaks, at least `gap` seconds apart, and gives each a window that starts well before the peak
// (the setup) and ends a bit after it (the reaction).
function pickPeaks(score, { count = 10, gap = 90, before = 45, after = 30, duration, extras = [], bonus = [] }) {
  const pts = score.map((s, i) => ({ t: round(i * STEP), s, reasons: s > 1 ? ["loud"] : [] }));
  bonus.forEach((b, i) => b && pts[i].reasons.push("silence → explosion"));
  for (const { t, weight = 2, why = "clue" } of extras) { // outside clues lift nearby readings
    for (let i = Math.max(0, Math.round((t - 5) / STEP)); i < Math.min(pts.length, Math.round((t + 5) / STEP)); i++) {
      pts[i].s += weight;
      if (!pts[i].reasons.includes(why)) pts[i].reasons.push(why);
    }
  }
  const chosen = [];
  for (const p of [...pts].sort((a, b) => b.s - a.s)) {
    if (chosen.length >= count) break;
    if (chosen.some((c) => Math.abs(c.t - p.t) < gap)) continue;
    chosen.push(p);
  }
  return chosen.sort((a, b) => a.t - b.t).map((p) => ({
    peak: p.t,
    score: round(p.s),
    reasons: p.reasons.length ? p.reasons : ["highest point nearby"],
    start: round(Math.max(0, p.t - before)),
    end: round(Math.min(duration, p.t + after)),
  }));
}

// Main entry: candidate windows for a file. Short files (under ~2.5 min) become one window.
async function findMoments(file, duration, opts = {}) {
  if (duration <= (opts.before ?? 45) + (opts.after ?? 30) + 75) {
    return [{ peak: round(duration / 2), score: 0, reasons: ["short video: all of it"], start: 0, end: round(duration) }];
  }
  const levels = await loudness(file);
  const { score, bonus } = excitement(levels);
  return pickPeaks(score, { ...opts, duration, bonus });
}

module.exports = { findMoments, loudness, excitement, pickPeaks, STEP };
