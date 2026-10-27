// Makes one finished 9:16 clip: cut [start, end] from the source, apply the layout, burn in captions + hook + credit,
// even out the loudness for phones (-14 LUFS, like TikTok/YouTube), and save an H.264 MP4 that every platform accepts.
const fs = require("fs");
const path = require("path");
const { TOOLS, run, round } = require("./tools");
const { videoGraph } = require("./layout");
const { buildAss, isBad } = require("./captions");

const MAX_FPS = () => Number(process.env.OUTPUT_FPS) || 60;
const PRESET = () => process.env.RENDER_PRESET || "veryfast"; // the Dell's CPU: fast preset, quality kept by CRF

// libass needs the fonts as files; they're copied next to the subtitle file so FFmpeg gets short relative paths
// (Windows drive letters like C: break FFmpeg filter options).
function prepareFonts(workDir) {
  const dest = path.join(workDir, "fonts");
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(TOOLS.fonts())) {
      if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(TOOLS.fonts(), f), path.join(dest, f));
    }
  }
}

// file + seek: where the clip starts in the video FILE (a downloaded section starts later than the stream).
// start/end: the clip in STREAM time, which is what the word timings use.
async function renderVersion({ file, seek, src, start, end, layout, keys, words, hook, credit, look, outFile, workDir, name }) {
  fs.mkdirSync(workDir, { recursive: true });
  prepareFonts(workDir);
  const { graph, captionY, hookY } = videoGraph(layout, src, { keys });
  fs.writeFileSync(path.join(workDir, `${name}.ass`), buildAss({ words, clipStart: start, clipEnd: end, look, hook, credit, captionY, hookY }));
  const fps = Math.min(MAX_FPS(), Math.round(src.fps) || 30);
  // Bad words (captions.js) are muted and a 1 kHz beep plays over them instead (a little wider than the word, since
  // word timings are a few hundredths of a second off).
  const beeps = words.filter((w) => w.t1 > start && w.t0 < end && isBad(w.w))
    .map((w) => `between(t,${round(Math.max(0, w.t0 - start - 0.06))},${round(Math.min(end - start, w.t1 - start + 0.06))})`).join("+");
  const loud = "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000";
  const audio = !src.hasAudio ? "" : !beeps ? `;[0:a]${loud}[a]`
    : `;[0:a]volume=0:enable='${beeps}',${loud},aformat=channel_layouts=stereo[spoken];` +
      `aevalsrc='0.25*sin(2*PI*1000*t)*(${beeps})':s=48000:d=${round(end - start)},aformat=channel_layouts=stereo[beep];` +
      "[spoken][beep]amix=inputs=2:normalize=0:duration=first[a]";
  const filter = `${graph};[vbase]fps=${fps},ass=${name}.ass:fontsdir=fonts,format=yuv420p[v]${audio}`;
  const args = ["-y", "-v", "error", "-ss", String(seek), "-t", String(round(end - start)), "-i", path.resolve(file),
    "-filter_complex", filter, "-map", "[v]", ...(src.hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] : ["-an"]),
    "-c:v", "libx264", "-preset", PRESET(), "-crf", "21", "-profile:v", "high", "-movflags", "+faststart",
    path.resolve(outFile)];
  const t = Date.now();
  await run(TOOLS.ffmpeg(), args, { cwd: workDir });
  return { file: outFile, seconds: round(end - start, 1), renderSeconds: Math.round((Date.now() - t) / 1000) };
}

module.exports = { renderVersion };
