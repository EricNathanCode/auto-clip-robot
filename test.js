// End-to-end test of the Auto Clip Robot with made-up media (no real streams, nothing personal).
// Usage: node test.js <scratchDir>
// Needs ffmpeg/ffprobe, whisper-cli + model, python3 with OpenCV + the YuNet model (see tools.js for the env names),
// and a text-to-speech voice for the fake streamer: espeak-ng (Linux/container) or Windows' built-in voice.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { TOOLS, run, probe } = require("./tools");
const { excitement, pickPeaks, loudness, STEP } = require("./moments");
const { fromWhisper, transcribe } = require("./speech");
const { fitSpan, pickClips, rank, lengthen, prompt, plain } = require("./brain");
const { decide, camBox, speakerTrack, cropXExpr, findFaces, shotCuts, webcamBorder, videoGraph } = require("./layout");
const { chunks, buildAss, isBad, censor, LOOKS } = require("./captions");
const { clipVideo, clipCount, fillCams } = require("./clip");
const { renderVersion } = require("./render");
const download = require("./download");

const scratch = path.resolve(process.argv[2] || "autoclip-test");
// The link test uses a local file:// link, which yt-dlp only accepts when asked.
if (!/--enable-file-urls/.test(process.env.YTDLP_ARGS || "")) process.env.YTDLP_ARGS = `${process.env.YTDLP_ARGS || ""} --enable-file-urls`.trim();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? "✅" : "❌"} ${what}`); if (!ok) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const ff = (...args) => run(TOOLS.ffmpeg(), ["-y", "-v", "error", ...args]);

const LINES = "Okay chat, listen to this. I just bought the cheapest mechanical keyboard on the internet. " +
  "No way! The keys actually feel smooth. It sounds like a thousand dollar keyboard. " +
  "Let's do a typing test. One hundred and twenty words per minute! That is my new record. " +
  "Anyway, thank you for watching, and remember to stay hydrated.";

async function say(text, wav) {
  if (process.platform === "win32") {
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}'); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`;
    return run("powershell", ["-NoProfile", "-Command", ps]);
  }
  return run("espeak-ng", ["-s", "165", "-w", wav, text]);
}

// A fake 3.7-minute stream: gameplay test pattern with a pink "webcam" box (top right), the voice talking at normal
// volume the whole time, and two hype moments: +10 dB at 80 s, and at 160 s right after 3 s of near-silence.
async function makeStream(dir) {
  const voice = path.join(dir, "voice.wav"), out = path.join(dir, "stream.mp4");
  await say(LINES, voice);
  await ff("-stream_loop", "-1", "-i", voice, "-i", voice, "-i", voice, "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=220",
    "-filter_complex",
    "[0]aresample=16000,atrim=0:220,asetpts=PTS-STARTPTS,volume=-12dB,volume='if(between(t,157,160),0.02,1)':eval=frame[bed];" +
    "[1]aresample=16000,atrim=3:11,asetpts=PTS-STARTPTS,volume=10dB,adelay=80000|80000[b1];" +
    "[2]aresample=16000,atrim=6:14,asetpts=PTS-STARTPTS,volume=10dB,adelay=160000|160000[b2];" +
    "[bed][b1][b2]amix=inputs=3:normalize=0,atrim=0:220[a];" +
    "[3:v]drawbox=x=1000:y=40:w=250:h=170:color=0xF472B6:t=fill[v]",
    "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-c:a", "aac", "-shortest", out);
  return { voice, stream: out };
}

// A stand-in for Ollama that always answers the same clip plan (tests the plumbing, not the AI's taste).
function fakeOllama(answer) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: TOOLS.brainModel() }] }));
      res.end(JSON.stringify({ message: { content: JSON.stringify(answer) } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function api(port, method, p, body, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers: raw ? {} : { "Content-Type": "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, json, buf });
      });
    });
    req.on("error", reject);
    if (raw) fs.createReadStream(raw).pipe(req);
    else req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  console.log("\n--- FINDING MOMENTS (no tools) ---");
  const levels = Array.from({ length: 800 }, (_, i) => -30 + Math.sin(i) * 2); // 200 s of normal talk
  for (let i = 300; i < 312; i++) levels[i] = -12; // loud at 75 s
  for (let i = 588; i < 600; i++) levels[i] = -75; // quiet 147-150 s…
  for (let i = 600; i < 612; i++) levels[i] = -12; // …then a burst at 150 s
  const ex = excitement(levels);
  const peaks = pickPeaks(ex.score, { count: 3, gap: 40, duration: 200, bonus: ex.bonus });
  check(peaks.some((p) => near(p.peak, 75, 3)) && peaks.some((p) => near(p.peak, 150, 3)), `finds both loud moments (${peaks.map((p) => p.peak).join(", ")} s)`);
  const burst = peaks.find((p) => near(p.peak, 150, 3)), steady = peaks.find((p) => near(p.peak, 75, 3));
  check(burst?.reasons.includes("silence → explosion") && !steady?.reasons.includes("silence → explosion"), "spots \"silence → explosion\" only after real silence");
  check(peaks.every((p) => p.start <= p.peak && p.end >= p.peak && p.start >= 0 && p.end <= 200), "windows contain their peak and stay inside the video");
  const withClue = pickPeaks(ex.score, { count: 1, duration: 200, extras: [{ t: 30, weight: 20, why: "most replayed" }] });
  check(near(withClue[0].peak, 30, 5) && withClue[0].reasons.includes("most replayed"), "outside clues (most replayed) lift a quiet moment");

  console.log("\n--- READING WHISPER'S OUTPUT (no tools) ---");
  const fakeWhisper = { transcription: [
    { text: " Okay chat, listen.", tokens: [{ text: "[_BEG_]", offsets: { from: 0, to: 0 } }, { text: " Okay", offsets: { from: 0, to: 400 } },
      { text: " chat", offsets: { from: 400, to: 700 } }, { text: ",", offsets: { from: 700, to: 720 } }, { text: " list", offsets: { from: 720, to: 900 } },
      { text: "en", offsets: { from: 900, to: 1100 } }, { text: ".", offsets: { from: 1100, to: 1150 } }, { text: " -", offsets: { from: 1150, to: 1150 } },
      { text: "[_TT_57]", offsets: { from: 1150, to: 1150 } }] },
    { text: " [Music]", tokens: [{ text: " [Music]", offsets: { from: 2000, to: 4000 } }] }] };
  const parsed = fromWhisper(fakeWhisper, 100);
  check(parsed.words.map((w) => w.w).join("|") === "Okay|chat,|listen.", `joins word pieces + punctuation, skips special tokens and lone dashes (${parsed.words.map((w) => w.w).join(" ")})`);
  check(parsed.words[0].t0 === 100 && parsed.words[2].t1 === 101.15, "word times are moved to the stream's clock");
  check(parsed.music === true && parsed.sentences.length === 1, "notices [Music] and keeps it out of the captions");
  const tok = (text, from) => ({ text, offsets: { from, to: from + 100 } });
  const notes = fromWhisper({ transcription: [
    { text: " It's in there. [BLANK_AUDIO]", tokens: [tok(" It's", 0), tok(" in", 100), tok(" there", 200), tok(".", 300), tok(" [", 400),
      tok("BL", 500), tok("ANK", 600), tok("_AUD", 700), tok("IO", 800), tok("]", 900)] },
    { text: " (upbeat music) He wins", tokens: [tok(" (", 1000), tok("up", 1100), tok("beat", 1200), tok(" music", 1300), tok(")", 1400),
      tok(" He", 1500), tok(" wins", 1600)] }] }, 0);
  check(notes.words.map((w) => w.w).join("|") === "It's|in|there.|He|wins" && notes.music,
    `sound notes in pieces ([BLANK_AUDIO], (upbeat music)) never become captions, and the music is noticed (${notes.words.map((w) => w.w).join(" ")})`);
  const dtw = fromWhisper({ transcription: [{ text: " Hello there.", tokens: [{ text: " Hello", offsets: { from: 0, to: 900 }, t_dtw: 52 },
    { text: " there", offsets: { from: 900, to: 1400 }, t_dtw: 98 }, { text: ".", offsets: { from: 1400, to: 1450 }, t_dtw: 120 }] }] }, 10);
  check(dtw.words[0].t0 === 10.3 && dtw.words[1].t0 === 10.76 && dtw.words[0].t1 <= dtw.words[1].t0,
    `uses Whisper's steadier DTW word times, minus their small lag (${dtw.words.map((w) => w.t0).join(", ")} s)`);

  console.log("\n--- FITTING CLIP LENGTHS (no tools) ---");
  const sent = Array.from({ length: 30 }, (_, i) => ({ t0: i * 4, t1: i * 4 + 3.5, text: `s${i}`, words: [{ w: `w${i}`, t0: i * 4, t1: i * 4 + 3.5 }] }));
  const len = ([a, b]) => sent[b].t1 + 0.25 - sent[a].t0;
  const grown = fitSpan(sent, 5, 6, [61, 70]);
  check(grown[0] === 5 && len(grown) >= 61 && len(grown) <= 70, `grows a short pick forward, keeping its hook (${len(grown).toFixed(1)} s)`);
  const shrunk = fitSpan(sent, 2, 28, [30, 60]);
  check(shrunk[0] === 2 && len(shrunk) >= 30 && len(shrunk) <= 60, `shrinks a long pick from the end (${len(shrunk).toFixed(1)} s)`);
  const edge = fitSpan(sent, 27, 29, [61, 70]);
  check(edge[1] === 29 && len(edge) >= 61, "near the end it grows backward instead");
  const early = { long: { start: 0, end: 19.75, sentences: [0, 4] }, core: { start: 0, end: 11.75, sentences: [0, 2] },
    speech: { words: sent.slice(0, 5).flatMap((s) => s.words), sentences: sent.slice(0, 5), music: false }, until: 20 };
  const later = lengthen(early, { words: sent.slice(5, 20).flatMap((s) => s.words), sentences: sent.slice(5, 20), music: false }, { long: [61, 70] });
  check(later.long.start === 0 && later.long.end - later.long.start >= 61 && later.core.end === 11.75 && later.speech.words.length === 20,
    `more speech after the window lets TikTok's cut run over a minute from the same start (${(later.long.end - later.long.start).toFixed(1)} s)`);

  console.log("\n--- HOW MANY CLIPS, AND WHICH FIRST (no tools) ---");
  check([120, 600, 1500, 3000, 7200].map(clipCount).join(",") === "1,2,5,10,10", "1 clip per 5 minutes of video, at least 1, at most 10 (2 min, 10, 25, 50, 120 min → 1, 2, 5, 10, 10)");
  const plan = (score, loud, start, by = "brain") => ({ score, loud, by, long: { start, end: start + 60 } });
  const ranked = rank([plan(6, 1, 0), plan(8, 1, 100), plan(9, 2, 200), plan(8, 4, 300), plan(5, 9, 400), plan(9, 9, 230), plan(4, 1, 500, "loudness")], { count: 10, minScore: 6 });
  check(ranked.map((p) => `${p.rank}:${p.score}`).join(" ") === "1:9 2:8 3:8 4:6 5:4" && ranked[1].loud === 4,
    `ranked best first (a tie goes to the louder moment), none overlapping, AI scores under 6 dropped (${ranked.map((p) => p.score).join(", ")})`);
  check(rank([plan(9, 1, 0), plan(8, 1, 100), plan(7, 1, 200)], { count: 2, minScore: 6 }).length === 2, "never more clips than asked for");

  console.log("\n--- LAYOUT FROM FACES (no tools) ---");
  const frame = (faces) => ({ width: 1920, height: 1080, samples: Array.from({ length: 20 }, (_, i) => ({ t: i * 0.5, faces })) });
  const small = decide(frame([{ x: 1600, y: 80, w: 120, h: 150, score: 0.9, mouth: 0.05 }]));
  check(small.kind === "streamer", `a small face in a corner = streamer (${small.why})`);
  check(small.cam && small.cam.x + small.cam.w <= 1920 && small.cam.y + small.cam.h <= 1080 && small.cam.w / small.cam.h >= 1.3 && small.cam.w / small.cam.h <= 1.8,
    `the cam box grows around the face and stays in the frame (${JSON.stringify(small.cam)})`);
  check(decide(frame([{ x: 700, y: 200, w: 400, h: 500, score: 0.9, mouth: 0.1 }])).kind === "podcast", "a big face = podcast");
  check(decide(frame([])).kind === "gameplay", "no face = gameplay on a blurred background");
  check(decide(frame([{ x: 700, y: 200, w: 400, h: 500, score: 0.9, mouth: 0.1 }]), "streamer").kind === "streamer", "a streamer tag wins over the guess");
  const two = { width: 1920, height: 1080, samples: [] };
  for (let t = 0; t < 20; t += 0.5) two.samples.push({ t, faces: [{ x: 300, y: 200, w: 300, h: 380, mouth: t < 10 ? 0.12 : 0.01 }, { x: 1300, y: 200, w: 300, h: 380, mouth: t < 10 ? 0.01 : 0.15 }] });
  const keys = speakerTrack(two, [{ t0: 1, t1: 8 }, { t0: 11, t1: 18 }], 0);
  check(keys.length === 2 && keys[0].cx < 960 && keys[1].cx > 960, `follows whoever talks: left, then right (${keys.map((k) => k.cx).join(" → ")})`);
  const expr = cropXExpr(keys, 608, 1920);
  check(/^if\(lt\(t,11\),/.test(expr) && expr.includes("(t-11)/0.4"), "the crop glides to the new speaker in 0.4 s");
  const game = { width: 1920, height: 1080, samples: [] }; // a webcam top-left (seen 60% of the time) + game characters:
  for (let t = 0; t < 20; t += 0.5) {
    game.samples.push({ t, faces: [...(t % 5 < 3 ? [{ x: 120, y: 200, w: 110, h: 130, mouth: 0.1 }] : []),
      { x: 700 + (t % 4) * 60, y: 300 + (t % 3) * 40, w: 260, h: 320, mouth: 0 }, // one wandering in the middle,
      { x: 890, y: 60, w: 140, h: 170, mouth: 0 }] }); // one standing still near the top, always there
  }
  const gl = decide(game);
  check(gl.kind === "streamer" && gl.cam.x < 400, `finds the webcam, not the game character in the middle (${gl.why})`);
  const cut = { width: 1920, height: 1080, cuts: [5.02], samples: [] }; // camera 1 shows the left person, camera 2 the right
  for (let t = 0; t < 10; t += 0.5) cut.samples.push({ t, faces: [t < 5 ? { x: 300, y: 200, w: 300, h: 380, mouth: 0.1 } : { x: 1300, y: 200, w: 300, h: 380, mouth: 0.1 }] });
  cut.samples.push({ t: 7, faces: [{ x: 1700, y: 100, w: 150, h: 160, mouth: 0.3 }] }); // a face seen once, in the background
  const cutKeys = speakerTrack(cut, [{ t0: 0, t1: 10 }], 0);
  check(cutKeys.length === 2 && cutKeys[1].jump && cutKeys[1].t === 5.02 && cutKeys[1].cx === 1450,
    `at a camera cut the crop jumps to the face in the new shot (${cutKeys.map((k) => `${k.t}s→${k.cx}`).join(", ")})`);
  const hd = { width: 1920, height: 1080 };
  const whole = videoGraph({ kind: "streamer", cam: { x: 0, y: 0, w: 400, h: 300 } }, hd);
  check(whole.graph.includes("[game]crop=1492:1080:428:0,scale=1080:782") && whole.graph.includes("overlay=0:170") && whole.captionY === 885,
    "streamer, cam on the left: the game from just past the cam's right edge to the right side, bigger, captions in the band between");
  check(videoGraph({ kind: "streamer", cam: { x: 1520, y: 0, w: 400, h: 300 } }, hd).graph.includes("[game]crop=1492:1080:0:0,"),
    "cam on the right: the game from the left side to just before the cam's left edge");
  const bigCam = videoGraph({ kind: "streamer", cam: { x: 0, y: 0, w: 1000, h: 700 } }, hd).graph;
  check(bigCam.includes("scale=1080:608") && bigCam.includes("[gc]crop=1000:700:0:0,boxblur"),
    "a very wide cam would leave too little game: full width instead, small webcam blurred out");
  const wide = videoGraph({ kind: "streamer", cam: { x: 0, y: 0, w: 800, h: 200 } }, { width: 1920, height: 1080 });
  check(wide.graph.includes("crop=400:200:200:0,scale=1080:540"), "a very wide webcam is trimmed to fit the top, never stretched");
  const cutExpr = cropXExpr(cutKeys, 608, 1920);
  check(cutExpr.startsWith("if(lt(t,5.02),") && !cutExpr.includes("/0.4"), "a jump has no glide");

  console.log("\n--- CAPTIONS (no tools) ---");
  const ws = "this is a test of the caption robot today. okay".split(" ").map((w, i) => ({ w, t0: 10 + i * 0.3, t1: 10.25 + i * 0.3 }));
  const groups = chunks(ws);
  check(groups.every((g) => g.length <= 3 && g.map((x) => x.w).join(" ").length <= 16), `chunks of max 3 words / 16 letters (${groups.map((g) => g.map((x) => x.w).join(" ")).join(" | ")})`);
  check(groups.some((g) => g[g.length - 1].w === "today.") , "a new caption starts after a full stop");
  const ass = buildAss({ words: [...ws, { w: "{\\bad}", t0: 12.8, t1: 13 }], clipStart: 10, clipEnd: 14, hook: "Hook Here", credit: "@someone" });
  check(ass.includes("Hook Here") && ass.includes("@someone") && ass.includes("Style: Cap,Fredoka"), "the subtitle file has the hook, the credit and the Fredoka style");
  check(!ass.includes("{\\bad}") && /Dialogue: 1,0:00:00.00,/.test(ass), "caption times start at the clip's start, and braces in words can't inject styles");
  const dash = buildAss({ words: [{ w: "in,", t0: 1, t1: 1.3 }, { w: "-", t0: 1.3, t1: 1.4 }], clipStart: 0, clipEnd: 3, look: "mint" });
  check(!/ -|-\{|\}-/.test(dash.split("[Events]")[1]) && Object.keys(LOOKS).every((k) => !/^Style: Cap(,[^,]*){14},3,/m.test(buildAss({ words: [], clipStart: 0, clipEnd: 1, look: k }))),
    "a lone dash is never shown, and no caption look darkens the picture with a box");
  check(/^Style: Credit(,[^,]*){17},7,/m.test(ass), "the creator's name sits top-left");
  check(["fuck!", "Fucking", "bullshit", "BITCH", "dick", "f**k"].every(isBad) && !["class", "assassin", "Dickens", "cocktail", "damn", "hell"].some(isBad),
    "bad words are caught (fuck, bullshit, bitch, f**k…), but not words that only contain them (class, Dickens) or mild ones (damn, hell)");
  const rude = buildAss({ words: [{ w: "what", t0: 1, t1: 1.3 }, { w: "the", t0: 1.3, t1: 1.5 }, { w: "fuck!", t0: 1.5, t1: 1.9 }], clipStart: 0, clipEnd: 3,
    hook: "Holy shit moment" });
  check(!/fuck|shit/i.test(rude) && rude.includes("****!") && rude.includes("Holy **** moment") && censor("You bitch.") === "You *****.",
    "bad words show as ***** in captions and hooks (punctuation kept)");

  console.log("\n--- TOOLS: LOUDNESS, SPEECH, FACES ---");
  const { voice, stream } = await makeStream(scratch);
  const info = await probe(stream);
  check(near(info.duration, 220, 1) && info.hasAudio && info.width === 1280, `made a ${Math.round(info.duration)} s fake stream`);
  const lv = await loudness(stream);
  check(near(lv.length * STEP, 220, 2), `reads loudness every ${STEP} s (${lv.length} readings)`);
  const words = await transcribe(voice, 0, 30, path.join(scratch, "speech"));
  const said = words.words.map((w) => w.w.toLowerCase()).join(" ");
  check(/keyboard/.test(said) && /chat/.test(said), `the speech AI writes down the voice ("${said.slice(0, 60)}…")`);
  check(words.words.every((w, i, a) => w.t1 >= w.t0 && (i === 0 || w.t0 >= a[i - 1].t0)), "word times go forward");
  const fileUrl = (f) => "file:///" + f.replace(/\\/g, "/").replace(/^\//, "");
  const soundOnly = await download.full(fileUrl(voice), path.join(scratch, "dl-sound")).then(() => "accepted", (e) => e.message);
  check(/without picture/.test(soundOnly) && !fs.existsSync(path.join(scratch, "dl-sound", "full.mp4")), `a download with sound but no picture is refused and deleted ("${soundOnly}")`);
  check(download.isYouTube("https://www.youtube.com/watch?v=x") && download.isYouTube("https://youtu.be/x") && !download.isYouTube("https://www.twitch.tv/videos/1")
    && /vcodec\^=avc1/.test(download.VIDEO), "YouTube gets one whole H.264 download; other sites try just the minutes first");
  const faces = await findFaces(stream, 10, 14, 1);
  check(faces.width === 1280 && faces.samples.length >= 3 && faces.samples.every((s) => s.faces.length === 0), "the face finder runs (and sees no face in a test pattern)");
  const beeped = path.join(scratch, "beeped.mp4");
  await renderVersion({ file: stream, seek: 10, src: info, start: 10, end: 14, layout: { kind: "gameplay" }, words: [{ w: "oh", t0: 10.5, t1: 10.8 },
    { w: "shit!", t0: 11, t1: 11.4 }, { w: "nice", t0: 12, t1: 12.3 }], hook: "", credit: "", look: "pop", outFile: beeped,
    workDir: path.join(scratch, "beep-work"), name: "beep" });
  const bp = await probe(beeped);
  check(bp.hasAudio && bp.hasVideo && near(bp.duration, 4, 0.3), "a clip with a bad word renders, with the word muted and beeped");
  const camA = { x: 0, y: 0, w: 400, h: 300 }, camB = { x: 0, y: 0, w: 500, h: 360 };
  const filled = fillCams([{ face: { x: 100, y: 80, w: 60, h: 70 }, box: camA }, { face: { x: 110, y: 85, w: 60, h: 70 }, box: null },
    { face: { x: 120, y: 160, w: 80, h: 90 }, box: camB }, { face: { x: 400, y: 500, w: 60, h: 70 }, box: null }]);
  check(filled[1] === camA && filled[2] === camB && filled[3] === null,
    "a clip whose webcam border wasn't clear borrows the box of a clip with the face in the same spot (or keeps the video's)");
  const streamerOut = path.join(scratch, "streamer-layout.mp4"); // the pink box plays the webcam
  await ff("-t", "1", "-i", stream, "-filter_complex", videoGraph({ kind: "streamer", cam: { x: 1000, y: 40, w: 250, h: 170 } }, info).graph,
    "-map", "[vbase]", "-c:v", "libx264", "-preset", "ultrafast", streamerOut);
  const so = await probe(streamerOut);
  check(so.width === 1080 && so.height === 1920, "the streamer layout renders: cam on top, the whole game below on a blurred copy");
  const twoShots = path.join(scratch, "two-shots.mp4"); // 3 s of one "camera", then 3 s of another
  await ff("-f", "lavfi", "-i", "color=c=0x8B5CF6:s=320x180:r=30:d=3", "-f", "lavfi", "-i", "color=c=0xFDE68A:s=320x180:r=30:d=3",
    "-filter_complex", "[0][1]concat=n=2:v=1:a=0", "-c:v", "libx264", "-preset", "ultrafast", twoShots);
  const shots = await shotCuts(twoShots, 1, 6);
  check(shots.length === 1 && near(shots[0], 2, 0.05), `finds the camera cut, timed from the clip's start (${shots.join(", ")} s)`);
  const overlay = path.join(scratch, "webcam-overlay.mp4"); // ever-changing "gameplay" with a still webcam box top-left
  await ff("-f", "lavfi", "-i", "gradients=s=640x360:speed=0.08:n=4:rate=25", "-t", "12",
    "-vf", "drawbox=x=0:y=40:w=200:h=120:color=0x403530:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", overlay);
  const border = await webcamBorder(overlay, 0, 12, { x: 70, y: 70, w: 40, h: 50 });
  check(border && near(border.x, 0, 6) && near(border.y, 40, 6) && near(border.w, 200, 8) && near(border.h, 120, 8),
    `finds the webcam box's exact border (${JSON.stringify(border)})`);

  console.log("\n--- THE BRAIN (a fake Ollama) ---");
  const asked = prompt(words.sentences, { long: [61, 70], core: [30, 60] });
  check(/playing the game The Masterplan/.test(prompt(words.sentences, { long: [61, 70], core: [30, 60], game: "The Masterplan" })), "the brain is told which game is played");
  check(/politics/.test(asked) && /TRUE to what is said/.test(asked) && /no emojis/.test(asked), "the brain is told: true hooks only, skip banned topics, no emojis");
  check(/watching or reacting to a video[^.]*the score is 1/.test(asked), "the brain is told: someone watching a video instead of playing scores 1 (someone else's content)");
  check(/gambling/.test(prompt(words.sentences, { long: [61, 70], core: [30, 60], avoid: "gambling" })), "a campaign can set its own banned topics");
  check(plain("Child Labor? 🤔 #fyp") === "Child Labor?" && plain("🇵🇭 Wow 👍🏽") === "Wow", "emojis and hashtags are removed from on-screen text");
  const brainAnswer = { score: 9, start: 0, core_end: 1, end: 2, hook: "THIS KEYBOARD IS INSANE 🤯 #wow", caption: "test caption", why: "test" };
  const fake = await fakeOllama(brainAnswer);
  process.env.OLLAMA_URL = `http://127.0.0.1:${fake.address().port}`;
  const cand = { peak: 15, score: 3, reasons: ["loud"], start: 0, end: 30, speech: words };
  const picked = await pickClips([cand], { count: 1, long: [20, 28], core: [10, 18] });
  const c0 = picked.clips[0];
  check(c0?.by === "brain" && c0.hook === "THIS KEYBOARD IS INSANE" && c0.score === 9, "uses the brain's score and hook (without its emoji and hashtag)");
  check(c0 && c0.long.end - c0.long.start >= 20 && c0.core.end - c0.core.start >= 10 && c0.core.end - c0.core.start <= 18.5,
    `fits the lengths (long ${(c0.long.end - c0.long.start).toFixed(1)} s, core ${(c0.core.end - c0.core.start).toFixed(1)} s)`);
  check(c0 && c0.core.start === c0.long.start && c0.core.end <= c0.long.end, "every version opens on the same line; the long cut only runs on");
  const picky = await pickClips([cand], { count: 1, minScore: 10, long: [20, 28], core: [10, 18] });
  check(picky.clips.length === 0 && /no moment scored 10 or more \(best: 9\)/.test(picky.note), `a moment below the minimum score is skipped, and the note says why ("${picky.note}")`);
  process.env.OLLAMA_URL = "http://127.0.0.1:9";
  const offline = await pickClips([cand], { count: 1, long: [20, 28], core: [10, 18] });
  check(offline.clips[0]?.by === "loudness" && /not reachable/.test(offline.note) && offline.clips[0].hook, "with no brain it still picks a clip (and says so)");

  console.log("\n--- PODCAST LAYOUT (fake faces) ---");
  const fakeFaces = { width: 1280, height: 720, samples: [] };
  for (let t = 0; t <= 220; t += 0.5) {
    fakeFaces.samples.push({ t, faces: [{ x: 200, y: 150, w: 220, h: 280, mouth: Math.floor(t / 6) % 2 ? 0.01 : 0.12 },
      { x: 860, y: 150, w: 220, h: 280, mouth: Math.floor(t / 6) % 2 ? 0.13 : 0.01 }] });
  }
  fs.writeFileSync(path.join(scratch, "faces.json"), JSON.stringify(fakeFaces));
  process.env.FAKE_FACES = path.join(scratch, "faces.json");
  const pod = await clipVideo({ source: stream, outDir: path.join(scratch, "podcast"), platforms: ["reels"], count: 1,
    long: [20, 28], core: [10, 18], credit: "@pod", log: () => {} });
  delete process.env.FAKE_FACES;
  const podInfo = await probe(path.join(scratch, "podcast", pod.outputs[0].file));
  check(pod.layout.kind === "podcast" && podInfo.width === 1080 && podInfo.height === 1920, "big faces → a 1080x1920 podcast clip that follows the speaker");

  console.log("\n--- THE JOB API (a server, like on the Dell) ---");
  process.env.OLLAMA_URL = `http://127.0.0.1:${fake.address().port}`;
  const work = path.join(scratch, "work");
  fs.mkdirSync(path.join(work, "old-job"), { recursive: true });
  fs.writeFileSync(path.join(work, "old-job", "status.json"), JSON.stringify({ job: "old-job", status: "working" }));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: { ...process.env, PORT: String(port), WORK_DIR: work, ALLOW_FILE_URLS: "1", YTDLP_SELF_UPDATE: "" }, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
  for (let i = 0; i < 50; i++) { try { await api(port, "GET", "/health"); break; } catch { await sleep(200); } }
  const health = await api(port, "GET", "/health");
  check(health.json?.ok && /ffmpeg/i.test(health.json.ffmpeg) && health.json.busy === false, "health: ffmpeg found, not busy");
  const old = await api(port, "GET", "/jobs/old-job/status");
  check(old.json?.status === "failed" && /restarted/.test(old.json.error), "a job cut off by a restart is marked failed");

  check((await api(port, "POST", "/jobs/empty")).status === 201, "reserving a job answers 201");
  const empty = await api(port, "POST", "/jobs/empty/start", {});
  check(empty.status === 400 && (await api(port, "GET", "/jobs/empty/status")).json.status === "failed", "starting with no video is refused and the job says why");
  await api(port, "POST", "/jobs/bad");
  const bads = [{ url: "ftp://x" }, { url: "https://x", platforms: ["myspace"] }, { url: "https://x", long: [90, 20] },
    { url: "https://x", layout: "sideways" }, { url: "https://x", count: 11 }, { url: "https://x", minScore: 0 }];
  const codes = [];
  for (const b of bads) { await api(port, "POST", "/jobs/bad"); codes.push((await api(port, "POST", "/jobs/bad/start", b)).status); }
  check(codes.every((c) => c === 400), `bad url / platform / lengths / layout / count / minScore are refused (${codes.join(",")})`);
  check((await api(port, "PUT", "/jobs/..%2F..%2Fescape/files/x.mp4", undefined, voice)).status !== 500 && !fs.existsSync(path.join(scratch, "escape")),
    "sneaky ../ names stay inside the work folder");

  await api(port, "POST", "/jobs/clip1");
  const up = await api(port, "PUT", "/jobs/clip1/files/stream.mp4", undefined, stream);
  check(up.json?.bytes === fs.statSync(stream).size, "uploading the source video");
  const start = await api(port, "POST", "/jobs/clip1/start", { cam: { x: 1000, y: 40, w: 250, h: 170 }, credit: "@tester",
    platforms: ["tiktok", "shorts"], long: [20, 28], core: [10, 18], count: 1, mustInclude: "#ad · The podcast name is Test Show" });
  check(start.status === 202, "starting answers 202 at once (background job)");
  check((await api(port, "POST", "/jobs/clip1/start", {})).status === 409, "a second start while working is refused (409)");
  check((await api(port, "GET", "/jobs/clip1/clips/01-tiktok.mp4")).status === 404, "no clip until it is done (404)");
  let st;
  const t0 = Date.now();
  do { await sleep(2000); st = (await api(port, "GET", "/jobs/clip1/status")).json; } while (["queued", "working"].includes(st.status) && Date.now() - t0 < 20 * 60 * 1000);
  check(st.status === "done", `finishes as "done" (${st.seconds} s)${st.error ? `: ${st.error}` : ""}`);
  const outs = st.result?.outputs || [];
  check(outs.length === 2 && outs.map((o) => o.platform).join() === "tiktok,shorts", "one clip × 2 platforms = 2 files");
  check(st.result?.clips[0]?.hook === "THIS KEYBOARD IS INSANE" && /@tester/.test(st.result.clips[0].caption), "the result has the hook and a ready caption with the credit");
  check(/#ad · The podcast name is Test Show$/.test(st.result?.clips[0]?.caption || ""), "the campaign's required text (#ad…) ends every caption");
  if (outs.length === 2) {
    const tk = await api(port, "GET", `/jobs/clip1/clips/${outs[0].file}`);
    fs.writeFileSync(path.join(scratch, "tiktok.mp4"), tk.buf);
    const ti = await probe(path.join(scratch, "tiktok.mp4"));
    check(tk.status === 200 && ti.width === 1080 && ti.height === 1920 && ti.hasAudio, "the TikTok clip downloads: 1080x1920 with sound");
    check(ti.duration >= 19 && ti.duration <= 29.5 && outs[1].seconds >= 9.5 && outs[1].seconds <= 19, `lengths follow the rules (TikTok ${ti.duration.toFixed(1)} s, Shorts ${outs[1].seconds} s)`);
  }
  check(!fs.existsSync(path.join(work, "clip1", "in")), "the big source file is deleted after clipping");
  check((await api(port, "DELETE", "/jobs/clip1")).status === 200 && (await api(port, "GET", "/jobs/clip1/status")).status === 404, "deleting a job removes it");

  if ((await api(port, "GET", "/health")).json.ytdlp !== "missing") {
    await api(port, "POST", "/jobs/url1");
    const u = await api(port, "POST", "/jobs/url1/start", { url: "file:///" + stream.replace(/\\/g, "/").replace(/^\//, ""), cam: { x: 1000, y: 40, w: 250, h: 170 },
      platforms: ["shorts"], long: [20, 28], core: [10, 18], count: 1 });
    let us;
    const t1 = Date.now();
    do { await sleep(2000); us = (await api(port, "GET", "/jobs/url1/status")).json; } while (u.status === 202 && ["queued", "working"].includes(us.status) && Date.now() - t1 < 20 * 60 * 1000);
    check(us.status === "done" && us.result.outputs.length === 1, `a link works too: audio first, then the video (${us.status}${us.error ? `: ${us.error}` : ""})`);
  }

  server.kill();
  fake.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
