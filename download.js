// Getting a stream from YouTube / Twitch with yt-dlp, without downloading hours of video:
//   1. info: title, channel, length, and YouTube's "most replayed" graph when there is one (a bonus clue)
//   2. the AUDIO only (~60 MB per hour): enough to find the moments and write down the speech
//   3. only the few minutes around each chosen clip, in good quality (max 1080p)
// Campaign footage from Google Drive doesn't come through here: n8n uploads that file straight to the job.
const fs = require("fs");
const path = require("path");
const { TOOLS, run, round } = require("./tools");

// Extra flags from the environment: YTDLP_ARGS (e.g. "--js-runtimes node" in the container, or
// "--enable-file-urls" in tests).
const extra = () => (process.env.YTDLP_ARGS || "").split(/\s+/).filter(Boolean);

async function info(url) {
  const j = JSON.parse(await run(TOOLS.ytdlp(), [...extra(), "--no-playlist", "--no-warnings", "-J", url]));
  const heat = (j.heatmap || []).map((h) => ({ t: (h.start_time + h.end_time) / 2, value: h.value }));
  return {
    title: j.title || "", who: j.uploader || j.channel || "", duration: Number(j.duration) || 0,
    live: !!j.is_live, url: j.webpage_url || url, heatmap: heat,
  };
}

// "Most replayed" peaks → extra clues for moments.js: the top 10% of the graph, weighted by how high they are.
function heatClues(heatmap) {
  if (!heatmap.length) return [];
  const sorted = [...heatmap].sort((a, b) => b.value - a.value);
  const cut = sorted[Math.floor(sorted.length * 0.1)].value;
  return heatmap.filter((h) => h.value >= cut && h.value > 0).map((h) => ({ t: round(h.t), weight: round(1 + 2 * h.value), why: "most replayed" }));
}

async function audioOnly(url, dir) {
  fs.mkdirSync(dir, { recursive: true });
  await run(TOOLS.ytdlp(), [...extra(), "--no-playlist", "--no-warnings", "-f", "bestaudio/best", "-o", path.join(dir, "audio.%(ext)s"), url]);
  const file = fs.readdirSync(dir).find((f) => f.startsWith("audio."));
  if (!file) throw new Error("the audio download produced no file");
  return path.join(dir, file);
}

// Downloads [start, end] of the video (+ sound). Cut points get keyframes, so the file starts exactly at `start`.
async function section(url, start, end, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${name}.mp4`);
  await run(TOOLS.ytdlp(), [...extra(), "--no-playlist", "--no-warnings",
    "-f", "bv*[height<=1080]+ba/b[height<=1080]/b", "--merge-output-format", "mp4",
    "--download-sections", `*${round(start)}-${round(end)}`, "--force-keyframes-at-cuts", "-o", out, url]);
  if (!fs.existsSync(out)) throw new Error(`the download of ${round(start)}-${round(end)} s produced no file`);
  return out;
}

// The whole video (max 1080p), for sources that can't be downloaded in parts (plain file links).
async function full(url, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "full.mp4");
  if (!fs.existsSync(out)) {
    await run(TOOLS.ytdlp(), [...extra(), "--no-playlist", "--no-warnings", "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
      "--merge-output-format", "mp4", "-o", out, url]);
  }
  return out;
}

module.exports = { info, heatClues, audioOnly, section, full };
