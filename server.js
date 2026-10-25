// Auto Clip Robot API (no open port: only n8n on the Docker network "ai" can reach it at http://autoclip:8091).
//   GET    /health                    → { ok, ffmpeg, ytdlp, whisper, jobsWaiting, busy }
//   POST   /jobs/<job>                → reserves a fresh job ("receiving") before its source is sent
//   PUT    /jobs/<job>/files/<name>   → raw body: a source video (campaign footage from Drive), saved to <job>/in/<name>
//   POST   /jobs/<job>/start          → JSON body { url?, layout, cam?, credit, who, title, platforms, long, core, count,
//                                       mustInclude?, avoid? }:
//                                       starts clipping in the background (an uploaded file, or the url) and answers 202
//   GET    /jobs/<job>/status         → { status: receiving | queued | working | done | failed, step, seconds, result | error }
//   GET    /jobs/<job>/clips/<file>   → one finished MP4 (names are listed in result.outputs)
//   DELETE /jobs/<job>                → removes the job's files
// Clipping a long stream takes 30-120 min on the Dell, so n8n starts a job and checks /status every few minutes.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { TOOLS, run } = require("./tools");
const { clipVideo, PLATFORMS } = require("./clip");

const PORT = Number(process.env.PORT || 8091);
const WORK = process.env.WORK_DIR || "/work";

// Names come from Google Drive; keep them readable but unable to escape the job folder.
const clean = (s) => {
  let name;
  try { name = decodeURIComponent(s); } catch { name = s; }
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 150);
  if (!name) throw Object.assign(new Error("bad name"), { status: 400 });
  return name;
};

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 64 * 1024) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > limit) throw Object.assign(new Error("request body too big"), { status: 413 });
  }
  try { return text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error("body is not valid JSON"), { status: 400 }); }
}

// Each job's status lives in <job>/status.json, so it can still be read after a restart.
const statusFile = (jobDir) => path.join(jobDir, "status.json");
function saveStatus(jobDir, st) {
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(statusFile(jobDir), JSON.stringify(st, null, 1));
  return st;
}
function readStatus(jobDir) {
  try { return JSON.parse(fs.readFileSync(statusFile(jobDir), "utf8")); } catch { return null; }
}
const busy = (st) => st && (st.status === "queued" || st.status === "working");
const inFiles = (jobDir) => { try { return fs.readdirSync(path.join(jobDir, "in")); } catch { return []; } };

// A job that was receiving, queued or working when the clipper stopped will never finish: say so, so n8n stops waiting.
fs.mkdirSync(WORK, { recursive: true });
for (const name of fs.readdirSync(WORK)) {
  const jobDir = path.join(WORK, name), st = readStatus(jobDir);
  if (busy(st) || st?.status === "receiving") saveStatus(jobDir, { ...st, status: "failed", finishedAt: new Date().toISOString(),
    error: "the clipper restarted before this job finished: start it again" });
}

let queue = Promise.resolve(); // one job at a time (the Dell has 4 cores)
let waiting = 0, working = false;

// Checks the start request; returns { error } or { options } for clipVideo.
function checkOptions(body, jobDir) {
  const o = {};
  const files = inFiles(jobDir);
  if (body.url) {
    if (!/^https?:\/\//i.test(body.url) && !(process.env.ALLOW_FILE_URLS && /^file:\/\//i.test(body.url))) return { error: "url must start with http(s)://" };
    o.source = body.url;
  } else if (files.length) {
    o.source = path.join(jobDir, "in", files[0]);
  } else {
    return { error: "no video was uploaded and no url was given" };
  }
  o.layout = (body.layout || "auto").toLowerCase();
  if (!["auto", "streamer", "podcast"].includes(o.layout)) return { error: `unknown layout "${body.layout}"` };
  if (body.cam) {
    const c = body.cam;
    if (![c.x, c.y, c.w, c.h].every((n) => Number.isFinite(n) && n >= 0) || c.w < 16 || c.h < 16) return { error: "cam must be { x, y, w, h } in pixels" };
    o.cam = { x: c.x, y: c.y, w: c.w, h: c.h };
  }
  o.platforms = body.platforms || ["tiktok", "shorts", "reels"];
  if (!Array.isArray(o.platforms) || !o.platforms.length || o.platforms.some((p) => !PLATFORMS.includes(p))) {
    return { error: `platforms must be a list of: ${PLATFORMS.join(", ")}` };
  }
  for (const k of ["long", "core"]) {
    if (body[k] === undefined) continue;
    const [lo, hi] = body[k];
    if (!(lo >= 5 && hi <= 180 && lo < hi)) return { error: `${k} must be [min, max] seconds between 5 and 180` };
    o[k] = [lo, hi];
  }
  o.count = body.count === undefined ? 3 : Number(body.count);
  if (!(o.count >= 1 && o.count <= 5)) return { error: "count must be 1-5" };
  o.candidates = body.candidates === undefined ? 10 : Number(body.candidates); // moments the AI rates (fewer = faster)
  if (!(o.candidates >= o.count && o.candidates <= 15)) return { error: "candidates must be between count and 15" };
  o.mustInclude = String(body.mustInclude || "").slice(0, 500); // campaign's required post text (#ad, show name…)
  if (body.avoid) o.avoid = String(body.avoid).slice(0, 300); // campaign's banned topics
  o.credit = String(body.credit || "").slice(0, 40);
  o.who = String(body.who || "").slice(0, 80);
  o.title = String(body.title || "").slice(0, 200);
  return { options: o };
}

function startJob(jobDir, options) {
  const name = path.basename(jobDir);
  const update = (change) => saveStatus(jobDir, { ...readStatus(jobDir), ...change });
  saveStatus(jobDir, { job: name, status: "queued", source: options.url ? options.source : path.basename(options.source),
    platforms: options.platforms, queuedAt: new Date().toISOString() });
  const position = waiting++;
  const job = async () => {
    working = true;
    update({ status: "working", startedAt: new Date().toISOString(), step: "starting" });
    try {
      const result = await clipVideo({ ...options, outDir: path.join(jobDir, "out"), workDir: path.join(jobDir, "work"),
        log: (m) => { console.log(`[${name}] ${m}`); update({ step: m.slice(0, 200) }); } });
      update({ status: "done", finishedAt: new Date().toISOString(), step: "finished", result });
    } catch (e) {
      console.error(`[${name}] failed: ${e.message}`);
      update({ status: "failed", finishedAt: new Date().toISOString(), error: e.message });
    } finally {
      waiting--;
      working = false;
      fs.rmSync(path.join(jobDir, "in"), { recursive: true, force: true }); // the source is big; the clips are what's kept
    }
  };
  queue = queue.then(job, job);
  return position;
}

async function handle(req, res) {
  const url = new URL(req.url, "http://autoclip");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") {
    const version = async (cmd, args) => { try { return (await run(cmd, args)).split("\n")[0].trim(); } catch { return "missing"; } };
    return send(res, 200, { ok: true, ffmpeg: await version(TOOLS.ffmpeg(), ["-hide_banner", "-version"]),
      ytdlp: await version(TOOLS.ytdlp(), ["--version"]), whisper: fs.existsSync(TOOLS.whisperModel()) ? "model ready" : "model missing",
      jobsWaiting: waiting, busy: working });
  }
  if (parts[0] !== "jobs" || !parts[1]) return send(res, 404, { ok: false, error: "not found" });
  const jobDir = path.join(WORK, clean(parts[1]));
  const st = readStatus(jobDir);

  if (req.method === "POST" && parts.length === 2) { // reserve a fresh job (any old files of the same name are cleared)
    if (busy(st)) return send(res, 409, { ok: false, error: `job is ${st.status}: wait until it is done` });
    fs.rmSync(jobDir, { recursive: true, force: true });
    saveStatus(jobDir, { job: path.basename(jobDir), status: "receiving", createdAt: new Date().toISOString() });
    return send(res, 201, { ok: true, job: path.basename(jobDir), status: "receiving" });
  }
  if (req.method === "PUT" && parts[2] === "files" && parts[3]) {
    if (busy(st)) return send(res, 409, { ok: false, error: `job is ${st.status}: wait until it is done` });
    const inDir = path.join(jobDir, "in");
    fs.mkdirSync(inDir, { recursive: true });
    const file = path.join(inDir, clean(parts[3]));
    await pipeline(req, fs.createWriteStream(file));
    return send(res, 200, { ok: true, file: path.basename(file), bytes: fs.statSync(file).size });
  }
  if (req.method === "POST" && parts[2] === "start") {
    if (busy(st)) return send(res, 409, { ok: false, error: `job is already ${st.status}` });
    const body = await readJson(req);
    const { error, options } = checkOptions(body, jobDir);
    if (error) { // a reserved job that can't start is marked failed, so whoever checks its status learns why
      if (st) saveStatus(jobDir, { ...st, status: "failed", finishedAt: new Date().toISOString(), error });
      return send(res, 400, { ok: false, error });
    }
    options.url = !!body.url;
    const ahead = startJob(jobDir, options);
    return send(res, 202, { ok: true, job: path.basename(jobDir), status: "queued", jobsAhead: ahead });
  }
  if (req.method === "GET" && parts[2] === "status") {
    if (!st) return send(res, 404, { ok: false, error: "no such job" });
    const since = st.startedAt || st.queuedAt || st.createdAt, until = st.finishedAt ? Date.parse(st.finishedAt) : Date.now();
    return send(res, 200, { ok: true, ...st, seconds: since ? Math.round((until - Date.parse(since)) / 1000) : 0, files: inFiles(jobDir).length });
  }
  if (req.method === "GET" && parts[2] === "clips" && parts[3]) {
    const file = path.join(jobDir, "out", clean(parts[3]));
    if (st?.status !== "done" || !/\.mp4$/i.test(file) || !fs.existsSync(file)) return send(res, 404, { ok: false, error: "no such clip" });
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fs.statSync(file).size });
    return pipeline(fs.createReadStream(file), res);
  }
  if (req.method === "DELETE" && parts.length === 2) {
    if (busy(st)) return send(res, 409, { ok: false, error: `job is ${st.status}: wait until it is done` });
    fs.rmSync(jobDir, { recursive: true, force: true });
    return send(res, 200, { ok: true });
  }
  send(res, 404, { ok: false, error: "not found" });
}

// YouTube changes things that break downloaders, and yt-dlp ships fixes often: update it at start and once a day.
if (process.env.YTDLP_SELF_UPDATE) {
  const update = () => run(TOOLS.ytdlp(), ["-U"])
    .then((out) => console.log(`yt-dlp: ${out.trim().split("\n").pop()}`))
    .catch((e) => console.log(`yt-dlp update skipped: ${e.message}`));
  update();
  setInterval(update, 24 * 60 * 60 * 1000).unref();
}

const server = http.createServer((req, res) =>
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { ok: false, error: e.message });
    else res.destroy();
  }));
server.requestTimeout = 0; // big video uploads are normal here
server.listen(PORT, () => console.log(`autoclip listening on ${PORT}, work dir ${WORK}`));
