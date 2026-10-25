# Auto Clip Robot: Node.js + FFmpeg + whisper.cpp + OpenCV + yt-dlp, CPU only. Built ON the Dell, so whisper.cpp is
# compiled for its exact CPU (GGML_NATIVE). Run it on the Docker network "ai" next to n8n and Ollama, with no open port.

# --- Stage 1: compile whisper.cpp (speech → words) ---
FROM debian:trixie-slim AS whisper
ARG WHISPER_VERSION=v1.9.5
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/${WHISPER_VERSION}.tar.gz" | tar xz --strip-components=1 \
 && cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build build -j"$(nproc)" --target whisper-cli \
 && cp build/bin/whisper-cli /whisper-cli

# --- Stage 2: the clipper ---
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg nodejs python3 python3-venv espeak-ng libgomp1 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# The container runs with IPv6 switched off; without this, FFmpeg tries a site's IPv6 address first and gives up with
# "cannot assign requested address" (exit 157). Prefer IPv4 answers for every program.
RUN echo "precedence ::ffff:0:0/96  100" >> /etc/gai.conf
# OpenCV for the face finder (headless = no screen libraries), in its own Python environment
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir opencv-python-headless
# Models: Whisper small English (~466 MB) and the YuNet face finder (~230 KB)
RUN mkdir -p /models \
 && curl -fsSL --retry 3 -o /models/ggml-small.en.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin" \
 && curl -fsSL --retry 3 -o /models/face_detection_yunet_2023mar.onnx "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
COPY --from=whisper /whisper-cli /usr/local/bin/whisper-cli

RUN useradd --uid 10002 --create-home autoclip && mkdir -p /work /app/bin && chown autoclip /work /app/bin
# yt-dlp's standalone build (includes its YouTube helper); it updates itself daily, so the app user owns it
RUN curl -fsSL --retry 3 -o /app/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux" \
 && chmod 755 /app/bin/yt-dlp && chown autoclip /app/bin/yt-dlp

WORKDIR /app
COPY fonts ./fonts
COPY tools.js moments.js speech.js brain.js layout.js faces.py captions.js render.js download.js clip.js server.js ./

ENV WORK_DIR=/work PORT=8091 OLLAMA_URL=http://ollama:11434 BRAIN_MODEL=qwen2.5:7b THREADS=4 \
    WHISPER=/usr/local/bin/whisper-cli WHISPER_MODEL=/models/ggml-small.en.bin \
    PYTHON=/opt/venv/bin/python FACE_MODEL=/models/face_detection_yunet_2023mar.onnx FONTS_DIR=/app/fonts \
    YTDLP=/app/bin/yt-dlp YTDLP_ARGS="--js-runtimes node --force-ipv4" YTDLP_SELF_UPDATE=1
USER autoclip
VOLUME /work
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8091/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
