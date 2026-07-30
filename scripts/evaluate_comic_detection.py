"""Run RT-DETR against the local comic detection evaluation manifest."""

import argparse
import base64
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from services.comic_detector import detect_regions
from services.comic_evaluation import DetectionMetrics, evaluate_detection


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Evaluate TabKeep comic region detection")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=BACKEND / "evaluation" / "comic" / "manifest.json",
    )
    parser.add_argument("--iou", type=float, default=0.5)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    cases: list[dict[str, Any]] = manifest.get("cases", [])
    if not cases:
        print(f"评估集为空，请先向 {args.manifest} 添加人工标注用例。")
        return 2

    total = DetectionMetrics(0, 0, 0)
    for case in cases:
        image_path = (args.manifest.parent / case["image"]).resolve()
        image_base64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
        predicted_models = detect_regions(image_base64, case.get("sourceLanguage", "auto"))
        predicted = [
            region.model_dump(by_alias=True)
            for region in predicted_models
        ]
        metrics = evaluate_detection(case["expectedRegions"], predicted, args.iou)
        total = DetectionMetrics(
            total.true_positive + metrics.true_positive,
            total.false_positive + metrics.false_positive,
            total.false_negative + metrics.false_negative,
        )
        print(
            f"{case['id']}: P={metrics.precision:.3f} "
            f"R={metrics.recall:.3f} F1={metrics.f1:.3f}"
        )

    print(
        f"TOTAL: P={total.precision:.3f} R={total.recall:.3f} F1={total.f1:.3f} "
        f"TP={total.true_positive} FP={total.false_positive} FN={total.false_negative}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
