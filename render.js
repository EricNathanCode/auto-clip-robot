// Makes one finished 9:16 clip: cut [start, end] from the source, apply the layout, burn in captions + hook + credit,
// even out the loudness for phones (-14 LUFS, like TikTok/YouTube), and save an H.264 MP4 that every platform accepts.
// For a compilation, each bit is rendered this way (with fades) and joinPieces() plays them one after another.
const fs = require("fs");
const path = require("path");
const { TOOLS, run, probe, round } = require("./tools");
const { videoGraph } = require("./layout");
const { buildAss, isBad } = require("./captions");

const MAX_FPS = () => Number(process.env.OUTPUT_FPS) || 60;
const PRESET = () => process.env.RENDER_PRESET || "veryfast"; // the Dell's CPU: fast preset, quality kept by CRF
const FADE = 0.3; // seconds of fade to black between a compilation's bits

// libass needs the fonts as files; they're copied next to the subtitle file so FFmpeg gets short relative paths
// (Windows drive letters like C: break FFmpeg filter options).
function prepareFonts(workDir) {
  const dest = path.join(workDir, "fonts");
  if (!fs.existsSync(dest) || !fs.readdirSync(dest).length) { // (an earlier run may have stopped before copying)
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(TOOLS.fonts())) {
      if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(TOOLS.fonts(), f), path.join(dest, f));
    }
  }
}

// file + seek: where the clip starts in the video FILE (a downloaded section starts later than the stream).
// start/end: the clip in STREAM time, which is what the word timings use.
// captions: false = no words on screen (bad words are still beeped). hookStays: the hook is a compilation's title (on
// screen the whole time). fade: { in, out } = fade the picture (not the text on top) and the sound from/to black, for
// a compilation's bits; the sound is then always stereo, so all bits can be joined without re-encoding.
async function renderVersion({ file, seek, src, start, end, layout, keys, words, hook, credit, look, outFile, workDir, name,
  captions = true, hookStays = false, fade = null }) {
  fs.mkdirSync(workDir, { recursive: true });
  prepareFonts(workDir);
  const { graph, captionY, hookY } = videoGraph(layout, src, { keys });
  fs.writeFileSync(path.join(workDir, `${name}.ass`), buildAss({ words: captions ? words : [], clipStart: start, clipEnd: end, look, hook,
    credit, captionY, hookY, hookStays }));
  const fps = Math.min(MAX_FPS(), Math.round(src.fps) || 30);
  const dur = round(end - start);
  // Bad words (captions.js) are muted and a 1 kHz beep plays over them instead (a little wider than the word, since
  // word timings are a few hundredths of a second off).
  const beeps = words.filter((w) => w.t1 > start && w.t0 < end && isBad(w.w))
    .map((w) => `between(t,${round(Math.max(0, w.t0 - start - 0.06))},${round(Math.min(end - start, w.t1 - start + 0.06))})`).join("+");
  const fadeOut = round(Math.max(0, dur - FADE));
  const vfade = fade ? `${fade.in ? `,fade=t=in:st=0:d=${FADE}` : ""}${fade.out ? `,fade=t=out:st=${fadeOut}:d=${FADE}` : ""}` : "";
  const afade = fade ? `,aformat=channel_layouts=stereo${fade.in ? ",afade=t=in:d=0.15" : ""}${fade.out ? `,afade=t=out:st=${fadeOut}:d=${FADE}` : ""}` : "";
  const loud = `loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000${afade}`;
  const audio = !src.hasAudio ? "" : !beeps ? `;[0:a]${loud}[a]`
    : `;[0:a]volume=0:enable='${beeps}',${loud},aformat=channel_layouts=stereo[spoken];` +
      `aevalsrc='0.25*sin(2*PI*1000*t)*(${beeps})':s=48000:d=${dur},aformat=channel_layouts=stereo[beep];` +
      "[spoken][beep]amix=inputs=2:normalize=0:duration=first[a]";
  const filter = `${graph};[vbase]fps=${fps}${vfade},ass=${name}.ass:fontsdir=fonts,format=yuv420p[v]${audio}`;
  const args = ["-y", "-v", "error", "-ss", String(seek), "-t", String(dur), "-i", path.resolve(file),
    "-filter_complex", filter, "-map", "[v]", ...(src.hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-c:v", "libx264", "-preset", PRESET(), "-crf", "21", "-profile:v", "high", "-movflags", "+faststart",
    path.resolve(outFile)];
  const t = Date.now();
  await run(TOOLS.ffmpeg(), args, { cwd: workDir });
  return { file: outFile, seconds: round(end - start, 1), renderSeconds: Math.round((Date.now() - t) / 1000) };
}

// Plays finished pieces (same size, frame rate and sound format: all made by renderVersion from one video) one after
// another, without re-encoding them.
async function joinPieces(files, outFile, workDir) {
  const list = path.join(workDir, `${path.basename(outFile, ".mp4")}.txt`);
  fs.writeFileSync(list, files.map((f) => `file '${path.resolve(f).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  await run(TOOLS.ffmpeg(), ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart",
    path.resolve(outFile)]);
  return { file: outFile, seconds: round((await probe(outFile)).duration, 1) };
}

module.exports = { renderVersion, joinPieces, FADE };
