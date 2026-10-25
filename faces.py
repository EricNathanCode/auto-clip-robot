"""Finds faces in a stretch of video with OpenCV's tiny YuNet model (CPU, no graphics card needed).

Usage: python faces.py <video> <start s> <end s> <every s> <yunet.onnx>
Prints JSON: {"width": W, "height": H, "samples": [{"t": seconds from start, "faces": [{"x","y","w","h","score","mouth"}]}]}
"mouth" = how much the mouth area changes over the next ~0.1 s (talking moves the mouth); used to find who speaks.
"""
import json
import sys

import cv2
import numpy as np

DETECT_WIDTH = 640  # faces are found on a smaller copy of the frame (fast); boxes are scaled back to full size


def mouth_box(face, scale):
    # YuNet landmarks: right eye, left eye, nose tip, right mouth corner, left mouth corner (x, y pairs).
    rx, ry, lx, ly = face[10], face[11], face[12], face[13]
    cx, cy = (rx + lx) / 2, (ry + ly) / 2
    span = max(4.0, abs(lx - rx))
    x0, x1 = cx - span * 0.8, cx + span * 0.8
    y0, y1 = cy - span * 0.35, cy + span * 0.55
    return [int(v * scale) for v in (x0, y0, x1, y1)]


def mouth_motion(a, b, box):
    x0, y0, x1, y1 = box
    h, w = a.shape[:2]
    x0, x1 = max(0, x0), min(w, x1)
    y0, y1 = max(0, y0), min(h, y1)
    if x1 - x0 < 3 or y1 - y0 < 3:
        return 0.0
    pa = cv2.cvtColor(a[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY).astype(np.float32)
    pb = cv2.cvtColor(b[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY).astype(np.float32)
    return float(np.mean(np.abs(pa - pb)) / (np.mean(pa) + 1.0))


def main():
    video, start, end, every, model = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), sys.argv[5]
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f"can't open {video}")
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    scale = W / DETECT_WIDTH if W > DETECT_WIDTH else 1.0
    dw, dh = int(round(W / scale)), int(round(H / scale))
    det = cv2.FaceDetectorYN.create(model, "", (dw, dh), 0.8, 0.3, 50)
    ahead = max(1, int(round(fps * 0.1)))  # frames in ~0.1 s
    samples = []
    t = start
    while t < end:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok:
            break
        later = frame
        for _ in range(ahead):
            ok2, f2 = cap.read()
            if not ok2:
                break
            later = f2
        _, found = det.detect(cv2.resize(frame, (dw, dh)))
        faces = []
        for f in (found if found is not None else []):
            x, y, w, h = (float(v) * scale for v in f[:4])
            faces.append({"x": round(x), "y": round(y), "w": round(w), "h": round(h), "score": round(float(f[14]), 3),
                          "mouth": round(mouth_motion(frame, later, mouth_box(f, scale)), 4)})
        samples.append({"t": round(t - start, 2), "faces": faces})
        t += every
    print(json.dumps({"width": W, "height": H, "samples": samples}))


if __name__ == "__main__":
    main()
