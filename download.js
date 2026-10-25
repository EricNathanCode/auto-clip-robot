// Getting a stream from YouTube / Twitch with yt-dlp:
//   1. info: title, channel, length, and YouTube's "most replayed" graph when there is one (a bonus clue)
//   2. the AUDIO only (~60 MB per hour): enough to find the moments and write down the speech
//   3. the picture: only the few minutes around each clip where that works (Twitch), or the whole video once
//      (YouTube: cutting it online through FFmpeg came back without picture and crawled at a few KB/s, while
//      yt-dlp's own downloader is fast and reliable). The clips are then cut locally, exactly.
// Video is always H.264 (avc1, max 1080p) with the ORIGINAL audio track (some videos also carry dubbed languages):
// every tool here reads H.264, while AV1 trips up exact cutting and the face finder.
// Campaign footage from Google Drive doesn't come through here: n8n uploads that file straight to the job.
const fs = require("fs");
const path = require("path");
const { TOOLS, run, probe, round } = require("./tools");

// Extra flags from the environment: YTDLP_ARGS (e.g. "--js-runtimes node --force-ipv4" in the container, or
// "--enable-file-urls" in tests).
const extra = () => (process.env.YTDLP_ARGS || "").split(/\s+/).filter(Boolean);
const VIDEO = "bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/bv*[vcodec^=avc1][height<=1080]+ba/bv*[height<=1080]+ba/b[height<=1080]/b";
const isYouTube = (url) => /^https?:\/\/([a-z0-9-]+\.)*(youtube\.com|youtu\.be)\//i.test(url);

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

// A download that came back as sound only is useless for a vertical clip: say so (and delete it).
async function withPicture(file, what) {
  const p = await probe(file).catch(() => ({ hasVideo: false }));
  if (!p.hasVideo) {
    fs.rmSync(file, { force: true });
    throw new Error(`${what} came back without picture (sound only)`);
  }
  return file;
}

// Downloads [start, end] of the video (+ sound). Cut points get keyframes, so the file starts exactly at `start`.
async function section(url, start, end, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${name}.mp4`);
  await run(TOOLS.ytdlp(), [...extra(), "--no-playlist", "--no-warnings", "-f", VIDEO, "--merge-output-format", "mp4",
    "--download-sections", `*${round(start)}-${round(end)}`, "--force-keyframes-at-cuts", "-o", out, url]);
  if (!fs.existsSync(out)) throw new Error(`the download of ${round(start)}-${round(end)} s produced no file`);
  return withPicture(out, `the ${round(start)}-${round(end)} s part`);
}

// The whole video (max 1080p, H.264), downloaded once per job and reused for every clip.
async function full(url, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "full.mp4");
  if (!fs.existsSync(out)) {
    await run(TOOLS.ytdlp(), [...extra(), "--no-playlist", "--no-warnings", "-f", VIDEO, "--merge-output-format", "mp4", "-o", out, url]);
  }
  return withPicture(out, "the video");
}

module.exports = { info, heatClues, audioOnly, section, full, isYouTube, VIDEO };
