// The brain: the home AI (Ollama on the Dell, qwen2.5) reads what was said around each candidate moment and decides
// whether it's clip-worthy, where the clip starts and ends, and writes a hook title + post caption.
// The AI picks SENTENCE NUMBERS, never timestamps (small models invent times); the code turns them into times and
// makes the lengths fit. If the AI is off, the robot still picks clips from the loudness alone.
// Two rounds: each moment is scored on its own (strict scale; it writes why first, then the score), then the kept
// clips are compared side by side in one final round, which decides the ranking.
const { TOOLS, postJson, round, clamp } = require("./tools");

const limitMs = () => (Number(process.env.BRAIN_LIMIT_MIN) || 15) * 60 * 1000; // the Dell's CPU is slow; allow 15 min

// Default lengths per version (seconds). A campaign's own rule replaces them.
const LENGTHS = { long: [61, 70], core: [30, 60] };

// The AI writes its answer in this order, so it says why before it gives the score.
const SCHEMA = {
  type: "object",
  properties: {
    why: { type: "string" }, score: { type: "integer", minimum: 1, maximum: 10 },
    start: { type: "integer" }, core_end: { type: "integer" }, end: { type: "integer" },
    hook: { type: "string" }, caption: { type: "string" },
  },
  required: ["why", "score", "start", "core_end", "end", "hook", "caption"],
};

// Topics brands won't pay for (and campaigns ban). A campaign can replace the list.
const AVOID = "politics, religion, drugs, violence, sex or adult topics, hate";

// game: what's being played (from the video's description), so captions name the game instead of "the livestream".
// hooks: the hooks already written for this video's other moments, so this one is different.
function prompt(sentences, { who, title, kind, game, long, core, avoid = AVOID, hooks = [] }) {
  const lines = sentences.map((s, i) => `[${i}] (${round(s.t1 - s.t0, 1)}s) ${s.text}`).join("\n");
  return `You cut viral short clips (TikTok, YouTube Shorts, Reels) from a ${kind || "livestream"}${who ? ` by ${who}` : ""}${game ? ` playing the game ${game}` : ""}${title ? ` titled "${title}"` : ""}.
Here is what was said around one possible moment, as numbered sentences with their length:
${lines}

Decide:
- why: max 15 words: what happens here, and would a stranger watch it to the end?
- score: 1-10, how likely this moment is to go viral on its own. Be strict and use the whole scale; most moments of a video are 4-6:
  10 = people would send it to their friends: a huge laugh, shock or reveal
  9 = a strong hook and a big payoff
  8 = clearly funny, surprising or exciting, and makes sense without the rest of the video
  7 = worth posting: a clear moment with a small payoff
  5-6 = somewhat interesting, but slow or it needs outside context
  1-4 = filler, small talk, nothing happens
  If the moment is mainly about ${avoid}, the score is 1. If they are mainly watching or reacting to a video, a recording or someone else's clip instead of playing or talking themselves (lines like "let's watch this", "look at this video", talking about what someone in a video says or does), the score is 1: that is someone else's content.
- start: the sentence number the clip opens on: the line that makes people stop scrolling, not filler. Every version starts here.
- core_end: where the SHORT version ends (about ${core[0]}-${core[1]} seconds after start), on a complete thought or the reaction.
- end: where the LONG version ends (about ${long[0]}-${long[1]} seconds after start): the same clip, just running on. Never end mid-story.
- hook: a title shown on screen for the first seconds, max 6 words, written like a person talking, not like a video title: it doesn't start with a person's, channel's, game's or show's name, and has no dashes or colons. It must be TRUE to what is said: no exaggeration, no shocking labels or claims about real people, no clickbait that misleads. Make people curious about what really happens. No hashtags, no emojis.${hooks.length ? `
  Hooks already written for other moments of this video (yours must be different and must not start the same way): ${hooks.map((h) => `"${h}"`).join(", ")}` : ""}
- caption: a post caption, max 120 characters, true to the clip, no hashtags, no emojis.
Answer only with JSON.`;
}

// Emojis can't be drawn by the caption renderer and hashtags belong in the post text, not on screen.
const plain = (s) => String(s || "")
  .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}\u{E0020}-\u{E007F}️‍⃣]/gu, "")
  .replace(/#\S+/g, "").replace(/\s+/g, " ").trim();
// Clickbait words make a hook a cliché or a lie ("Shocking Childhood"): taken out even when the AI uses them.
const CLICKBAIT = /\b(?:shocking(?:ly)?|unbelievable|mind[- ]?blowing|jaw[- ]?dropping|you won'?t believe)\b/gi;
const tidyHook = (s) => plain(s).replace(CLICKBAIT, "").replace(/\s+/g, " ").replace(/^[\s,:;-]+|[\s,:;-]+$/g, "");

async function askBrain(text, format = SCHEMA) {
  const r = await postJson(`${TOOLS.ollama()}/api/chat`, {
    model: TOOLS.brainModel(), stream: false, format, think: false,
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

// Grows or shrinks [a, b] (sentence numbers) until its length is inside [lo, hi], with a staying inside [minA, maxA]
// and b at most maxB. Grows forward first (keeps the hook), then backward; shrinks from the end first (keeps the hook).
// Whole sentences only, so when no cut lands inside the range it stays a little LONG rather than short (TikTok pays
// only over 1 min).
function fitSpan(sentences, a, b, [lo, hi], minA = 0, maxB = sentences.length - 1, maxA = maxB) {
  const len = (x, y) => lengthOf(sentences, x, y);
  a = clamp(a, minA, Math.min(maxA, maxB)); b = clamp(b, a, maxB);
  while (len(a, b) < lo && (b < maxB || a > minA)) {
    if (b < maxB) b++; else a--;
  }
  while (len(a, b) > hi && b > a) {
    if (len(a, b - 1) >= lo) b--;
    else if (a < maxA && len(a + 1, b) >= lo) a++;
    else break;
  }
  return [a, b];
}

// The long cut from the core's first sentence: same opening, it only runs on longer.
const longFrom = (sentences, a, b, lengths) => fitSpan(sentences, a, b, lengths.long, a, sentences.length - 1, a);

// The first sentence after `t` seconds (or the last one).
const sentenceAt = (sentences, t) => Math.max(0, sentences.findIndex((s) => s.t1 >= t));

// Turns one candidate (with its transcript) into a clip plan: { score, long: {start,end}, core: {start,end}, hook, caption, why }.
async function planMoment(cand, ctx) {
  const sentences = cand.speech.sentences;
  const lengths = { long: ctx.long || LENGTHS.long, core: ctx.core || LENGTHS.core };
  if (!sentences.length) return null; // nothing said: no captions, no story (skip)
  let a = sentenceAt(sentences, cand.peak - 20), cb = sentenceAt(sentences, cand.peak + 10), b = cb;
  let hook = "", caption = "", why = "", score = Math.round(clamp(cand.score, 1, 10)), by = "loudness";
  if (!ctx.brainProblem) {
    try {
      const ans = await askBrain(prompt(sentences, { ...ctx, ...lengths }));
      const last = sentences.length - 1;
      a = clamp(ans.start | 0, 0, last); cb = clamp(ans.core_end | 0, a, last); b = clamp(ans.end | 0, cb, last);
      hook = tidyHook(ans.hook); caption = plain(ans.caption); why = String(ans.why || "").trim();
      score = clamp(ans.score | 0, 1, 10);
      by = "brain";
    } catch (e) {
      ctx.log?.(`brain failed on the moment at ${cand.peak}s: ${e.message}`);
    }
  }
  // Every version opens on the same line (the best intro); TikTok's long cut only runs on longer. When the
  // written-down window ends too soon for that, clip.js writes down what comes next and calls lengthen().
  [a, cb] = fitSpan(sentences, a, cb, lengths.core);
  [, b] = longFrom(sentences, a, Math.max(b, cb), lengths);
  if (!hook) hook = sentences[a].words.slice(0, 6).map((w) => w.w).join(" ").replace(/[.,!?;:]+$/, "");
  return {
    peak: cand.peak, score, by, reasons: cand.reasons, loud: cand.score,
    long: { ...spanOf(sentences, a, b), sentences: [a, b] },
    core: { ...spanOf(sentences, a, cb), sentences: [a, cb] },
    hook: hook.split(/\s+/).slice(0, 6).join(" "),
    caption: caption.slice(0, 120) || sentences[a].text.slice(0, 120),
    why,
    speech: cand.speech, // words + sentences, for captions and for following the speaker
    until: cand.end, // where the written-down window ends
  };
}

// Adds speech written down after the window (more = transcribe's answer) and refits the long cut from the same start.
function lengthen(plan, more, lengths) {
  const old = plan.speech, after = old.words.length ? old.words[old.words.length - 1].t1 : 0;
  const words = [...old.words, ...more.words.filter((w) => w.t0 >= after)];
  const sentences = [...old.sentences, ...more.sentences.filter((s) => s.t0 >= after)];
  const a = plan.long.sentences[0];
  const [, b] = longFrom(sentences, a, plan.long.sentences[1], lengths);
  return { ...plan, speech: { ...old, words, sentences }, long: { ...spanOf(sentences, a, b), sentences: [a, b] },
    until: more.words.length ? more.words[more.words.length - 1].t1 : plan.until };
}

// The ranking: best score first (a tie goes to the louder moment, not the longer one: once a long, quiet stream ending
// won a tie), at most `count`, none overlapping, and none the AI scored below minScore (when the AI is off, scores
// come from loudness alone and aren't held to it). Returned best first, each with its rank (1 = best).
function rank(plans, { count = 3, minScore = 0 } = {}) {
  const chosen = [];
  for (const p of [...plans].sort((x, y) => y.score - x.score || y.loud - x.loud)) {
    if (chosen.length >= count) break;
    if (p.by === "brain" && p.score < minScore) continue;
    const overlaps = chosen.some((c) => Math.min(c.long.end, p.long.end) - Math.max(c.long.start, p.long.start) > 10);
    if (!overlaps) chosen.push(p);
  }
  return chosen.map((p, i) => ({ ...p, rank: i + 1 }));
}

// The final round: scored one at a time, nearly every moment got an 8, so the ranking meant nothing. Here the AI sees
// the kept clips side by side and gives each a final score (minScore-10) against the others; the order follows it
// (a tie keeps the first round's order). If it fails, the first round's scores stay.
const COMPARE = {
  type: "object",
  properties: { scores: { type: "array", items: { type: "object",
    properties: { clip: { type: "integer" }, score: { type: "integer", minimum: 1, maximum: 10 } }, required: ["clip", "score"] } } },
  required: ["scores"],
};

function comparePrompt(clips, { who, kind, lo }) {
  const list = clips.map((c, i) => {
    const said = c.speech.sentences.slice(c.core.sentences[0], c.core.sentences[1] + 1).map((s) => s.text).join(" ");
    return `[${i}] hook "${c.hook}": ${said.length > 400 ? `${said.slice(0, 400)}…` : said}`;
  }).join("\n");
  return `Here are ${clips.length} short clips cut from one ${kind || "livestream"}${who ? ` by ${who}` : ""}, each with its hook and what is said:
${list}

Compare them with each other and give every clip a final score from ${lo} to 10: the one most likely to go viral gets the highest score. Spread the scores out; give two clips the same score only if they are truly equally good.
Answer only with JSON: {"scores": [{"clip": <number>, "score": <${lo}-10>}, ...]}`;
}

async function compare(clips, ctx) {
  if (clips.length < 2 || ctx.brainProblem) return clips;
  const lo = clamp(ctx.minScore || 1, 1, 10);
  try {
    const ans = await askBrain(comparePrompt(clips, { ...ctx, lo }), COMPARE);
    const final = new Map((ans.scores || []).map((s) => [s.clip | 0, clamp(s.score | 0, lo, 10)]));
    const scored = clips.map((c, i) => ({ ...c, alone: c.score, score: final.get(i) ?? c.score }))
      .sort((x, y) => y.score - x.score || x.rank - y.rank);
    ctx.log?.(`final round, side by side: ${scored.map((c) => `"${c.hook}" ${c.alone} → ${c.score}`).join(" · ")}`);
    return scored.map((c, i) => ({ ...c, rank: i + 1 }));
  } catch (e) {
    ctx.log?.(`the final round failed (${e.message}): the first scores stay`);
    return clips;
  }
}

// Plans every candidate, then ranks them. ctx.count = how many clips at most, ctx.minScore = the AI score a clip needs.
async function pickClips(candidates, ctx = {}) {
  ctx.brainProblem = ctx.brainProblem ?? await brainProblem();
  const plans = [], hooks = [];
  for (const c of candidates) {
    const p = await planMoment(c, { ...ctx, hooks });
    if (!p) continue;
    plans.push(p);
    if (p.by === "brain") hooks.push(p.hook);
    ctx.log?.(`moment ${c.peak}s: score ${p.score} (${p.by}) "${p.hook}"`);
  }
  const clips = await compare(rank(plans, { count: ctx.count || 3, minScore: ctx.minScore || 0 }), ctx);
  const tooLow = !clips.length && plans.length
    ? `no moment scored ${ctx.minScore} or more (best: ${Math.max(...plans.map((p) => p.score))})` : "";
  return { clips, note: [ctx.brainProblem, tooLow].filter(Boolean).join("; ") };
}

module.exports = { pickClips, planMoment, rank, compare, lengthen, fitSpan, brainProblem, prompt, plain, tidyHook, LENGTHS, SCHEMA, AVOID };
