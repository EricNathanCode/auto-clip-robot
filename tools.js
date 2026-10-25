// Shared helpers for the Auto Clip Robot: where each outside program lives, running them, and talking to Ollama.
// Every path can be set with an environment variable, so the same code runs on my PC (tests) and in the container.
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const env = (name, fallback) => process.env[name] || fallback;
const TOOLS = {
  ffmpeg: () => env("FFMPEG", "ffmpeg"),
  ffprobe: () => env("FFPROBE", "ffprobe"),
  whisper: () => env("WHISPER", "whisper-cli"),
  whisperModel: () => env("WHISPER_MODEL", "/models/ggml-small.en.bin"),
  ytdlp: () => env("YTDLP", "yt-dlp"),
  python: () => env("PYTHON", "python3"),
  faceModel: () => env("FACE_MODEL", "/models/face_detection_yunet_2023mar.onnx"),
  fonts: () => env("FONTS_DIR", path.join(__dirname, "fonts")),
  ollama: () => env("OLLAMA_URL", "http://ollama:11434"),
  brainModel: () => env("BRAIN_MODEL", "qwen2.5:7b"),
  threads: () => Number(env("THREADS", "4")),
};

// Runs a program and resolves with its stdout. On failure the error carries the last lines of stderr.
// onErr (optional) sees stderr as it arrives, for programs that report on stderr (FFmpeg analysis filters).
function run(cmd, args, { cwd, onErr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, cwd });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
      if (onErr) onErr(String(d));
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out)
      : reject(new Error(`${path.basename(cmd)} failed: ${err.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ")}`))));
  });
}

async function probe(file) {
  const info = JSON.parse(await run(TOOLS.ffprobe(), ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file]));
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  const [num, den] = (v?.r_frame_rate || "0/1").split("/").map(Number);
  return {
    duration: Number(info.format?.duration) || Number(v?.duration) || Number(a?.duration) || 0,
    width: v?.width || 0,
    height: v?.height || 0,
    fps: den ? num / den : 0,
    hasVideo: !!v,
    hasAudio: !!a,
  };
}

// POST JSON with no time limit except ours. (Node's built-in fetch gives up by itself after 5 min without an answer,
// which the Dell's CPU can hit on a long prompt.)
function postJson(url, body, limitMs) {
  return new Promise((resolve, reject) => {
    const req = (url.startsWith("https:") ? https : http).request(url, { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text }));
        res.on("error", reject);
      });
    const timer = setTimeout(() => req.destroy(new Error(`no answer within ${Math.round(limitMs / 1000)} s`)), limitMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

module.exports = { TOOLS, run, probe, postJson, round, clamp };
