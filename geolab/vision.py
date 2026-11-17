"""Pixel-only regional retrieval and geometric verification."""

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from threading import Lock

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

MAX_VERIFIED_REFERENCES = 8
MIN_SUPPORT = 20
MAX_PLANES = 3


@dataclass
class Features:
    xy: np.ndarray
    model_xy: np.ndarray
    descriptors: np.ndarray
    size: tuple[int, int]

    def keep(self, mask):
        return Features(self.xy[mask], self.model_xy[mask], self.descriptors[mask], self.size)


class Vision:
    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        self.lock = Lock()

    @lru_cache(maxsize=1)
    def models(self):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        return tuple(
            ort.InferenceSession(
                str(self.model_dir / name), options, providers=["CPUExecutionProvider"]
            )
            for name in ("superpoint.onnx", "lightglue.onnx")
        )

    @lru_cache(maxsize=96)
    def features(self, path: Path):
        extractor, _ = self.models()
        with Image.open(path) as image:
            gray = np.array(ImageOps.exif_transpose(image).convert("L"))
        height, width = gray.shape
        resized_h, resized_w = (
            max(8, round(value * 896 / max(gray.shape) / 8) * 8) for value in gray.shape
        )
        resized = cv2.resize(gray, (resized_w, resized_h), interpolation=cv2.INTER_AREA)
        tensor = resized.astype(np.float32)[None, None] / 255
        points, scores, descriptors = extractor.run(None, {"image": tensor})
        points = points[0].astype(np.float32)
        size = np.array([resized_w, resized_h], dtype=np.float32)
        xy = (points + 0.5) / size
        model_xy = (points - size / 2) / (max(size) / 2)
        # Ignore scan borders and the bottom strip containing archive marks and captions.
        keep = (scores[0] > 0) & (xy[:, 0] > .025) & (xy[:, 0] < .975)
        keep &= (xy[:, 1] > .025) & (xy[:, 1] < .90)
        return Features(xy[keep], model_xy[keep], descriptors[0, keep], (width, height))

    def reference_features(self, path, exclusion):
        features = self.features(path)
        if exclusion is None:
            return features
        x1, y1, x2, y2 = exclusion
        x, y = features.xy.T
        inside = (x >= x1) & (x <= x2) & (y >= y1) & (y <= y2)
        return features.keep(~inside)

    @staticmethod
    def cell_indices(features):
        return (features.xy[:, 1] * 3).astype(int) * 4 + (features.xy[:, 0] * 4).astype(int)

    def regions(self, path):
        with self.lock:
            cells = self.cell_indices(self.features(path))
        return [
            {"box": cell_box(cell), "keypoints": int(count)}
            for cell, count in enumerate(np.bincount(cells, minlength=12))
            if count >= 12
        ]

    @lru_cache(maxsize=6)
    def index(self, references):
        descriptors = []
        owners = []
        cells = []
        for number, (path, exclusion) in enumerate(references):
            features = self.reference_features(path, exclusion)
            if not len(features.xy):
                continue
            descriptors.append(features.descriptors)
            owners.extend([number] * len(features.xy))
            cells.extend(self.cell_indices(features))
        if not descriptors:
            return None
        vectors = np.ascontiguousarray(np.concatenate(descriptors), dtype=np.float32)
        index = cv2.flann_Index(vectors, {"algorithm": 1, "trees": 4})
        return index, vectors, np.array(owners), np.array(cells)

    def shortlist(self, query, references):
        indexed = self.index(references)
        if indexed is None or not len(query.xy):
            return []
        index, vectors, owners, cells = indexed
        indices, distances = index.knnSearch(
            np.ascontiguousarray(query.descriptors), min(4, len(vectors)), params={"checks": 32}
        )
        votes = np.zeros((len(references), 12))
        for rank in range(indices.shape[1]):
            selected = indices[:, rank]
            weights = np.exp(-3 * distances[:, rank]) / (rank + 1)
            np.add.at(votes, (owners[selected], cells[selected]), weights)
        strength = votes.max(axis=1) + 0.25 * votes.sum(axis=1)
        return [
            (int(i), round(float(strength[i]), 2), cell_box(int(votes[i].argmax())))
            for i in np.argsort(-strength, kind="stable")[:MAX_VERIFIED_REFERENCES]
        ]

    @lru_cache(maxsize=512)
    def pair(self, query_path, reference_path, exclusion):
        source = self.features(query_path)
        target = self.reference_features(reference_path, exclusion)
        if min(len(source.xy), len(target.xy)) < 8:
            return {"putative": 0, "regions": [], "level": "none", "inliers": 0}
        _, matcher = self.models()
        matches, _, scores, _ = matcher.run(None, {
            "kpts0": source.model_xy[None],
            "kpts1": target.model_xy[None],
            "desc0": source.descriptors[None],
            "desc1": target.descriptors[None],
        })
        valid = matches[0] >= 0
        query = source.xy[valid]
        reference = target.xy[matches[0, valid]]
        confidence = scores[0, valid]
        support = planes(query, reference, confidence, source.size, target.size)
        highest = support[0] if support else None
        return {
            "putative": int(valid.sum()),
            "regions": support,
            "level": highest["level"] if highest else "none",
            "inliers": highest["inliers"] if highest else 0,
        }

    def search(self, query_path, references):
        """A reference is an ID, a pixel path and an optional withheld region."""
        with self.lock:
            candidates = []
            indexed = tuple((path, exclusion) for _, path, exclusion in references)
            for number, vote, box in self.shortlist(self.features(query_path), indexed):
                photo_id, path, exclusion = references[number]
                evidence = self.pair(query_path, path, exclusion)
                candidates.append({
                    "reference": photo_id, "votes": vote, "retrieved_box": box, **evidence
                })
        return sorted(
            candidates,
            key=lambda item: (item["level"] == "supported", item["inliers"], item["votes"]),
            reverse=True,
        )


def cell_box(cell):
    column, row = cell % 4, cell // 4
    return [column / 4, row / 3, (column + 1) / 4, (row + 1) / 3]


def bounds(points):
    lower = np.maximum(points.min(axis=0) - .018, 0)
    upper = np.minimum(points.max(axis=0) + .018, 1)
    return np.round(np.r_[lower, upper], 5).tolist()


def spread(points):
    hull = cv2.convexHull(points.astype(np.float32))
    return float(cv2.contourArea(hull))


def planes(query, reference, scores, query_size, reference_size):
    putative = len(query)
    regions = []
    for _ in range(MAX_PLANES):
        if len(query) < 7:
            break
        source = query * query_size
        target = reference * reference_size
        pixel_limit = max(2.5, 4 * max(reference_size) / 1000)
        transform, mask = cv2.findHomography(
            source, target, cv2.USAC_MAGSAC, pixel_limit, maxIters=5000, confidence=.999
        )
        if transform is None or mask is None:
            break
        mask = mask.ravel().astype(bool)
        if mask.sum() < 5:
            break
        projected = cv2.perspectiveTransform(source[mask, None], transform).reshape(-1, 2)
        residual = np.linalg.norm(projected - target[mask], axis=1)
        inliers = int(mask.sum())
        q, r = query[mask], reference[mask]
        median_error = float(np.median(residual))
        covered_area = min(spread(q), spread(r))
        level = "tentative"
        if inliers >= MIN_SUPPORT and covered_area >= .0015 and median_error <= pixel_limit:
            level = "supported"
        # Preserve evidence even below the support rule so the reviewer can inspect failures.
        points = np.column_stack([q, r])
        ordered = np.argsort(-scores[mask], kind="stable")[:100]
        regions.append({
            "level": level,
            "inliers": inliers,
            "fraction": round(inliers / putative, 3),
            "median_error": round(median_error, 2),
            "query_box": bounds(q),
            "reference_box": bounds(r),
            "points": np.round(points[ordered], 5).tolist(),
        })
        query, reference, scores = query[~mask], reference[~mask], scores[~mask]
    return sorted(regions, key=lambda region: (region["level"] == "supported", region["inliers"]), reverse=True)
