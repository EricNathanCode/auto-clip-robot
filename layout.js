// Decides how a 16:9 stream becomes a 9:16 clip, from where the faces are:
//   🎮 streamer: a SMALL face near an edge = a webcam box over gameplay → cam on top, gameplay below
//   🎙️ podcast: BIG faces = people talking → a full-height crop that follows whoever is speaking
//   🕹️ gameplay: no steady face → the whole frame on a blurred copy of itself
// A tag from the streamer list ("streamer" / "podcast") always wins over the guess.
const { TOOLS, run, round, clamp } = require("./tools");

const W = 1080, H = 1920;
const even = (x) => Math.round(x / 2) * 2;

async function findFaces(file, start, end, every = 0.5) {
  const out = await run(TOOLS.python(), [require("path").join(__dirname, "faces.py"), file, String(start), String(end),
    String(every), TOOLS.faceModel()]);
  return JSON.parse(out);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

// The guess. Returns { kind, cam?, why }.
function decide(found, override) {
  const { width: sw, height: sh, samples } = found;
  const withFace = samples.filter((s) => s.faces.length);
  const share = withFace.length / Math.max(1, samples.length);
  const biggest = withFace.map((s) => s.faces.reduce((a, b) => (b.h > a.h ? b : a)));
  if (override === "podcast") return { kind: "podcast", why: "tagged podcast" };
  if (share < 0.3 && override !== "streamer") return { kind: "gameplay", why: `a face in only ${Math.round(share * 100)}% of frames` };
  const hRatio = median(biggest.map((f) => f.h / sh));
  const cx = median(biggest.map((f) => (f.x + f.w / 2) / sw)), cy = median(biggest.map((f) => (f.y + f.h / 2) / sh));
  const nearEdge = cx < 0.3 || cx > 0.7 || cy < 0.3 || cy > 0.7;
  if (override === "streamer" || (hRatio < 0.22 && nearEdge)) {
    if (!biggest.length) return { kind: "gameplay", why: "tagged streamer, but no face to find the cam" };
    return { kind: "streamer", cam: camBox(biggest, sw, sh), why: override === "streamer" ? "tagged streamer" : `small face near the ${cx < 0.5 ? "left" : "right"} edge` };
  }
  return { kind: "podcast", why: `big faces (${Math.round(hRatio * 100)}% of the height)` };
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

// Who speaks when (podcast): for each sentence, the face whose mouth moves most; returns crop-centre keyframes.
// Faces are told apart by where they sit across the frame (people more than 15% of the width apart = different people).
function speakerTrack(found, sentences, clipStart) {
  const { width: sw, samples } = found;
  const keys = [];
  let lastCx = sw / 2;
  for (const s of sentences) {
    const a = s.t0 - clipStart, b = s.t1 - clipStart;
    const inside = samples.filter((p) => p.t >= a - 0.25 && p.t <= b + 0.25 && p.faces.length);
    if (!inside.length) continue;
    const seats = [];
    for (const p of inside) {
      for (const f of p.faces) {
        const cx = f.x + f.w / 2;
        let seat = seats.find((q) => Math.abs(q.cx - cx) < sw * 0.15);
        if (!seat) seats.push((seat = { cx, talk: 0, size: 0, n: 0 }));
        seat.cx = (seat.cx * seat.n + cx) / (seat.n + 1);
        seat.talk += f.mouth; seat.size += f.h; seat.n++;
      }
    }
    const speaker = seats.length === 1 ? seats[0]
      : seats.reduce((best, q) => (q.talk / q.n > best.talk / best.n ? q : best));
    if (Math.abs(speaker.cx - lastCx) > sw * 0.04 || !keys.length) keys.push({ t: round(Math.max(0, a)), cx: round(speaker.cx) });
    lastCx = speaker.cx;
  }
  return keys.length ? keys : [{ t: 0, cx: round(sw / 2) }];
}

// FFmpeg expression for the crop's left edge over time: holds each position, glides 0.4 s to the next.
function cropXExpr(keys, cropW, sw) {
  const left = (cx) => round(clamp(cx - cropW / 2, 0, sw - cropW), 1);
  let expr = String(left(keys[keys.length - 1].cx));
  for (let i = keys.length - 1; i > 0; i--) {
    const t = keys[i].t, g = 0.4, x0 = left(keys[i - 1].cx), x1 = left(keys[i].cx);
    expr = `if(lt(t,${t}),${x0},if(lt(t,${round(t + g)}),${x0}+(${round(x1 - x0, 1)})*(t-${t})/${g},${expr}))`;
  }
  return expr;
}

// The video half of the FFmpeg filter for a layout: from [0:v] to a 1080x1920 picture called [vbase].
// Returns { graph, captionY } (where the captions sit best in this layout).
function videoGraph(layout, src, extra = {}) {
  const { width: sw, height: sh } = src;
  if (layout.kind === "streamer") {
    const cam = layout.cam;
    const topH = even(clamp(W * cam.h / cam.w, 540, 800)), botH = H - topH;
    const gw = even(Math.min(sw, sh * W / botH)), gx = even((sw - gw) / 2);
    return {
      graph: `[0:v]split=2[cam][game];[cam]crop=${cam.w}:${cam.h}:${cam.x}:${cam.y},scale=${W}:${topH},setsar=1[top];` +
        `[game]crop=${gw}:${sh}:${gx}:0,scale=${W}:${botH},setsar=1[bot];[top][bot]vstack=2[vbase]`,
      captionY: topH + 40, hookY: 210, // below the platforms' top bar (TikTok's "Following | For You" ends ~180 px)
    };
  }
  if (layout.kind === "podcast") {
    const cropW = even(Math.min(sw, sh * W / H));
    const x = extra.keys ? cropXExpr(extra.keys, cropW, sw) : String(even((sw - cropW) / 2));
    return { graph: `[0:v]crop=w=${cropW}:h=${sh}:x='${x}':y=0,scale=${W}:${H},setsar=1[vbase]`, captionY: 1250, hookY: 230 };
  }
  return { // gameplay: fit on a blurred copy of itself
    graph: `[0:v]split=2[bg][fg];[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=12:2,` +
      `scale=${W}:${H},eq=brightness=-0.15[bgb];[fg]scale=${W}:-2[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[vbase]`,
    captionY: 1380, hookY: 300,
  };
}

module.exports = { findFaces, decide, camBox, speakerTrack, cropXExpr, videoGraph, W, H };
