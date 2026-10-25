// The brain: the home AI (Ollama on the Dell, qwen2.5) reads what was said around each candidate moment and decides
// whether it's clip-worthy, where the clip starts and ends, and writes a hook title + post caption.
// The AI picks SENTENCE NUMBERS, never timestamps (small models invent times); the code turns them into times and
// makes the lengths fit. If the AI is off, the robot still picks clips from the loudness alone.
const { TOOLS, postJson, round, clamp } = require("./tools");

const limitMs = () => (Number(process.env.BRAIN_LIMIT_MIN) || 15) * 60 * 1000; // the Dell's CPU is slow; allow 15 min

// Default lengths per version (seconds). A campaign's own rule replaces them.
const LENGTHS = { long: [61, 70], core: [30, 60] };

const SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 1, maximum: 10 },
    start: { type: "integer" }, end: { type: "integer" },
    core_start: { type: "integer" }, core_end: { type: "integer" },
    hook: { type: "string" }, caption: { type: "string" }, why: { type: "string" },
  },
  required: ["score", "start", "end", "core_start", "core_end", "hook", "caption", "why"],
};

function prompt(sentences, { who, title, kind, long, core }) {
  const lines = sentences.map((s, i) => `[${i}] (${round(s.t1 - s.t0, 1)}s) ${s.text}`).join("\n");
  return `You cut viral short clips (TikTok, YouTube Shorts, Reels) from a ${kind || "livestream"}${who ? ` by ${who}` : ""}${title ? ` titled "${title}"` : ""}.
Here is what was said around one possible moment, as numbered sentences with their length:
${lines}

Decide:
- score: 1-10, how likely this moment is to go viral on its own (funny, shocking, emotional, hype, a great story or hot take = high; boring, filler, needs outside context = low).
- start/end: the sentence numbers of the LONG clip (about ${long[0]}-${long[1]} seconds in total). Start on the line that makes people stop scrolling, not on filler. End on a complete thought or the reaction, never mid-story.
- core_start/core_end: a SHORTER clip inside it (about ${core[0]}-${core[1]} seconds) with the same hook and the best part.
- hook: a title shown on screen for the first seconds, max 6 words, curiosity, no hashtags, no emojis.
- caption: a post caption, max 120 characters, no hashtags.
- why: max 15 words.
Answer only with JSON.`;
}

async function askBrain(text) {
  const r = await postJson(`${TOOLS.ollama()}/api/chat`, {
    model: TOOLS.brainModel(), stream: false, format: SCHEMA, think: false,
    options: { temperature: 0.2, num_ctx: 8192 },
    messages: [{ role: "user", content: text }],
  }, limitMs());
  if (r.status !== 200) throw new Error(`brain AI said ${r.status}: ${r.text.slice(0, 200)}`);
  return JSON.parse(JSON.parse(r.text).message.content);
}

// Why the brain can't help right now ("" = it can).
async function brainProblem() {
  try {
    const r = await fetch(`${TOOLS.ollama()}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const models = (await r.json()).models || [];
    return models.some((m) => m.name === TOOLS.brainModel()) ? "" : `brain AI is missing the model ${TOOLS.brainModel()} (run: ollama pull ${TOOLS.brainModel()})`;
  } catch {
    return `brain AI not reachable at ${TOOLS.ollama()}: clips picked from loudness only`;
  }
}

const spanOf = (sentences, a, b) => ({ start: sentences[a].t0, end: round(sentences[b].t1 + 0.25) });
const lengthOf = (sentences, a, b) => sentences[b].t1 + 0.25 - sentences[a].t0;

// Grows or shrinks [a, b] (sentence numbers) until its length is inside [lo, hi], staying inside [minA, maxB].
// Grows forward first (keeps the hook), then backward; shrinks from the end first (keeps the hook). Whole sentences
// only, so when no cut lands inside the range it stays a little LONG rather than short (TikTok pays only over 1 min).
function fitSpan(sentences, a, b, [lo, hi], minA = 0, maxB = sentences.length - 1) {
  const len = (x, y) => lengthOf(sentences, x, y);
  a = clamp(a, minA, maxB); b = clamp(b, a, maxB);
  while (len(a, b) < lo && (b < maxB || a > minA)) {
    if (b < maxB) b++; else a--;
  }
  while (len(a, b) > hi && b > a) {
    if (len(a, b - 1) >= lo) b--;
    else if (len(a + 1, b) >= lo) a++;
    else break;
  }
  return [a, b];
}

// The first sentence after `t` seconds (or the last one).
const sentenceAt = (sentences, t) => Math.max(0, sentences.findIndex((s) => s.t1 >= t));

// Turns one candidate (with its transcript) into a clip plan: { score, long: {start,end}, core: {start,end}, hook, caption, why }.
async function planMoment(cand, ctx) {
  const sentences = cand.speech.sentences;
  const lengths = { long: ctx.long || LENGTHS.long, core: ctx.core || LENGTHS.core };
  if (!sentences.length) return null; // nothing said: no captions, no story (skip)
  let a = sentenceAt(sentences, cand.peak - 20), b = sentenceAt(sentences, cand.peak + 10);
  let ca = a, cb = b, hook = "", caption = "", why = "", score = Math.round(clamp(cand.score, 1, 10)), by = "loudness";
  if (!ctx.brainProblem) {
    try {
      const ans = await askBrain(prompt(sentences, { ...ctx, ...lengths }));
      const last = sentences.length - 1;
      a = clamp(ans.start | 0, 0, last); b = clamp(ans.end | 0, a, last);
      ca = clamp(ans.core_start | 0, a, b); cb = clamp(ans.core_end | 0, ca, b);
      hook = String(ans.hook || "").trim(); caption = String(ans.caption || "").trim(); why = String(ans.why || "").trim();
      score = clamp(ans.score | 0, 1, 10);
      by = "brain";
    } catch (e) {
      ctx.log?.(`brain failed on the moment at ${cand.peak}s: ${e.message}`);
    }
  }
  [a, b] = fitSpan(sentences, a, b, lengths.long);
  [ca, cb] = fitSpan(sentences, Math.max(ca, a), Math.min(cb, b), lengths.core, a, b);
  if (!hook) hook = sentences[a].words.slice(0, 6).map((w) => w.w).join(" ").replace(/[.,!?;:]+$/, "");
  return {
    peak: cand.peak, score, by, reasons: cand.reasons,
    long: { ...spanOf(sentences, a, b), sentences: [a, b] },
    core: { ...spanOf(sentences, ca, cb), sentences: [ca, cb] },
    hook: hook.split(/\s+/).slice(0, 6).join(" "),
    caption: caption.slice(0, 120) || sentences[a].text.slice(0, 120),
    why,
    speech: cand.speech, // words + sentences, for captions and for following the speaker
  };
}

// Plans every candidate, then keeps the best `count` that don't overlap much.
async function pickClips(candidates, ctx = {}) {
  ctx.brainProblem = ctx.brainProblem ?? await brainProblem();
  const plans = [];
  for (const c of candidates) {
    const p = await planMoment(c, ctx);
    if (p) plans.push(p);
    if (p) ctx.log?.(`moment ${c.peak}s: score ${p.score} (${p.by}) "${p.hook}"`);
  }
  const chosen = [];
  for (const p of plans.sort((x, y) => y.score - x.score || y.long.end - y.long.start - (x.long.end - x.long.start))) {
    if (chosen.length >= (ctx.count || 3)) break;
    const overlaps = chosen.some((c) => Math.min(c.long.end, p.long.end) - Math.max(c.long.start, p.long.start) > 10);
    if (!overlaps) chosen.push(p);
  }
  return { clips: chosen.sort((x, y) => x.long.start - y.long.start), note: ctx.brainProblem || "" };
}

module.exports = { pickClips, planMoment, fitSpan, brainProblem, prompt, LENGTHS, SCHEMA };
