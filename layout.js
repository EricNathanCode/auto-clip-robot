// Decides how a 16:9 stream becomes a 9:16 clip, from where the faces are:
//   🎮 streamer: a SMALL face that stays in one spot near an edge = a webcam box over gameplay → cam on top, gameplay below
//   🎙️ podcast: BIG faces = people talking → a full-height crop that follows the person on screen / whoever is speaking
//   🕹️ gameplay: no steady face → the whole frame on a blurred copy of itself
// A tag from the streamer list ("streamer" / "podcast") always wins over the guess.
const path = require("path");
const { TOOLS, run, round, clamp } = require("./tools");

const W = 1080, H = 1920;
const even = (x) => Math.round(x / 2) * 2;

// Faces between start and end of a video file, plus its camera cuts; all times in seconds from `start`.
// { cuts: false } skips the cut search (for a quick look across a whole video).
async function findFaces(file, start, end, every = 0.5, { cuts: wantCuts = true } = {}) {
  const cuts = wantCuts ? await shotCuts(file, start, end) : [];
  const after = cuts.map((c) => round(c + 0.15)).filter((t) => t < end - start).join(","); // a look into every shot
  const out = await run(TOOLS.python(), [path.join(__dirname, "faces.py"), file, String(start), String(end),
    String(every), TOOLS.faceModel(), ...(after ? [after] : [])]);
  return { ...JSON.parse(out), cuts };
}

// Camera cuts (seconds from start), from FFmpeg's scene detector: an edited podcast switches cameras every few
// seconds, and the crop has to jump with the picture.
async function shotCuts(file, start, end) {
  let log = "";
  await run(TOOLS.ffmpeg(), ["-hide_banner", "-nostats", "-ss", String(start), "-t", String(round(end - start)), "-i", file,
    "-an", "-sn", "-vf", "scale=320:-2,scdet=threshold=10", "-f", "null", "-"], { onErr: (d) => (log += d) });
  return [...log.matchAll(/lavfi\.scd\.time: ([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.05);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// Faces grouped by where they sit in the frame (cx, cy as 0-1), most seen first. A webcam face stays in one spot;
// game characters (which the face finder sees too) wander around.
function spots(samples, sw, sh) {
  const groups = [];
  for (const s of samples) {
    for (const f of s.faces) {
      const cx = (f.x + f.w / 2) / sw, cy = (f.y + f.h / 2) / sh;
      let g = groups.find((q) => Math.abs(q.cx - cx) < 0.06 && Math.abs(q.cy - cy) < 0.08);
      if (!g) groups.push((g = { cx, cy, faces: [] }));
      g.faces.push(f);
      g.cx += (cx - g.cx) / g.faces.length;
      g.cy += (cy - g.cy) / g.faces.length;
    }
  }
  return groups.sort((a, b) => b.faces.length - a.faces.length);
}

// The guess. Returns { kind, cam?, why }.
function decide(found, override) {
  const { width: sw, height: sh, samples } = found;
  if (override === "podcast") return { kind: "podcast", why: "tagged podcast" };
  const n = Math.max(1, samples.length);
  const withFace = samples.filter((s) => s.faces.length);
  const share = withFace.length / n;
  const groups = spots(samples, sw, sh);
  // Webcams sit in a side strip; a game character standing still near the top-middle is not one.
  const edge = (g) => (g.cx < 0.3 ? "left" : g.cx > 0.7 ? "right" : "");
  const cam = groups.find((g) => g.faces.length / n >= 0.2 && median(g.faces.map((f) => f.h)) / sh < 0.22 && edge(g));
  if (cam) return { kind: "streamer", cam: camBox(cam.faces, sw, sh), face: middleFace(cam.faces), why: override === "streamer" ? "tagged streamer" : `a webcam face near the ${edge(cam)} edge` };
  if (override === "streamer") {
    if (!groups.length) return { kind: "gameplay", why: "tagged streamer, but no face to find the cam" };
    return { kind: "streamer", cam: camBox(groups[0].faces, sw, sh), face: middleFace(groups[0].faces), why: "tagged streamer" };
  }
  if (share < 0.3) return { kind: "gameplay", why: `a face in only ${Math.round(share * 100)}% of frames` };
  const hRatio = median(withFace.map((s) => Math.max(...s.faces.map((f) => f.h)) / sh));
  return { kind: "podcast", why: `big faces (${Math.round(hRatio * 100)}% of the height)` };
}

const middleFace = (faces) => Object.fromEntries(["x", "y", "w", "h"].map((k) => [k, median(faces.map((f) => f[k]))]));

// The webcam box's real border (webcam.py: its edges are sharp lines in every frame while the game changes), from
// looks spread over [start, end] of the video; null when it can't tell. Only reliable over a whole video: within one
// short clip the room behind the streamer is just as still as the border.
async function webcamBorder(file, start, end, face) {
  const out = await run(TOOLS.python(), [path.join(__dirname, "webcam.py"), file, String(start), String(end),
    ...[face.x, face.y, face.w, face.h].map(String)]);
  const { box } = JSON.parse(out);
  return box && box.w > face.w * 1.5 && box.h > face.h * 1.5
    ? { x: even(box.x), y: even(box.y), w: even(box.w), h: even(box.h) } : null;
}

// A webcam overlay shows head + shoulders: grow the face box into a typical cam rectangle (between 4:3 and 16:9).
function camBox(faces, sw, sh) {
  const m = (k) => median(faces.map((f) => f[k]));
  const fw = m("w"), fh = m("h"), fcx = m("x") + fw / 2, fcy = m("y") + fh / 2;
  let w = fw * 3.2, h = fh * 2.6;
  if (w / h > 16 / 9) h = w / (16 / 9);
  if (w / h < 4 / 3) w = h * (4 / 3);
  w = Math.min(w, sw); h = Math.min(h, sh);
  const x = clamp(fcx - w / 2, 0, sw - w), y = clamp(fcy - h * 0.42, 0, sh - h);
  return { x: even(x), y: even(y), w: even(w), h: even(h) };
}

// The people in one shot: faces grouped by where they sit (more than 10% of the width apart = different people),
// leaving out faces seen only now and then or much smaller than the main one (background, half out of the frame).
function peopleIn(shotSamples, cuts, sw) {
  const people = [];
  for (const p of shotSamples) {
    for (const f of p.faces) {
      const cx = f.x + f.w / 2;
      let q = people.find((o) => Math.abs(median(o.xs) - cx) < sw * 0.1);
      if (!q) people.push((q = { xs: [], hs: [], talk: [] }));
      q.xs.push(cx);
      q.hs.push(f.h);
      // a mouth reading compares two frames 0.1 s apart: across a cut it means nothing
      if (!cuts.some((c) => c > p.t && c <= p.t + 0.15)) q.talk.push({ t: p.t, mouth: f.mouth });
    }
  }
  const most = Math.max(0, ...people.map((q) => q.xs.length)), tallest = Math.max(0, ...people.map((q) => median(q.hs)));
  return people.filter((q) => q.xs.length >= most * 0.3 && median(q.hs) >= tallest * 0.6)
    .map((q) => ({ cx: median(q.xs), n: q.xs.length, talk: q.talk })).sort((a, b) => b.n - a.n);
}

// Who talks most between a and b: the person whose mouth moves most (null when nobody was seen then).
function talker(people, a, b) {
  let best = null, bestScore = -1;
  for (const q of people) {
    const m = q.talk.filter((x) => x.t >= a - 0.25 && x.t <= b + 0.25).map((x) => x.mouth);
    const score = m.length ? m.reduce((s, x) => s + x, 0) / m.length : -1;
    if (score > bestScore) { best = q; bestScore = score; }
  }
  return bestScore >= 0 ? best : null;
}

// Where the podcast crop looks, as keyframes { t, cx, jump? } (t in seconds from clipStart). Edited podcasts cut
// between cameras, so this works shot by shot: in each shot the crop sits on the person who is there, and when a shot
// holds several people (a wide shot) it glides to whoever talks during each sentence. At a cut it jumps with the picture.
function speakerTrack(found, sentences, clipStart) {
  const { width: sw, samples, cuts = [] } = found;
  const keys = [];
  const add = (t, cx, jump) => {
    if (keys.length && Math.abs(keys[keys.length - 1].cx - cx) < sw * 0.04) return; // already looking there
    // a jump is rounded down, so the first frame of the new shot already gets the new position
    keys.push(jump ? { t: Math.floor(Math.max(0, t) * 100 + 1e-6) / 100, cx: round(cx), jump: true } : { t: round(t), cx: round(cx) });
  };
  const edges = [0, ...cuts.filter((c) => c > 0).sort((a, b) => a - b)];
  edges.forEach((a, i) => {
    const b = i + 1 < edges.length ? edges[i + 1] : Infinity;
    const people = peopleIn(samples.filter((p) => p.t >= a && p.t < b), cuts, sw);
    if (!people.length) return add(a, sw / 2, true); // nobody found in this shot: the middle
    const turns = [];
    for (const s of people.length > 1 ? sentences : []) {
      const s0 = Math.max(a, s.t0 - clipStart), s1 = Math.min(b, s.t1 - clipStart);
      const p = s1 > s0 ? talker(people, s0, s1) : null;
      if (p) turns.push({ t: s0, p });
    }
    if (!turns.length) turns.push({ p: talker(people, a, b) || people[0] });
    turns.forEach((x, k) => add(k ? x.t : a, x.p.cx, k === 0));
  });
  return keys.length ? keys : [{ t: 0, cx: round(sw / 2) }];
}

// FFmpeg expression for the crop's left edge over time: holds each position, then glides 0.4 s to the next one, or
// jumps at once at a camera cut.
function cropXExpr(keys, cropW, sw) {
  const left = (cx) => round(clamp(cx - cropW / 2, 0, sw - cropW), 1);
  let expr = String(left(keys[keys.length - 1].cx));
  for (let i = keys.length - 1; i > 0; i--) {
    const t = keys[i].t, g = 0.4, x0 = left(keys[i - 1].cx), x1 = left(keys[i].cx);
    const glideEnd = round(Math.min(t + g, i + 1 < keys.length ? keys[i + 1].t : Infinity));
    expr = keys[i].jump ? `if(lt(t,${t}),${x0},${expr})`
      : `if(lt(t,${t}),${x0},if(lt(t,${glideEnd}),${x0}+(${round(x1 - x0, 1)})*(t-${t})/${g},${expr}))`;
  }
  return expr;
}

// The video half of the FFmpeg filter for a layout: from [0:v] to a 1080x1920 picture called [vbase].
// Returns { graph, captionY } (where the captions sit best in this layout).
function videoGraph(layout, src, extra = {}) {
  const { width: sw, height: sh } = src;
  if (layout.kind === "streamer") {
    // The cam fills the full width on top. A very wide or tall cam is trimmed (from its middle) to fit, never stretched.
    let cam = layout.cam;
    const topH = even(clamp(W * cam.h / cam.w, 540, 800)), botH = H - topH;
    if (cam.w / cam.h > W / topH) { const w = even(cam.h * W / topH); cam = { ...cam, x: even(cam.x + (cam.w - w) / 2), w }; }
    else if (cam.w / cam.h < W / topH) { const h = even(cam.w * topH / W); cam = { ...cam, y: even(cam.y + (cam.h - h) / 2), h }; }
    const gw = even(Math.min(sw, sh * W / botH)), gx = even((sw - gw) / 2);
    return {
      graph: `[0:v]split=2[cam][game];[cam]crop=${cam.w}:${cam.h}:${cam.x}:${cam.y},scale=${W}:${topH},setsar=1[top];` +
        `[game]crop=${gw}:${sh}:${gx}:0,scale=${W}:${botH},setsar=1[bot];[top][bot]vstack=2[vbase]`,
      captionY: topH + 40, hookY: 270, // below the top bar (TikTok's "Following | For You" ends ~180 px) and the credit
    };
  }
  if (layout.kind === "podcast") {
    const cropW = even(Math.min(sw, sh * W / H));
    const x = extra.keys ? cropXExpr(extra.keys, cropW, sw) : String(even((sw - cropW) / 2));
    return { graph: `[0:v]crop=w=${cropW}:h=${sh}:x='${x}':y=0,scale=${W}:${H},setsar=1[vbase]`, captionY: 1250, hookY: 270 };
  }
  return { // gameplay: fit on a blurred copy of itself
    graph: `[0:v]split=2[bg][fg];[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=12:2,` +
      `scale=${W}:${H},eq=brightness=-0.15[bgb];[fg]scale=${W}:-2[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[vbase]`,
    captionY: 1380, hookY: 300,
  };
}

module.exports = { findFaces, shotCuts, webcamBorder, decide, camBox, speakerTrack, cropXExpr, videoGraph, W, H };
