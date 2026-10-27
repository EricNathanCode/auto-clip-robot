// Burned-in text as an ASS subtitle file (rendered by FFmpeg's libass with the Fredoka font):
//   word-by-word captions (2-3 words at a time, the spoken word highlighted and a bit bigger),
//   a hook title in a white box for the first seconds, and the creator's name ("@streamer") top-left the whole clip,
//   just under the platforms' top bar.
// Three caption looks, so the TikTok / Shorts / Reels / X versions don't look like copies of each other.
const { round } = require("./tools");

const W = 1080, H = 1920;
// ASS colours are &HAABBGGRR (alpha, blue, green, red).
// No look puts a dark box behind the words: a box darkens the picture under it.
const WHITE = "&H00FFFFFF", BLACK = "&H00000000", YELLOW = "&H004DE1FF", PINK = "&H00B672F4", MINT = "&H00B4F07A";
const LOOKS = {
  pop: { upper: true, size: 84, colour: WHITE, highlight: YELLOW, outline: 7 },
  clean: { upper: false, size: 80, colour: WHITE, highlight: PINK, outline: 6 },
  mint: { upper: true, size: 78, colour: WHITE, highlight: MINT, outline: 9 },
};
const MAX_WORDS = 3, MAX_CHARS = 16;

// Words TikTok, YouTube and Instagram punish (less reach, age limits, removed clips): shown as ***** in the captions,
// hook and post text, and beeped in the sound (render.js). Mild ones (damn, hell, crap) stay. A word Whisper already
// starred out ("f**k") counts too.
const BAD = /^(?:mother)?fuck|^(?:bull|horse)?shit|^bitch|^cunt|^dick(?:s|head|heads)?$|^cocks?$|^cocksuck|^puss(?:y|ies)$|^(?:ass|asses|asshole|assholes|dumbass|jackass)$|^bastards?$|^whores?$|^sluts?$|^nigg|^fag(?:s|got|gots)?$|^retard(?:s|ed)?$|^twats?$|^wank|^pricks?$/;
const isBad = (word) => /\w\*|\*\w/.test(word) || BAD.test(String(word).toLowerCase().replace(/[^a-z]/g, ""));
const censor = (text) => String(text).split(/(\s+)/).map((t) => (isBad(t) ? t.replace(/[\p{L}\p{N}]/gu, "*") : t)).join("");

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
Style: Cap,Fredoka,${look.size},${look.colour},${look.colour},${BLACK},&H64000000,-1,0,0,0,100,100,0,0,1,${look.outline},2,5,60,60,0,1
Style: Hook,Fredoka,72,${BLACK},${BLACK},${WHITE},${WHITE},-1,0,0,0,100,100,0,0,3,18,0,8,90,90,${hookY},1
Style: Credit,Fredoka SemiBold,40,&H22FFFFFF,&H22FFFFFF,${BLACK},${BLACK},0,0,0,0,100,100,0,0,1,4,0,7,60,60,200,1

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
    .filter((w) => /[\p{L}\p{N}]/u.test(w.w)) // a lone "-" or "..." is not a word to show
    .map((w) => ({ ...w, w: censor(w.w) }));
  const groups = chunks(inClip);
  groups.forEach((g, gi) => {
    const next = groups[gi + 1];
    const groupEnd = Math.min(g[g.length - 1].t1 + 0.15, next ? next[0].t0 : clipEnd - clipStart);
    g.forEach((word, k) => {
      const a = word.t0, b = k < g.length - 1 ? g[k + 1].t0 : groupEnd;
      if (b - a < 0.02) return;
      // The spoken word is coloured and a bit bigger.
      const text = g.map((x, j) => (j === k ? `{\\c${L.highlight}\\fscx115\\fscy115}${x.w}{\\r}` : x.w)).join(" ");
      lines.push(`Dialogue: 1,${ts(a)},${ts(b)},Cap,,0,0,0,,{\\an5\\pos(${W / 2},${captionY})}${text}`);
    });
  });
  if (hook) lines.push(`Dialogue: 2,${ts(0)},${ts(Math.min(hookSeconds, clipEnd - clipStart))},Hook,,0,0,0,,{\\fad(120,250)}${censor(clean(hook))}`);
  if (credit) lines.push(`Dialogue: 0,${ts(0)},${ts(clipEnd - clipStart)},Credit,,0,0,0,,${clean(credit)}`);
  return header(L, { captionY, hookY }) + lines.join("\n") + "\n";
}

module.exports = { buildAss, chunks, isBad, censor, LOOKS, ts: (s) => ts(round(s)) };
