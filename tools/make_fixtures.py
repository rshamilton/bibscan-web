"""Generate the parity fixtures from the original bibscan (Python) project.

The Node tests compare this port against the reference implementation:

* synthetic frames rendered by bibscan's own generator (with neutral artwork -
  no real race or sponsor names),
* what bibscan's reader (RapidOCR on onnxruntime) finds in each of them,
* the detector's raw probability map for one frame, with RapidOCR's boxes,
* OpenCV's output for every image operation the port reimplements.

Run it with the original project's virtualenv:

    /path/to/bibscan/.venv/bin/python tools/make_fixtures.py --bibscan /path/to/bibscan
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "tests" / "fixtures"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bibscan", required=True, help="path to the bibscan project")
    args = ap.parse_args()
    sys.path.insert(0, args.bibscan)

    import cv2
    from PIL import Image, ImageDraw

    from bibscan import config, synth
    from bibscan.ocr import BibReader, enhance

    def render_bib(number, width=420, height=300, event="BIBSCAN DEMO", accent=(44, 49, 79)):
        img = Image.new("RGB", (width, height), (252, 251, 248))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, width - 1, int(height * 0.20)], fill=accent[::-1])
        head = synth._font(max(12, int(height * 0.11)))
        tw = d.textlength(event, font=head)
        d.text(((width - tw) / 2, int(height * 0.04)), event, font=head, fill=(255, 255, 255))
        size = int(height * 0.60)
        while size > 10:
            f = synth._font(size)
            box = d.textbbox((0, 0), number, font=f)
            if box[2] - box[0] <= width * 0.86 and box[3] - box[1] <= height * 0.52:
                break
            size -= 4
        f = synth._font(size)
        box = d.textbbox((0, 0), number, font=f)
        d.text(((width - (box[2] - box[0])) / 2 - box[0], int(height * 0.26)), number, font=f, fill=(17, 17, 17))
        foot = synth._font(max(10, int(height * 0.075)))
        tag = "DEMO ROAD RACE"
        tw = d.textlength(tag, font=foot)
        d.text(((width - tw) / 2, int(height * 0.855)), tag, font=foot, fill=(90, 90, 96))
        return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    synth.render_bib = render_bib
    P = synth.SynthParams
    frames: list[tuple[str, str | None, np.ndarray]] = []

    # A runner crossing the frame: position, angle and size all change.
    for i in range(4):
        p = P(yaw=6 + 4 * i, pitch=3, roll=4 - i, scale=0.70 + 0.06 * i,
              offset_x=-0.18 + 0.11 * i, offset_y=0.04 * i, jpeg_quality=92)
        frames.append((f"cross_1147_{i}", "1147", synth.synth_frame("1147", p, seed=100 + i, bg_seed=7)[0]))
    # Angled and motion-blurred.
    for i in range(5):
        p = P(yaw=34 - 3 * i, pitch=-15 + i, roll=16 - 2 * i, scale=0.52 + 0.04 * i,
              offset_x=-0.2 + 0.1 * i, offset_y=-0.05 + 0.03 * i, blur_len=9, jpeg_quality=80)
        frames.append((f"angled_1203_{i}", "1203", synth.synth_frame("1203", p, seed=200 + i, bg_seed=7)[0]))
    # Parked in the same pixels: a sign, not a runner, if it stays there.
    frames.append(("static_1188", "1188", synth.synth_frame("1188", P(yaw=4, scale=0.8, jpeg_quality=92), seed=11, bg_seed=7)[0]))
    # Scenery with signage text and no bib at all.
    frames.append(("signage", None, synth.background((1280, 720), True, random.Random(7))))
    # A mixed bag of difficulties from the demo roster's bib range.
    rng = random.Random(42)
    for k, bib in enumerate(["1004", "1099", "1256", "1512", "1618", "1300"]):
        p = synth.random_params(rng, "mixed")
        p.noise = 0.0  # keeps the lossless fixtures small; blur, angle and JPEG stay
        frames.append((f"mixed_{bib}", bib, synth.synth_frame(bib, p, seed=rng.randrange(1 << 30), bg_seed=7)[0]))

    cfg = config.load(Path(args.bibscan) / "config.toml")
    reader = BibReader(cfg.ocr)

    (OUT / "frames").mkdir(parents=True, exist_ok=True)
    ref: dict = {"config": {"ocr": cfg.ocr.__dict__}, "frames": {}}
    for name, bib, img in frames:
        cv2.imwrite(str(OUT / "frames" / f"{name}.png"), img, [cv2.IMWRITE_PNG_COMPRESSION, 9])
        png = cv2.imread(str(OUT / "frames" / f"{name}.png"))
        quads = reader._detect(png, cfg.ocr.det_long_side)
        readings = reader.read(png)
        ref["frames"][name] = {
            "bib": bib,
            "det_quads": [np.asarray(q).round(2).tolist() for q in quads],
            "readings": [{"text": r.text, "conf": round(r.conf, 4), "quad": r.quad.round(2).tolist()} for r in readings],
        }
        print(f"{name:16} {bib!s:5} -> {[r.text for r in readings]}")

    # Raw detector output for one frame, and what RapidOCR makes of it.
    name, _, img = frames[1]
    png = cv2.imread(str(OUT / "frames" / f"{name}.png"))
    h, w = png.shape[:2]
    scale = min(1.0, cfg.ocr.det_long_side / max(h, w))
    small = cv2.resize(png, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    det = reader._det
    det.preprocess_op = det.get_preprocess(max(small.shape[:2]))
    prep = det.preprocess_op(small)
    pred = det.infer(prep)[0]
    boxes, scores = det.postprocess_op(pred, small.shape[:2])
    boxes = det.filter_tag_det_res(boxes, small.shape[:2])
    pred[0, 0].astype("<f4").tofile(OUT / "det_map.f32")
    ref["dbpost"] = {
        "frame": name,
        "map_w": int(pred.shape[3]), "map_h": int(pred.shape[2]),
        "dest_w": int(small.shape[1]), "dest_h": int(small.shape[0]),
        "box_thresh": det.postprocess_op.box_thresh, "unclip_ratio": det.postprocess_op.unclip_ratio,
        "boxes": np.asarray(boxes).tolist(),
        "scores": [round(float(s), 5) for s in scores],
        "input": [int(prep.shape[2]), int(prep.shape[3])],
    }

    # OpenCV's answer for each image operation the port reimplements.
    r = np.random.default_rng(7)
    src = cv2.GaussianBlur(r.integers(0, 256, (41, 57, 3), dtype=np.uint8), (3, 3), 0)
    M = np.array([[0.9, 0.12, 3.5], [-0.08, 1.05, 2.0], [0.0009, -0.0006, 1.0]], np.float64)
    quad = np.array([[6.2, 4.1], [49.7, 8.3], [47.9, 33.6], [4.4, 30.2]], np.float32)
    gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    rgb = lambda a: cv2.cvtColor(a, cv2.COLOR_BGR2RGB).tolist()  # noqa: E731
    ref["cv"] = {
        "src": rgb(src),
        "resize_linear_61x17": rgb(cv2.resize(src, (61, 17))),
        "resize_linear_90x70": rgb(cv2.resize(src, (90, 70))),
        "resize_area_fx0.37": rgb(cv2.resize(src, None, fx=0.37, fy=0.37, interpolation=cv2.INTER_AREA)),
        "resize_cubic_80x64": rgb(cv2.resize(src, (80, 64), interpolation=cv2.INTER_CUBIC)),
        "matrix": M.tolist(),
        "warp_linear_constant_50x40": rgb(cv2.warpPerspective(src, M, (50, 40))),
        "warp_cubic_replicate_50x40": rgb(cv2.warpPerspective(src, M, (50, 40), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)),
        "quad": quad.tolist(),
        "perspective_to_40x28": cv2.getPerspectiveTransform(quad, np.array([[0, 0], [40, 0], [40, 28], [0, 28]], np.float32)).tolist(),
        "lab": cv2.cvtColor(src, cv2.COLOR_BGR2LAB).tolist(),
        "gray": gray.tolist(),
        "clahe_gray": cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray).tolist(),
        "enhance": rgb(enhance(src)),
    }
    # enhance() on the kind of crop bibscan actually retries: a bib warped upright
    # and enlarged to 64px high. (On a tiny image CLAHE's tiles hold ~35 pixels,
    # so a one-level rounding difference in Lab L moves the result several levels.)
    bib_read = next(r for r in ref["frames"]["cross_1147_1"]["readings"] if r["text"] == "1147")
    qx = [p[0] for p in bib_read["quad"]]
    qy = [p[1] for p in bib_read["quad"]]
    frame_png = cv2.imread(str(OUT / "frames" / "cross_1147_1.png"))
    x0, x1 = int(min(qx)) - 8, int(max(qx)) + 8
    y0, y1 = int(min(qy)) - 8, int(max(qy)) + 8
    region = frame_png[max(0, y0):y1, max(0, x0):x1]
    crop = cv2.resize(region, (round(region.shape[1] * 64 / region.shape[0]), 64), interpolation=cv2.INTER_CUBIC)
    ref["cv"]["crop"] = rgb(crop)
    ref["cv"]["enhance_crop"] = rgb(enhance(crop))

    (OUT / "reference.json").write_text(json.dumps(ref, separators=(",", ":")))
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
