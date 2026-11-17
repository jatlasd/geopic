import argparse
import json
import os
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from flask import Flask, abort, jsonify, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.serving import make_server

from .library import Library, PACKAGE, ROOT, distance_m, reveal_archive
from .vision import Vision


def create_app(state=ROOT / ".geo", model_dir=None):
    app = Flask(__name__, static_folder=str(PACKAGE / "web"), static_url_path="/static")
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024
    library = Library(Path(state))
    models = Path(model_dir) if model_dir else ROOT / ".geo" / "models"
    vision = Vision(models)

    @app.errorhandler(ValueError)
    def invalid(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(RequestEntityTooLarge)
    def too_large(_):
        return jsonify(error="Choose a photo smaller than 16 MB."), 413

    @app.get("/")
    def index():
        return app.send_static_file("index.html")

    @app.get("/api/library")
    def list_photos():
        return jsonify(
            photos=list(library.photos()), references=library.references(),
            reviewed_regions=library.review, models_ready=all(
                (models / name).is_file() for name in ("superpoint.onnx", "lightglue.onnx")
            ),
        )

    @app.get("/photo/<photo_id>")
    def photo(photo_id):
        file = library.photos().get(photo_id)
        if file is None:
            abort(404)
        return send_file(file, mimetype="image/jpeg", conditional=True)

    @app.post("/api/photos")
    def upload():
        file = request.files.get("photo")
        if not file:
            raise ValueError("Choose a JPEG, PNG, or WebP photo.")
        return jsonify(id=library.upload(file.read()))

    @app.get("/api/regions/<photo_id>")
    def regions(photo_id):
        path = library.photos().get(photo_id)
        if path is None:
            abort(404)
        assert_models(models)
        return jsonify(regions=vision.regions(path))

    @app.post("/api/compare")
    def compare():
        data = request.get_json()
        query = data.get("query")
        photos = library.photos()
        if query not in photos:
            raise ValueError("Select a photo in the collection.")
        assert_models(models)
        all_references = library.references()
        baseline = run_search(vision, library, query, photos, library.seeds)
        expanded = baseline if all_references == library.seeds else run_search(
            vision, library, query, photos, all_references
        )
        result = {"query": query, "baseline": baseline, "expanded": expanded}
        if data.get("withhold"):
            region = library.review["withheld_region"]
            if region["photo"] in all_references and region["photo"] != query:
                result["withheld"] = run_search(
                    vision, library, query, photos, all_references,
                    (region["photo"], tuple(region["box"])),
                )
        return jsonify(result)

    @app.post("/api/references")
    def admit():
        data = request.get_json()
        query, parent = data.get("query"), data.get("reference")
        photos, refs = library.photos(), library.references()
        if query not in photos or parent not in refs or query == parent:
            raise ValueError("Select a query and an active reference.")
        option = data.get("method")
        hint = library.review["bridge_review"]
        if option == "reviewed regions":
            if (query, parent) != (hint["query"], hint["reference"]):
                raise ValueError("This reviewed pair is unavailable.")
            evidence = {key: hint[key] for key in ("query_box", "reference_box", "note")}
        else:
            assert_models(models)
            number = data.get("region", 0)
            with vision.lock:
                pair = vision.pair(photos[query], photos[parent], None)
            if not isinstance(number, int) or not 0 <= number < len(pair["regions"]):
                raise ValueError("Select a match with inspectable regions.")
            evidence = pair["regions"][number]
            if option == "reviewed geometry":
                if evidence["level"] != "supported":
                    raise ValueError("This match requires a written visual review.")
            elif option == "manual confirmation":
                note = str(data.get("note", "")).strip()
                if not 8 <= len(note) <= 600:
                    raise ValueError("Describe the shared structure in 8–600 characters.")
                evidence = {**evidence, "note": note}
            else:
                raise ValueError("Choose a review method.")
        record = library.admit(query, parent, {
            "method": option, "evidence": evidence, "parent_snapshot": refs[parent]
        })
        return jsonify(reference=record)

    @app.delete("/api/references/<photo_id>")
    def drop(photo_id):
        library.drop(photo_id)
        return jsonify(references=library.references())

    @app.get("/api/reveal/<photo_id>")
    def reveal(photo_id):
        truth = reveal_archive(photo_id)
        if truth is None:
            return jsonify(error="No archive location is available for this upload."), 404
        return jsonify(truth)

    return app


def assert_models(models):
    if any(not (models / name).is_file() for name in ("superpoint.onnx", "lightglue.onnx")):
        raise ValueError("Matching weights are missing. Run setup.ps1 and restart the lab.")


def run_search(vision, library, query, photos, references, exclusion=None):
    inputs = tuple(
        (ref_id, photos[ref_id], exclusion[1] if exclusion and exclusion[0] == ref_id else None)
        for ref_id in references if ref_id != query and ref_id in photos
    )
    candidates = vision.search(photos[query], inputs)
    supported = [candidate for candidate in candidates if candidate["level"] == "supported"]
    estimate, status = None, "unresolved"
    if supported:
        first = supported[0]
        parent = references[first["reference"]]
        competing = any(
            match["inliers"] >= .75 * first["inliers"]
            and distance_m(parent["center"], references[match["reference"]]["center"])
            > max(parent["radius_m"], references[match["reference"]]["radius_m"])
            for match in supported[1:]
        )
        status = "competing" if competing else "supported"
        if not competing:
            estimate = library.estimate(query, parent)
    return {
        "status": status, "estimate": estimate, "anchors": [row[0] for row in inputs],
        "candidates": candidates,
    }


def main():
    parser = argparse.ArgumentParser(description="Run the local photo geolocation lab.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true", help="Open the lab in the default browser.")
    args = parser.parse_args()
    url = f"http://localhost:{args.port}/"
    if args.open and lab_running(args.port):
        webbrowser.open(url)
        return
    state = Path(os.environ.get("GEO_LAB_STATE", ROOT / ".geo"))
    app = create_app(state)
    if args.open:
        with make_server("127.0.0.1", args.port, app, threaded=True) as server:
            print(f"Photo lab is running at {url}. Keep this window open.", flush=True)
            webbrowser.open(url)
            server.serve_forever()
    else:
        app.run(host="127.0.0.1", port=args.port, threaded=True)


def lab_running(port):
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/library", timeout=1) as response:
            data = json.load(response)
            return isinstance(data, dict) and {"photos", "references", "models_ready"} <= data.keys()
    except (URLError, TimeoutError, ValueError):
        return False


if __name__ == "__main__":
    main()
