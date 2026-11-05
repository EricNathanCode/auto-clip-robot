// Auto Clip Robot: turns one long stream / podcast into its best vertical clips (every moment the AI scores 7+, no
// limit, ranked 01 = best), each in a version per platform.
//   (download.js: audio first) → moments.js (loud spikes) → speech.js (words) → brain.js (AI scores, ranks + hook)
//   → (download.js: the picture) → layout.js (faces, webcam) → render.js (MP4s)
// Compilation mode (D040): one short bit (setup → punchline) per moment instead; the best bits are joined into ONE video
// per platform (compilation-<platform>.mp4), best bit first, quick fades between bits, one AI title on top the whole time.
// CLI: node clip.js <video file or URL> <outDir> [--layout auto|streamer|podcast] [--cam x,y,w,h] [--credit @name]
//      [--who Name] [--title "…"] [--platforms tiktok,shorts,reels,x] [--long 61-70] [--core 30-60] [--count auto|1-30]
//      [--min-score 7] [--must "#ad · text the campaign requires"] [--avoid "topics the campaign bans"] [--candidates 4-30]
//      [--mode clips|compilation] [--captions on|off] [--bit 5-15]
const fs = require("fs");
const path = require("path");
const { probe, retry, round, clamp } = require("./tools");
const { findMoments } = require("./moments");
const { transcribe } = require("./speech");
const { pickClips, lengthen, LENGTHS, pickBits, arrange, nameCompilation, COMPILE } = require("./brain");
const { censor } = require("./captions");
const { findFaces, decide, speakerTrack, webcamBorder } = require("./layout");
const { renderVersion, joinPieces } = require("./render");
const download = require("./download");

// One version per platform (D026): TikTok gets the long cut (over 1 minute), the others the core, each with its own
// caption look and a slightly different start, so cross-posting never looks like the same file.
const VERSIONS = {
  tiktok: { span: "long", look: "pop", nudge: 0 },
  shorts: { span: "core", look: "clean", nudge: 0 },
  reels: { span: "core", look: "mint", nudge: 0.3 },
  x: { span: "core", look: "pop", nudge: -0.3 },
};
const PLATFORMS = Object.keys(VERSIONS);
// Seconds to wait before a download's 2nd and 3rd try, and before the second chance for clips skipped over a failed
// download (DOWNLOAD_WAITS="0,0,0" in tests).
const WAITS = () => (process.env.DOWNLOAD_WAITS || "20,60,120").split(",").map(Number);
const isUrl = (s) => /^(https?|file):\/\//i.test(s);

// Faces (and camera cuts) for a stretch of a video file, or a stand-in for tests (FAKE_FACES = a JSON file shaped like
// findFaces' answer, with times in seconds of the video file).
async function facesFor(file, start, end, every = 0.5, opts) {
  if (process.env.FAKE_FACES) {
    const fake = JSON.parse(fs.readFileSync(process.env.FAKE_FACES, "utf8"));
    return { ...fake, samples: fake.samples.filter((s) => s.t >= start && s.t <= end).map((s) => ({ ...s, t: round(s.t - start) })),
      cuts: (fake.cuts || []).filter((c) => c > start && c < end).map((c) => c - start) };
  }
  return findFaces(file, start, end, every, opts);
}

// The webcam can change size or place between the parts of an edited video (one streamer's grew between two streams), so
// with the whole video on disk each clip gets the webcam border found around its own moment: from the face seen during
// the clip, over the 5 (then 13) minutes around it. A clip where that isn't clear borrows the box of a clip with the
// face in the same spot (same part of the video). Returns a box (or null = keep the job's) per clip.
async function webcamPerClip(file, duration, clips, log) {
  const found = [];
  for (const c of clips) {
    const face = decide(await facesFor(file, c.long.start, c.long.end, 1, { cuts: false }), "streamer").face;
    const mid = (c.long.start + c.long.end) / 2;
    let box = null;
    for (const half of face ? [150, 400] : []) {
      box = await webcamBorder(file, Math.max(0, mid - half), Math.min(duration, mid + half), face);
      if (box) break;
    }
    found.push({ face, box });
  }
  return fillCams(found).map((box, i) => {
    log(`clip ${i + 1}: webcam ${found[i].box ? "border found" : box ? "border borrowed from a clip with the face in the same spot" : "kept from the whole video"}`);
    return box;
  });
}
// A box found on the small copy, at the clip's size: scaled, even (FFmpeg crops), and inside the picture.
const scaleBox = (b, s, { width, height }) => {
  const ev = (v) => 2 * Math.floor(v / 2);
  const x = Math.min(ev(b.x * s), width - 2), y = Math.min(ev(b.y * s), height - 2);
  return { ...b, x, y, w: Math.max(2, Math.min(ev(b.w * s), ev(width - x))), h: Math.max(2, Math.min(ev(b.h * s), ev(height - y))) };
};
const fillCams = (found) => {
  const same = (a, b) => a && b && Math.abs(a.x - b.x) < a.w * 0.5 && Math.abs(a.y - b.y) < a.h * 0.5;
  return found.map((f) => f.box || found.find((o) => o.box && same(f.face, o.face))?.box || null);
};

// How many moments the AI rates when the job doesn't say (D035): one per 2 minutes of video, so it looks all over it,
// 4-30 (each takes the Dell ~4-5 min: 30 ≈ 2.5 h).
const rateCount = (seconds) => clamp(Math.ceil(seconds / 120), 4, 30);

// count: "auto" (no limit: every moment scoring minScore+) or a number (the best N). candidates: how many moments the
// AI rates (default: rateCount, or 1.5x a set count). minScore: the AI score (1-10) a moment needs to become a clip,
// so a dull video gives fewer clips. Clips come out ranked: 01 = best.
// mustInclude: text a campaign requires in every post description (e.g. "#ad" + a line about the show).
// avoid: topics this campaign bans (replaces the default list in brain.js).
// mode: "clips" or "compilation" (then long/core are the whole compilation's lengths, default 61-90 s for TikTok and
// 30-60 s for the others; bit = one bit's length; minScore defaults to 5: a compilation needs several bits). captions:
// word-by-word captions (default: on for clips, off for a compilation, which shows only its title).
async function clipVideo({ source, outDir, workDir, layout: tag = "auto", cam, credit = "", who = "", title = "",
  platforms = ["tiktok", "shorts", "reels"], long, core, count = "auto", candidates, minScore, mustInclude = "", avoid,
  mode = "clips", captions, bit, log = console.log }) {
  if (!["clips", "compilation"].includes(mode)) throw new Error(`unknown mode "${mode}" (use: clips, compilation)`);
  const compilation = mode === "compilation";
  minScore = minScore ?? (compilation ? 5 : 7);
  captions = captions ?? !compilation;
  fs.mkdirSync(outDir, { recursive: true });
  workDir = workDir || path.join(outDir, ".work");
  platforms = platforms.filter((p) => VERSIONS[p]);
  if (!platforms.length) throw new Error(`no known platform (use: ${PLATFORMS.join(", ")})`);

  // Where the sound comes from, how to get the picture for a chosen clip, and (for a site cut in pieces) a small whole
  // copy to find the layout on.
  let analysis, getVideo, getSmall = async () => null, clues = [], game = "";
  if (isUrl(source)) {
    log("step: reading the video's info");
    const meta = await download.info(source, workDir);
    if (meta.live) throw new Error("this stream is still live: it can be clipped after it ends");
    who = who || meta.who; title = title || meta.title; game = meta.game;
    clues = download.heatClues(meta.heatmap);
    log(`video: "${meta.title}" by ${meta.who}, ${round(meta.duration / 60, 1)} min${game ? `, game: ${game}` : ""}${clues.length ? `, ${clues.length} most-replayed peaks` : ""}`);
    log("step: downloading the audio only");
    analysis = await download.audioOnly(source, path.join(workDir, "audio"));
    // A site sometimes drops a request (Twitch did, again and again, on DNS hiccups): try again after a short wait. The
    // first two tries use the saved info (fewer sites to look up), the last one asks the site afresh.
    const again = (e, wait) => log(`step: the download failed (${e.message}): trying again in ${wait} s`);
    const tries = (get) => { let n = 0; return retry(() => get(n++ < 2 ? meta.infoFile : ""), WAITS().slice(0, 2), again); };
    const videoDir = path.join(workDir, "video");
    getVideo = async (c, i) => {
      if (download.isYouTube(source)) { // cutting YouTube online is unreliable: one whole download, cut locally
        log(i === 0 ? "step: downloading the video once (H.264, max 1080p)" : `step: reusing the downloaded video for clip ${i + 1}`);
        return { file: await retry(() => download.full(source, videoDir), WAITS().slice(0, 2), again), offset: 0 };
      }
      // Never the whole stream here: at 1080p60 one of 3 h 51 is 12 GB (and fixing it up needs as much again), which
      // once filled the disk. A clip whose minutes still can't be downloaded is skipped (and gets a second chance).
      const from = Math.max(0, c.long.start - 2);
      log(`step: downloading ${round(c.long.end + 2 - from)} s of video for clip ${i + 1}`);
      try {
        return { file: await tries((info) => download.section(source, from, c.long.end + 2, videoDir, `clip${i + 1}`, info)), offset: from, temp: true };
      } catch (e) {
        throw Object.assign(e, { skip: true });
      }
    };
    if (!download.isYouTube(source)) {
      getSmall = async () => {
        log("step: downloading a small copy of the whole video (max 360p), to find the layout and the webcam's border");
        try {
          const file = await tries((info) => download.small(source, videoDir, info));
          return { file, ...(await probe(file)) };
        } catch (e) {
          log(`step: the small copy failed (${e.message}): the layout is judged on the first clip`);
          return null;
        }
      };
    }
  } else {
    analysis = source;
    getVideo = async () => ({ file: source, offset: 0 });
  }
  const sound = await probe(analysis);
  if (!sound.hasAudio) throw new Error("no sound in this video: nothing to listen to or write down");
  const want = count === "auto" ? Infinity : count;
  const rate = candidates || (count === "auto" || compilation ? rateCount(sound.duration) : clamp(Math.ceil(count * 1.5), 4, 30));
  const sizes = { long: long || COMPILE.long, core: core || COMPILE.core }; // a compilation's lengths
  log(compilation
    ? `source: ${round(sound.duration / 60, 1)} min → the AI looks for a short bit in ${rate} moments; the best (scoring ${minScore}+) make one compilation`
    : `source: ${round(sound.duration / 60, 1)} min → the AI rates ${rate} moments; ${count === "auto" ? "every one" : `the best ${count}`} scoring ${minScore}+ becomes a clip`);

  // The slow part (speech + the AI: hours for a long stream) is saved, so a job that fails later (a download hiccup, a
  // full disk) continues from here when it's run again with the same settings.
  const saved = path.join(workDir, "plans.json");
  const key = JSON.stringify({ source: String(source), tag, who, title, platforms, long, core, count, candidates, minScore, avoid,
    ...(compilation ? { mode, bit } : {}) });
  const before = (() => { try { return JSON.parse(fs.readFileSync(saved, "utf8")); } catch { return null; } })();
  // clips: the clips, or a compilation's bits. comp (compilation mode): { sets: { long, core: bit numbers in playing
  // order }, title, caption }.
  let clips, note, comp;
  if (before?.key === key) {
    ({ clips, note, comp } = before);
    log(`step: reusing the speech and AI picks saved by an earlier run (${clips.length} ${compilation ? "bits" : "clips"})`);
  } else {
    ({ clips, note, comp } = compilation ? await planCompilation() : await planClips());
    if (!clips.length) { // nothing good enough: a finished job with no clips (and why), not an error
      log(`result: no ${compilation ? "compilation" : "clips"} (${note})`);
      const result = { ok: true, ...(compilation ? { mode } : {}), who, title, layout: null, note, clips: [], outputs: [] };
      fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
      fs.rmSync(workDir, { recursive: true, force: true });
      return result;
    }
    fs.writeFileSync(saved, JSON.stringify({ key, clips, note, comp }));
  }
  log(compilation
    ? `compilation "${comp.title}": ${clips.map((c, i) => `bit ${i + 1} score ${c.score} (${round(c.core.end - c.core.start, 1)} s)`).join(" · ")}`
    : `ranked: ${clips.map((c) => `#${c.rank} score ${c.score} "${c.hook}"`).join(" · ")}`);

  // Finds the moments and writes down what's said around them; returns the ones worth showing the brain.
  async function listen() {
    log("step: finding loud moments");
    const moments = await findMoments(analysis, sound.duration, { count: rate, extras: clues });
    log(`step: writing down speech around ${moments.length} moments`);
    for (const [i, m] of moments.entries()) {
      try {
        m.speech = await transcribe(analysis, m.start, m.end, workDir);
      } catch (e) { // one unreadable spot in the sound must not sink the whole job: that moment is skipped
        m.speech = { words: [], sentences: [], music: false };
        log(`speech ${i + 1}/${moments.length} at ${m.peak}s: skipped, could not write it down (${e.message})`);
        continue;
      }
      log(`speech ${i + 1}/${moments.length} at ${m.peak}s: ${m.speech.words.length} words${m.speech.music ? " (music!)" : ""}${m.speech.note ? ` (${m.speech.note})` : ""}`);
    }
    const usable = moments.filter((m) => m.speech.words.length >= 8 && !m.speech.music); // music underneath = copyright claims
    if (!usable.length) throw new Error("no moment with enough speech (and no music underneath) was found");
    return usable;
  }

  // A compilation: a bit per moment, then the bits for TikTok's long version and for the others' shorter one (the
  // shorter one keeps the very best), and one title for them.
  async function planCompilation() {
    const usable = await listen();
    log(`step: the brain looks for a short bit in ${usable.length} moments`);
    const ctx = { who, title, game, kind: tag === "podcast" ? "podcast" : "livestream", ...(bit ? { bit } : {}), ...(avoid ? { avoid } : {}), log };
    const { bits, note } = await pickBits(usable, ctx);
    const sets = { long: arrange(bits, sizes.long, minScore), core: arrange(bits, sizes.core, minScore) };
    const chosen = [...new Set([...sets.long, ...sets.core])];
    if (!chosen.length) return { clips: [], note: [note, `no bit scored ${minScore} or more`].filter(Boolean).join("; ") };
    const named = await nameCompilation(sets.long.length ? sets.long : sets.core, ctx);
    const short = (set, [lo]) => {
      const total = set.reduce((s, b) => s + b.core.end - b.core.start, 0);
      return total < lo ? `only ${round(total)} s of good bits for the ${lo}+ s version` : "";
    };
    const wanted = [...new Set(platforms.map((p) => VERSIONS[p].span))];
    return { clips: chosen, note: [note, ...wanted.map((s) => short(sets[s], sizes[s]))].filter(Boolean).join("; "),
      comp: { sets: { long: sets.long.map((b) => chosen.indexOf(b)), core: sets.core.map((b) => chosen.indexOf(b)) }, ...named } };
  }

  async function planClips() {
    const usable = await listen();
    log(`step: the brain rates ${usable.length} moments${count === "auto" ? "" : ` and keeps up to ${count}`}`);
    const { clips, note } = await pickClips(usable, { who, title, game, kind: tag === "podcast" ? "podcast" : "livestream", count: want,
      minScore, long, core, ...(avoid ? { avoid } : {}), log });
    // TikTok's long cut opens like the others and only runs on: if the written-down window ends too soon for that,
    // write down the next 45 s too (only for the chosen clips).
    const longLen = long || LENGTHS.long;
    for (const [i, c] of clips.entries()) {
      if (!platforms.some((p) => VERSIONS[p].span === "long") || c.long.end - c.long.start >= longLen[0] || c.until >= sound.duration - 1) continue;
      log(`step: writing down what comes next, so clip ${i + 1} runs over ${longLen[0]} s on TikTok`);
      const more = await transcribe(analysis, c.until, Math.min(sound.duration, c.until + 45), workDir)
        .catch((e) => (log(`could not write down what comes next (${e.message}): clip ${i + 1} stays shorter`), { music: true }));
      if (!more.music) clips[i] = lengthen(c, more, { long: longLen }); // music underneath: stay shorter, no claim
    }
    return { clips, note };
  }

  const outputs = [];
  let layout, clipCams = [];
  const small = cam ? null : await getSmall();
  // Makes one clip's versions; false = skipped, its video couldn't be downloaded.
  const makeClip = async (c, i) => {
    let video;
    try {
      video = await getVideo(c, i);
    } catch (e) {
      if (!e.skip) throw e;
      log(`clip ${i + 1}: skipped for now, its video could not be downloaded (${e.message})`);
      return false;
    }
    const src = await probe(video.file);
    if (!src.hasVideo) throw new Error("no picture in this video");
    const faces = !cam && (!layout || layout.kind === "podcast")
      ? await facesFor(video.file, c.long.start - video.offset, c.long.end - video.offset) : null;
    if (!layout) { // decided once, on the first clip
      // With a whole video on disk (YouTube's, or a site's small copy), judge from 90 looks spread across all of it: a
      // webcam stays in its spot the whole stream, while game characters come and go (one standing still during a clip
      // once fooled it). What's found on the small copy is scaled up to the clip's size.
      const look = small ? { file: small.file, duration: small.duration, scale: src.width / small.width }
        : video.offset === 0 && src.duration > 3 * (c.long.end - c.long.start) ? { file: video.file, duration: src.duration, scale: 1 } : null;
      const whole = !cam && tag !== "podcast" && look
        ? await facesFor(look.file, 0, look.duration, look.duration / 90, { cuts: false }) : null;
      layout = cam ? { kind: "streamer", cam, why: "cam box given" } : decide(whole || faces, tag === "auto" ? null : tag);
      if (layout.maybeCam && whole && !process.env.FAKE_FACES) { // a big face in a side spot: a webcam only with a webcam's frame
        const { maybeCam, ...podcast } = layout;
        const border = await webcamBorder(look.file, 0, look.duration, maybeCam.face);
        layout = border ? { kind: "streamer", cam: border, face: maybeCam.face, why: `${maybeCam.why}, webcam border found` }
          : maybeCam.corner ? { kind: "streamer", cam: maybeCam.cam, face: maybeCam.face, frameless: true,
            why: `${maybeCam.why}, in a corner with no frame (a green-screen cutout)` }
          : { ...podcast, why: `${podcast.why}; the big face near the edge has no webcam frame` };
        if (border) clipCams = await webcamPerClip(look.file, look.duration, clips, log);
      } else if (layout.face && whole && !process.env.FAKE_FACES) { // fit the cam to the webcam box's real border
        const border = await webcamBorder(look.file, 0, look.duration, layout.face);
        // No frame found: the cam box is only grown from the face, so the game isn't cut or blurred at it (see layout.js).
        layout = border ? { ...layout, cam: border, why: `${layout.why}, webcam border found` }
          : { ...layout, frameless: true, why: `${layout.why}, no webcam frame found` };
        if (layout.kind === "streamer") clipCams = await webcamPerClip(look.file, look.duration, clips, log);
      } else if (layout.kind === "streamer" && !cam && !whole) {
        layout = { ...layout, frameless: true }; // judged on one clip only: the cam box is a guess
      }
      if (whole && look.scale !== 1) {
        const up = (b) => b && scaleBox(b, look.scale, src);
        layout = { ...layout, cam: up(layout.cam), face: up(layout.face) };
        clipCams = clipCams.map(up);
      }
      log(`layout: ${layout.kind} (${layout.why})${whole && small ? ", judged on the small copy" : ""}`);
    }
    const clipLayout = clipCams[i] ? { ...layout, cam: clipCams[i], frameless: false } : layout; // a frame found around this clip
    // A compilation's bit is made for each version it plays in (a bit's long and core are the same span): with the
    // title on top the whole time and a fade to black at both ends (none at the very start: it opens straight away).
    for (const p of compilation ? platforms.filter((q) => comp.sets[VERSIONS[q].span].includes(i)) : platforms) {
      const v = VERSIONS[p], span = c[v.span];
      const start = round(clamp(span.start + v.nudge, video.offset, span.end - 5)), end = span.end;
      let keys;
      if (layout.kind === "podcast" && faces) { // speaker keyframes, with face and cut times moved to this version's start
        const shift = c.long.start - start;
        const shifted = { ...faces, samples: faces.samples.map((s) => ({ ...s, t: round(s.t + shift) })),
          cuts: (faces.cuts || []).map((t) => t + shift) };
        keys = speakerTrack(shifted, c.speech.sentences.filter((s) => s.t1 > start && s.t0 < end), start);
      }
      const name = compilation ? `bit${i + 1}-${p}` : `${String(i + 1).padStart(2, "0")}-${p}`;
      log(`step: rendering ${compilation ? "bit" : "clip"} ${i + 1} for ${p} (${round(end - start, 1)} s)`);
      const r = await renderVersion({ file: video.file, seek: round(start - video.offset), src, start, end, layout: clipLayout, keys,
        words: c.speech.words, hook: compilation ? comp.title : c.hook, credit, look: v.look, workDir, name, captions,
        outFile: path.join(compilation ? piecesDir : outDir, `${name}.mp4`),
        ...(compilation ? { hookStays: true, fade: { in: comp.sets[v.span][0] !== i, out: true } } : {}) });
      if (!compilation) outputs.push({ clip: i + 1, platform: p, file: `${name}.mp4`, seconds: r.seconds, renderSeconds: r.renderSeconds });
    }
    if (video.temp) fs.rmSync(video.file, { force: true });
    made.add(i);
    return true;
  };
  const skipped = [], made = new Set(), piecesDir = path.join(workDir, "pieces");
  if (compilation) fs.mkdirSync(piecesDir, { recursive: true });
  for (const [i, c] of clips.entries()) if (!(await makeClip(c, i))) skipped.push(i);
  if (skipped.length) { // the second chance: a site's (or DNS) hiccup is often over a few minutes later
    const wait = WAITS()[2];
    log(`step: ${skipped.length} skipped clip${skipped.length > 1 ? "s get" : " gets"} a second chance in ${wait} s`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    for (const i of skipped) if (!(await makeClip(clips[i], i))) log(`clip ${i + 1}: skipped for good`);
    outputs.sort((a, b) => a.clip - b.clip);
  }
  if (compilation) { // one video per platform: its bits one after another (a bit skipped for good is left out)
    for (const p of platforms) {
      const order = comp.sets[VERSIONS[p].span].filter((i) => made.has(i));
      if (!order.length) continue;
      const file = `compilation-${p}.mp4`;
      log(`step: joining ${order.length} bits into ${file}`);
      const r = await joinPieces(order.map((i) => path.join(piecesDir, `bit${i + 1}-${p}.mp4`)), path.join(outDir, file), workDir);
      outputs.push({ platform: p, file, seconds: r.seconds, bits: order.map((i) => i + 1) });
    }
  }
  if (!outputs.length) throw new Error("no clip could be made: none of their videos could be downloaded");
  if (compilation) {
    const result = {
      ok: true, mode, who, title, layout: { kind: layout.kind, why: layout.why }, note,
      compilation: {
        title: censor(comp.title),
        caption: `${censor(comp.caption)}${credit ? ` 🎥 ${credit}` : ""}${mustInclude ? `\n\n${mustInclude}` : ""}`,
        bits: clips.map((c, i) => ({ bit: i + 1, score: c.score, by: c.by, why: c.why, peak: c.peak, start: c.core.start, end: c.core.end }))
          .filter((b) => made.has(b.bit - 1)),
      },
      clips: [], outputs,
    };
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
    fs.rmSync(workDir, { recursive: true, force: true });
    return result;
  }
  const result = {
    ok: true, who, title, layout: { kind: layout.kind, why: layout.why }, note,
    clips: clips.map((c, i) => ({ // best first: clip 1 = rank 1 = files 01-*.mp4
      clip: i + 1, rank: c.rank, score: c.score, by: c.by, hook: censor(c.hook), why: c.why, reasons: c.reasons, peak: c.peak,
      long: { start: c.long.start, end: c.long.end }, core: { start: c.core.start, end: c.core.end },
      caption: `${censor(c.caption)}${credit ? ` 🎥 ${credit}` : ""}${mustInclude ? `\n\n${mustInclude}` : ""}`,
    })).filter((c) => outputs.some((o) => o.clip === c.clip)), // a skipped clip has no files
    outputs,
  };
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  fs.rmSync(workDir, { recursive: true, force: true });
  return result;
}

module.exports = { clipVideo, rateCount, fillCams, scaleBox, VERSIONS, PLATFORMS };

if (require.main === module) {
  const [source, outDir, ...rest] = process.argv.slice(2);
  if (!source || !outDir) {
    console.error("usage: node clip.js <video file or URL> <outDir> [--layout auto|streamer|podcast] [--cam x,y,w,h] [--credit @name] [--platforms tiktok,shorts,reels,x] [--mode clips|compilation]");
    process.exit(2);
  }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, "")] = rest[i + 1];
  const range = (s) => (s ? s.split("-").map(Number) : undefined);
  const camBox = opt.cam ? (([x, y, w, h]) => ({ x, y, w, h }))(opt.cam.split(",").map(Number)) : undefined;
  clipVideo({ source, outDir, layout: opt.layout || "auto", cam: camBox, credit: opt.credit || "", who: opt.who || "",
    title: opt.title || "", platforms: opt.platforms ? opt.platforms.split(",") : undefined, long: range(opt.long),
    core: range(opt.core), count: Number(opt.count) || "auto", candidates: Number(opt.candidates) || undefined,
    minScore: opt["min-score"] ? Number(opt["min-score"]) : undefined, mustInclude: opt.must || "", avoid: opt.avoid,
    mode: opt.mode || "clips", captions: opt.captions ? opt.captions !== "off" : undefined, bit: range(opt.bit) })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
}
