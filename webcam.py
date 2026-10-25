"""Finds the exact border of a streamer's webcam box, given the face inside it.

Usage: python webcam.py <video> <start s> <end s> <face x> <face y> <face w> <face h>
Prints JSON: {"box": {"x","y","w","h"} or null, "sides": [left, top, right, bottom line strengths, or "edge"]}

The webcam box sits in the same place for the whole stream while the game behind it keeps changing, so its border is
a sharp straight line in EVERY frame. Averaged over ~40 frames spread across the video, that line stands out
(measured on a real stream: about 20-45, while game and room edges average 2-10). Each side of the box is moved to the
strongest such line around the face; a side with no line there is the frame's edge. If the result doesn't look like a
webcam (no lines at all, odd shape), it answers null and the robot keeps its guess from the face.
"""
import json
import sys

import cv2
import numpy as np

SMALL = 320  # frames are compared at this width
LOOKS = 40


def main():
    video, start, end = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    fx, fy, fw, fh = (float(v) for v in sys.argv[4:8])
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit(f"can't open {video}")
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    s = SMALL / W
    SW, SH = SMALL, int(round(H * s))
    frames = []
    for i in range(LOOKS):
        cap.set(cv2.CAP_PROP_POS_MSEC, (start + (end - start) * (i + 0.5) / LOOKS) * 1000)
        ok, f = cap.read()
        if ok:
            frames.append(cv2.cvtColor(cv2.resize(f, (SW, SH), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
                          .astype(np.float32))
    if len(frames) < 10:
        return print(json.dumps({"box": None, "sides": []}))
    F = np.stack(frames)
    rows = np.zeros((SH, SW), np.float32)  # strength of a horizontal line through each pixel
    cols = np.zeros((SH, SW), np.float32)  # strength of a vertical line
    rows[1:-1] = np.abs(F[:, 2:] - F[:, :-2]).mean(axis=0)
    cols[:, 1:-1] = np.abs(F[:, :, 2:] - F[:, :, :-2]).mean(axis=0)
    cx, cy, w, h = (fx + fw / 2) * s, (fy + fh / 2) * s, fw * s, fh * s
    x0, x1, y0, y1 = cx - w, cx + w, cy - h, cy + h

    def coverage(side, v):
        # side: line strengths with the positions across axis 1 and the side's length along axis 0. How much of the
        # length has a clear line at v (stronger than the lines just inside and outside it)? The webcam border: ~0.9;
        # a straight edge in the streamer's room (a shelf, a light strip): ~0.15.
        here = side[:, v]
        before = np.median(side[:, max(0, v - 8):max(1, v - 2)], axis=1)
        after = np.median(side[:, v + 3:v + 9], axis=1) if v + 3 < side.shape[1] else np.zeros_like(here)
        # (the side towards a busy chat box can be almost as lined as the border, so that side only needs beating)
        return float(np.mean((here > 2 * np.minimum(before, after) + 2) & (here > 1.15 * np.maximum(before, after))))

    def best(side, lo, hi, frame_edge, centre):
        # the full-length line nearest the face (chat boxes further out make lines too); none: the frame edge
        found = [(coverage(side, v), v) for v in range(max(1, int(lo)), min(int(hi), side.shape[1] - 1))]
        found = [f for f in found if f[0] >= 0.6]
        if not found:
            return (0.0, frame_edge)
        pick = min(found, key=lambda f: abs(f[1] - centre))
        return pick if abs(pick[1] - frame_edge) > 3 else (pick[0], frame_edge)  # a hair from the frame edge: the edge

    for _ in range(3):  # each side depends on the others' span, so settle them in a few rounds
        a, b = int(max(0, y0)), int(min(SH, y1))
        left = best(cols[a:b], 1, cx - 0.55 * w, 0, cx)
        right = best(cols[a:b], cx + 0.55 * w, SW - 1, SW, cx)
        x0, x1 = left[1], right[1]
        a, b = int(max(0, x0)), int(min(SW, x1))
        upper = best(rows[:, a:b].T, 1, cy - 0.55 * h, 0, cy)
        lower = best(rows[:, a:b].T, cy + 0.55 * h, SH - 1, SH, cy)
        y0, y1 = upper[1], lower[1]

    sides = [round(v[0], 2) if v[1] not in (0, SW, SH) else "edge" for v in (left, upper, right, lower)]
    bw, bh = (x1 - x0) / SW, (y1 - y0) / SH
    lines = sum(1 for v in sides if v != "edge")
    looks_right = lines >= 2 and 0.08 < bw < 0.6 and 0.1 < bh < 0.7 and 0.6 < (bw * W) / (bh * H) < 2.6
    box = {"x": round(x0 / s), "y": round(y0 / s), "w": round((x1 - x0) / s), "h": round((y1 - y0) / s)} if looks_right else None
    print(json.dumps({"box": box, "sides": sides}))


if __name__ == "__main__":
    main()
