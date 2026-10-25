// Burned-in text as an ASS subtitle file (rendered by FFmpeg's libass with the Fredoka font):
//   word-by-word captions (2-3 words at a time, the spoken word highlighted and a bit bigger),
//   a hook title in a white box for the first seconds, and a small credit line ("@streamer") the whole clip.
// Three caption looks, so the TikTok / Shorts / Reels / X versions don't look like copies of each other.
const { round } = require("./tools");

const W = 1080, H = 1920;
// ASS colours are &HAABBGGRR (alpha, blue, green, red).
const WHITE = "&H00FFFFFF", BLACK = "&H00000000", YELLOW = "&H004DE1FF", PINK = "&H00B672F4", PURPLE = "&H00F65C8B";
const LOOKS = {
  pop: { upper: true, size: 84, colour: WHITE, highlight: YELLOW, border: 1, outline: 7, back: "&H64000000" },
  clean: { upper: false, size: 80, colour: WHITE, highlight: PINK, border: 1, outline: 6, back: "&H64000000" },
  box: { upper: true, size: 76, colour: WHITE, highlight: YELLOW, border: 3, outline: 12, back: "&H96000000" },
};
const MAX_WORDS = 3, MAX_CHARS = 16;

const ts = (s) => {
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};
const clean = (t) => t.replace(/[{}\\]/g, "").replace(/\s+/g, " ").trim();

// Groups words into short caption chunks: max 3 words / 16 letters, and a new chunk after a pause or a full stop.
function chunks(words) {
  const out = [];
  let cur = [];
  for (const w of words) {
    const len = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
    const prev = cur[cur.length - 1];
    if (cur.length && (cur.length >= MAX_WORDS || len > MAX_CHARS || w.t0 - prev.t1 > 0.45 || /[.!?]$/.test(prev.w))) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

function header(look, { captionY, hookY }) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Fredoka,${look.size},${look.colour},${look.colour},${look.border === 3 ? look.back : BLACK},${look.back},-1,0,0,0,100,100,0,0,${look.border},${look.outline},2,5,60,60,0,1
Style: Hook,Fredoka,72,${BLACK},${BLACK},${WHITE},${WHITE},-1,0,0,0,100,100,0,0,3,18,0,8,90,90,${hookY},1
Style: Credit,Fredoka SemiBold,36,&H33FFFFFF,&H33FFFFFF,${BLACK},${BLACK},0,0,0,0,100,100,0,0,1,3,0,1,60,60,430,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

// words: [{ w, t0, t1 }] with times in seconds of the SOURCE; clipStart/clipEnd cut them to the clip.
function buildAss({ words, clipStart, clipEnd, look = "pop", hook = "", credit = "", captionY = 1250, hookY = 230, hookSeconds = 3.2 }) {
  const L = LOOKS[look] || LOOKS.pop;
  const lines = [];
  const inClip = words.filter((w) => w.t1 > clipStart && w.t0 < clipEnd)
    .map((w) => ({ w: clean(L.upper ? w.w.toUpperCase() : w.w), t0: w.t0 - clipStart, t1: w.t1 - clipStart }))
    .filter((w) => w.w);
  const groups = chunks(inClip);
  groups.forEach((g, gi) => {
    const next = groups[gi + 1];
    const groupEnd = Math.min(g[g.length - 1].t1 + 0.15, next ? next[0].t0 : clipEnd - clipStart);
    g.forEach((word, k) => {
      const a = word.t0, b = k < g.length - 1 ? g[k + 1].t0 : groupEnd;
      if (b - a < 0.02) return;
      // The spoken word is coloured (and a bit bigger, except in the box look, where a bigger word breaks the box).
      const big = L.border === 3 ? "" : "\\fscx115\\fscy115";
      const text = g.map((x, j) => (j === k ? `{\\c${L.highlight}${big}}${x.w}{\\r}` : x.w)).join(" ");
      lines.push(`Dialogue: 1,${ts(a)},${ts(b)},Cap,,0,0,0,,{\\an5\\pos(${W / 2},${captionY})}${text}`);
    });
  });
  if (hook) lines.push(`Dialogue: 2,${ts(0)},${ts(Math.min(hookSeconds, clipEnd - clipStart))},Hook,,0,0,0,,{\\fad(120,250)}${clean(hook)}`);
  if (credit) lines.push(`Dialogue: 0,${ts(0)},${ts(clipEnd - clipStart)},Credit,,0,0,0,,${clean(credit)}`);
  return header(L, { captionY, hookY }) + lines.join("\n") + "\n";
}

module.exports = { buildAss, chunks, LOOKS, ts: (s) => ts(round(s)) };
