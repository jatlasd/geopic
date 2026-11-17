"""Local photographs and evidence on admitted references."""

import hashlib
import io
import json
import math
import os
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

PACKAGE = Path(__file__).resolve().parent
ROOT = PACKAGE.parent
ARCHIVE = ROOT / "phase-1"
SEED_RADIUS = 30
HOP_RADIUS = 65


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def distance_m(a, b):
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    term = math.sin((lat2 - lat1) / 2) ** 2
    term += math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6_371_008.8 * math.asin(min(1, math.sqrt(term)))


class Library:
    def __init__(self, state):
        self.state = state
        self.uploads = state / "uploads"
        self.uploads.mkdir(parents=True, exist_ok=True)
        self.archive_photos = {file.stem: file for file in sorted((ARCHIVE / "photos").glob("P*.jpg"))}
        self.seeds = {
            photo_id: {
                "id": photo_id, "method": "archive seed", "radius_m": SEED_RADIUS,
                "depth": 0, "chain": [photo_id], **position,
            }
            for photo_id, position in read_json(PACKAGE / "seeds.json").items()
        }
        self.review = read_json(PACKAGE / "reviewed-regions.json")
        with closing(self.connect()) as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS admitted (
                    id TEXT PRIMARY KEY, parent TEXT NOT NULL, record TEXT NOT NULL
                )
            """)
            db.commit()

    def connect(self):
        return sqlite3.connect(self.state / "references.sqlite3", timeout=10)

    def photos(self):
        return {
            **self.archive_photos,
            **{file.stem: file for file in sorted(self.uploads.glob("U*.jpg"))},
        }

    def references(self, db=None):
        if db is None:
            with closing(self.connect()) as connection:
                return self.references(connection)
        extra = {
            photo_id: json.loads(record)
            for photo_id, record in db.execute("SELECT id, record FROM admitted ORDER BY rowid")
        }
        return {**self.seeds, **extra}

    def estimate(self, query, reference):
        return {
            "id": query,
            "parent": reference["id"],
            "place": reference["place"],
            "center": reference["center"],
            "radius_m": reference["radius_m"] + HOP_RADIUS,
            "depth": reference["depth"] + 1,
            "chain": [*reference["chain"], query],
        }

    def admit(self, query, reference, decision):
        with closing(self.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            current = self.references(db)
            if query in current:
                raise ValueError(f"{query} is already an active reference.")
            parent = current.get(reference)
            if parent is None or parent != decision.pop("parent_snapshot"):
                raise ValueError("The parent reference changed. Rerun the comparison.")
            record = {
                **self.estimate(query, parent), **decision,
                "admitted_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            db.execute(
                "INSERT INTO admitted VALUES (?, ?, ?)", (query, reference, json.dumps(record))
            )
        return record

    def drop(self, photo_id):
        if photo_id in self.seeds:
            raise ValueError("Archive seeds cannot be removed.")
        with closing(self.connect()) as db, db:
            db.execute("""
                WITH RECURSIVE branch(id) AS (
                    SELECT id FROM admitted WHERE id = ?
                    UNION ALL
                    SELECT admitted.id FROM admitted JOIN branch ON admitted.parent = branch.id
                )
                DELETE FROM admitted WHERE id IN (SELECT id FROM branch)
            """, (photo_id,))

    def upload(self, raw):
        try:
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in ("JPEG", "PNG", "WEBP"):
                    raise ValueError("Choose a JPEG, PNG, or WebP photo.")
                if source.width * source.height > 36_000_000:
                    raise ValueError("Choose a photo under 36 megapixels.")
                photo = ImageOps.exif_transpose(source).convert("RGB")
        except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
            raise ValueError("The file could not be decoded as a photo.") from error
        if min(photo.size) < 64:
            raise ValueError("Use a photo at least 64 pixels wide and tall.")

        for photo_id, path in self.archive_photos.items():
            if path.read_bytes() == raw:
                return photo_id
        photo.thumbnail((1600, 1600), Image.Resampling.LANCZOS)
        fingerprint = hashlib.sha256(repr(photo.size).encode() + photo.tobytes()).hexdigest()
        photo_id = "U" + fingerprint[:12]
        target = self.uploads / f"{photo_id}.jpg"
        if target.exists():
            return photo_id
        with tempfile.NamedTemporaryFile(suffix=".tmp", dir=self.uploads, delete=False) as temporary:
            temporary_path = Path(temporary.name)
        try:
            photo.save(temporary_path, "JPEG", quality=93)
            os.replace(temporary_path, target)
        finally:
            temporary_path.unlink(missing_ok=True)
        return photo_id


def reveal_archive(photo_id):
    """Evaluation-only entry point. The matcher never reads this catalog."""
    for entry in read_json(ARCHIVE / "catalog.json"):
        if entry["id"] == photo_id:
            return {
                "view": entry["view"],
                "date": entry["date"],
                "center": entry["archive_pin_wgs84"],
                "source": entry["source"],
            }
    return None
