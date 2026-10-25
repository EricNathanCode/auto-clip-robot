# 🐟 Auto Clip Robot

A self-hosted clipping robot for my homelab: it turns a long **livestream or podcast** into the **3 best vertical clips**
(1080×1920), each in a version per platform, with **word-by-word captions**, an AI-written **hook title** and a
**credit** to the creator. Runs **CPU-only** on an old Dell OptiPlex (Proxmox → Debian LXC → Docker), orchestrated by
**n8n**, with a local AI (**Ollama**). Sister project of the [Auto Edit Robot](https://github.com/EricNathanCode/auto-edit-robot).

> Only for creators who **allow clipping** (official clipping programs / campaigns). Clips always credit the creator.

## How it works
```
link (YouTube / Twitch) or uploaded footage
  → 🔊 moments.js   loud spikes, "silence → explosion", optional YouTube "most replayed" peaks   (audio only, cheap)
  → 🗣️ speech.js    whisper.cpp (small.en) writes down ONLY the ~10 candidate windows, with word timings
  → 🧠 brain.js     the local AI scores each moment, picks the long cut + a shorter core cut (by sentence number,
                     never by timestamp), writes a hook title and a caption; falls back to loudness if the AI is off.
                     Hooks must be true (no exaggeration about real people), banned topics score 1, emojis are removed
  → ⬇️ download.js  the picture in H.264 (YouTube: the whole video once, cut locally; elsewhere just the chosen minutes)
  → 🙂 layout.js    OpenCV YuNet finds faces: 🎮 streamer (the face that stays put near an edge = the webcam → cam on
                     top, gameplay below) · 🎙️ podcast (shot by shot: the crop jumps with every camera cut and, in a
                     wide shot, glides to whoever's mouth moves) · 🕹️ gameplay (blurred background)
  → 🎬 render.js    FFmpeg: layout + ASS captions (Fredoka) + hook + credit, loudness to -14 LUFS, H.264 MP4
```

## One version per platform
| Platform | Cut | Caption look |
|---|---|---|
| TikTok | long (61–70 s, over 1 minute) | pop (uppercase, yellow word) |
| YouTube Shorts | core (30–60 s) | clean (pink word) |
| Instagram Reels | core, starts 0.3 s later | mint (uppercase, mint-green word) |
| X | core, starts 0.3 s earlier | pop |

A campaign's own length rule replaces the defaults. Different cuts and looks mean cross-posting never looks like a duplicate.

## API (`server.js`, port 8091, only on the private Docker network)
| Call | What it does |
|---|---|
| `GET /health` | ffmpeg / yt-dlp / whisper model check, `busy` (so n8n can take turns with the Auto Edit Robot) |
| `POST /jobs/<job>` | reserve a job |
| `PUT /jobs/<job>/files/<name>` | upload footage (e.g. a campaign's Drive file) |
| `POST /jobs/<job>/start` | JSON `{ url?, layout, cam?, credit, who, title, platforms, long, core, count, mustInclude?, avoid? }` → 202, runs in the background (`mustInclude` = text a campaign requires in every caption, e.g. `#ad`; `avoid` = topics it bans) |
| `GET /jobs/<job>/status` | queued / working (+ step) / done (+ clips, hooks, captions, files) / failed (+ reason) |
| `GET /jobs/<job>/clips/<file>` | download one MP4 |
| `DELETE /jobs/<job>` | clean up |

Jobs survive restarts (status on disk; an interrupted job is marked failed so n8n never waits forever), run one at a
time, and the big source file is deleted as soon as the clips are made.

## Built for slow hardware
- Listens first, watches later: the audio of an 8-hour stream is ~0.5 GB; only ~3 × 70 s of video is downloaded.
- Speech runs only on the candidate windows (small.en ran ~3–4× faster than real time on 4 CPU threads).
- whisper.cpp is compiled for the host's CPU during `docker build`.
- yt-dlp updates itself daily (YouTube changes often).

## Tests
`node test.js <scratchDir>`: **60 end-to-end checks** with made-up media (a test-pattern "stream" with a synthetic
voice and two hype moments), a fake Ollama, fake faces for the podcast layout, the whole job API, and a file:// link
through yt-dlp. On the Dell: `docker run --rm -v /opt/autoclip/test.js:/app/test.js autoclip node test.js /tmp/autoclip-test`

## Credits
FFmpeg · [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) · [OpenCV YuNet](https://github.com/opencv/opencv_zoo) ·
[yt-dlp](https://github.com/yt-dlp/yt-dlp) · [Fredoka](https://fonts.google.com/specimen/Fredoka) (SIL Open Font License, `fonts/OFL.txt`) ·
Ollama · n8n. Built with AI-assisted coding (Claude).
