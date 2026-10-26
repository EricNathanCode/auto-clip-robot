// Auto Clip Robot: turns one long stream / podcast into its best vertical clips (1 per 5 minutes of video, at most 10,
// ranked 01 = best), each in a version per platform.
//   (download.js: audio first) → moments.js (loud spikes) → speech.js (words) → brain.js (AI scores, ranks + hook)
//   → (download.js: the picture) → layout.js (faces, webcam) → render.js (MP4s)
// CLI: node clip.js <video file or URL> <outDir> [--layout auto|streamer|podcast] [--cam x,y,w,h] [--credit @name]
//      [--who Name] [--title "…"] [--platforms tiktok,shorts,reels,x] [--long 61-70] [--core 30-60] [--count auto|1-10]
//      [--min-score 6] [--must "#ad · text the campaign requires"] [--avoid "topics the campaign bans"] [--candidates 4-15]
const fs = require("fs");
const path = require("path");
const { probe, round, clamp } = require("./tools");
const { findMoments } = require("./moments");
const { transcribe } = require("./speech");
const { pickClips, lengthen, LENGTHS } = require("./brain");
const { findFaces, decide, speakerTrack, webcamBorder } = require("./layout");
const { renderVersion } = require("./render");
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

// How many clips a video gets when the job doesn't say (D031): one per 5 minutes, at least 1, at most 10.
const clipCount = (seconds) => clamp(Math.floor(seconds / 300), 1, 10);

// count: "auto" (clipCount) or a number. candidates: how many moments the AI rates (default: 1.5x the clips, 4-15;
// each takes the Dell ~4-5 min). minScore: the AI score (1-10) a moment needs to become a clip, so a dull video
// gives fewer clips. Clips come out ranked: 01 = best.
// mustInclude: text a campaign requires in every post description (e.g. "#ad" + a line about the show).
// avoid: topics this campaign bans (replaces the default list in brain.js).
async function clipVideo({ source, outDir, workDir, layout: tag = "auto", cam, credit = "", who = "", title = "",
  platforms = ["tiktok", "shorts", "reels"], long, core, count = "auto", candidates, minScore = 6, mustInclude = "", avoid,
  log = console.log }) {
  fs.mkdirSync(outDir, { recursive: true });
  workDir = workDir || path.join(outDir, ".work");
  platforms = platforms.filter((p) => VERSIONS[p]);
  if (!platforms.length) throw new Error(`no known platform (use: ${PLATFORMS.join(", ")})`);

  // Where the sound comes from, and how to get the picture for a chosen clip.
  let analysis, getVideo, clues = [], game = "";
  if (isUrl(source)) {
    log("step: reading the video's info");
    const meta = await download.info(source);
    if (meta.live) throw new Error("this stream is still live: it can be clipped after it ends");
    who = who || meta.who; title = title || meta.title; game = meta.game;
    clues = download.heatClues(meta.heatmap);
    log(`video: "${meta.title}" by ${meta.who}, ${round(meta.duration / 60, 1)} min${game ? `, game: ${game}` : ""}${clues.length ? `, ${clues.length} most-replayed peaks` : ""}`);
    log("step: downloading the audio only");
    analysis = await download.audioOnly(source, path.join(workDir, "audio"));
    getVideo = async (c, i) => {
      if (download.isYouTube(source)) { // cutting YouTube online is unreliable: one whole download, cut locally
        log(i === 0 ? "step: downloading the video once (H.264, max 1080p)" : `step: reusing the downloaded video for clip ${i + 1}`);
        return { file: await download.full(source, path.join(workDir, "video")), offset: 0 };
      }
      const from = Math.max(0, c.long.start - 2);
      log(`step: downloading ${round(c.long.end + 2 - from)} s of video for clip ${i + 1}`);
      try {
        return { file: await download.section(source, from, c.long.end + 2, path.join(workDir, "video"), `clip${i + 1}`), offset: from, temp: true };
      } catch (e) {
        // Never throw away the moments, speech and AI work over a download hiccup: get the whole video instead.
        log(`step: downloading just these minutes failed (${e.message.slice(0, 120)}): downloading the whole video once`);
        return { file: await download.full(source, path.join(workDir, "video")), offset: 0 };
      }
    };
  } else {
    analysis = source;
    getVideo = async () => ({ file: source, offset: 0 });
  }
  const sound = await probe(analysis);
  if (!sound.hasAudio) throw new Error("no sound in this video: nothing to listen to or write down");
  const want = count === "auto" ? clipCount(sound.duration) : count;
  const rate = candidates || clamp(Math.ceil(want * 1.5), 4, 15);
  log(`source: ${round(sound.duration / 60, 1)} min → up to ${want} clip${want > 1 ? "s" : ""} (the AI rates ${rate} moments; only score ${minScore}+ is kept)`);

  log("step: finding loud moments");
  const moments = await findMoments(analysis, sound.duration, { count: rate, extras: clues });
  log(`step: writing down speech around ${moments.length} moments`);
  for (const [i, m] of moments.entries()) {
    m.speech = await transcribe(analysis, m.start, m.end, workDir);
    log(`speech ${i + 1}/${moments.length} at ${m.peak}s: ${m.speech.words.length} words${m.speech.music ? " (music!)" : ""}`);
  }
  const usable = moments.filter((m) => m.speech.words.length >= 8 && !m.speech.music); // music underneath = copyright claims
  if (!usable.length) throw new Error("no moment with enough speech (and no music underneath) was found");
  log(`step: the brain rates ${usable.length} moments and keeps up to ${want}`);
  const { clips, note } = await pickClips(usable, { who, title, game, kind: tag === "podcast" ? "podcast" : "livestream", count: want,
    minScore, long, core, ...(avoid ? { avoid } : {}), log });
  if (!clips.length) { // nothing good enough: a finished job with no clips (and why), not an error
    log(`result: no clips (${note})`);
    const result = { ok: true, who, title, layout: null, note, clips: [], outputs: [] };
    fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
    fs.rmSync(workDir, { recursive: true, force: true });
    return result;
  }
  log(`ranked: ${clips.map((c) => `#${c.rank} score ${c.score} "${c.hook}"`).join(" · ")}`);
  // TikTok's long cut opens like the others and only runs on: if the written-down window ends too soon for that,
  // write down the next 45 s too (only for the chosen clips).
  const longLen = long || LENGTHS.long;
  for (const [i, c] of clips.entries()) {
    if (!platforms.some((p) => VERSIONS[p].span === "long") || c.long.end - c.long.start >= longLen[0] || c.until >= sound.duration - 1) continue;
    log(`step: writing down what comes next, so clip ${i + 1} runs over ${longLen[0]} s on TikTok`);
    const more = await transcribe(analysis, c.until, Math.min(sound.duration, c.until + 45), workDir);
    if (!more.music) clips[i] = lengthen(c, more, { long: longLen }); // music underneath: stay shorter, no claim
  }

  const outputs = [];
  let layout;
  for (const [i, c] of clips.entries()) {
    const video = await getVideo(c, i);
    const src = await probe(video.file);
    if (!src.hasVideo) throw new Error("no picture in this video");
    const faces = !cam && (!layout || layout.kind === "podcast")
      ? await facesFor(video.file, c.long.start - video.offset, c.long.end - video.offset) : null;
    if (!layout) { // decided once, on the first clip
      // With the whole video on disk, judge from 90 looks spread across all of it: a webcam stays in its spot the
      // whole stream, while game characters come and go (one standing still during a clip once fooled it).
      const wholeVideo = video.offset === 0 && src.duration > 3 * (c.long.end - c.long.start);
      const whole = !cam && tag !== "podcast" && wholeVideo
        ? await facesFor(video.file, 0, src.duration, src.duration / 90, { cuts: false }) : faces;
      layout = cam ? { kind: "streamer", cam, why: "cam box given" } : decide(whole, tag === "auto" ? null : tag);
      if (layout.face && wholeVideo && !process.env.FAKE_FACES) { // fit the cam to the webcam box's real border
        const border = await webcamBorder(video.file, 0, src.duration, layout.face);
        if (border) layout = { ...layout, cam: border, why: `${layout.why}, webcam border found` };
      }
      log(`layout: ${layout.kind} (${layout.why})`);
    }
    for (const p of platforms) {
      const v = VERSIONS[p], span = c[v.span];
      const start = round(clamp(span.start + v.nudge, video.offset, span.end - 5)), end = span.end;
      let keys;
      if (layout.kind === "podcast" && faces) { // speaker keyframes, with face and cut times moved to this version's start
        const shift = c.long.start - start;
        const shifted = { ...faces, samples: faces.samples.map((s) => ({ ...s, t: round(s.t + shift) })),
          cuts: (faces.cuts || []).map((t) => t + shift) };
        keys = speakerTrack(shifted, c.speech.sentences.filter((s) => s.t1 > start && s.t0 < end), start);
      }
      const name = `${String(i + 1).padStart(2, "0")}-${p}`;
      log(`step: rendering clip ${i + 1} for ${p} (${round(end - start, 1)} s)`);
      const r = await renderVersion({ file: video.file, seek: round(start - video.offset), src, start, end, layout, keys,
        words: c.speech.words, hook: c.hook, credit, look: v.look, outFile: path.join(outDir, `${name}.mp4`), workDir, name });
      outputs.push({ clip: i + 1, platform: p, file: `${name}.mp4`, seconds: r.seconds, renderSeconds: r.renderSeconds });
    }
    if (video.temp) fs.rmSync(video.file, { force: true });
  }
  const result = {
    ok: true, who, title, layout: { kind: layout.kind, why: layout.why }, note,
    clips: clips.map((c, i) => ({ // best first: clip 1 = rank 1 = files 01-*.mp4
      clip: i + 1, rank: c.rank, score: c.score, by: c.by, hook: c.hook, why: c.why, reasons: c.reasons, peak: c.peak,
      long: { start: c.long.start, end: c.long.end }, core: { start: c.core.start, end: c.core.end },
      caption: `${c.caption}${credit ? ` 🎥 ${credit}` : ""}${mustInclude ? `\n\n${mustInclude}` : ""}`,
    })),
    outputs,
  };
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2));
  fs.rmSync(workDir, { recursive: true, force: true });
  return result;
}

module.exports = { clipVideo, clipCount, VERSIONS, PLATFORMS };

if (require.main === module) {
  const [source, outDir, ...rest] = process.argv.slice(2);
  if (!source || !outDir) {
    console.error("usage: node clip.js <video file or URL> <outDir> [--layout auto|streamer|podcast] [--cam x,y,w,h] [--credit @name] [--platforms tiktok,shorts,reels,x]");
    process.exit(2);
  }
  const opt = {};
  for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, "")] = rest[i + 1];
  const range = (s) => (s ? s.split("-").map(Number) : undefined);
  const camBox = opt.cam ? (([x, y, w, h]) => ({ x, y, w, h }))(opt.cam.split(",").map(Number)) : undefined;
  clipVideo({ source, outDir, layout: opt.layout || "auto", cam: camBox, credit: opt.credit || "", who: opt.who || "",
    title: opt.title || "", platforms: opt.platforms ? opt.platforms.split(",") : undefined, long: range(opt.long),
    core: range(opt.core), count: Number(opt.count) || "auto", candidates: Number(opt.candidates) || undefined,
    minScore: opt["min-score"] ? Number(opt["min-score"]) : undefined, mustInclude: opt.must || "", avoid: opt.avoid })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
}
