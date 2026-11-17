# Historical photo geolocation lab

The lab searches the [24 approved Chinatown photographs](phase-1/review.html) and any photos you upload. It runs on the local CPU. The four seed references are P01–P04.

## Run on Windows

Double-click **Open Lab.cmd** in the Geo folder. It opens [localhost:8765](http://localhost:8765/) in your default browser and starts the server if needed. If a terminal window stays open, keep it open while using the lab.

For first-time setup on another machine, use PowerShell with Python 3.11 installed.

~~~powershell
.\setup.ps1
.\.venv\Scripts\python.exe -m geolab
~~~

Setup installs the Python packages, downloads about 52 MB of matching weights with pinned checksums, and fetches the 24 cataloged scans directly from OpenSFHistory into the local photo folder. After setup, matching runs offline. If Python is outside your PATH, pass its full executable path with the setup script’s **-PythonPath** parameter. [Archive photo use and credits](https://opensfhistory.org/reproduction.php)

**All photos** is the full collection. Select any photo there to search for it. **Reference network** lists the photos it will search against. The trial starts with four known locations. P05 joins the references after a visual review, and the remaining archive locations stay hidden during matching.

## Inspect the P06 run

1. Select **P06** and open **Starting references (4)**. The best candidate was P03, with 14 inliers and an unresolved result.
2. If P05 is absent from the reference network, click **Review P05 for admission**. Compare the marked faces of the corner at 900 Grant. **Admit P05 and test P06** saves the manual review and inherits the seed’s location. In the automated seed run, the P01–P05 pair had only six inliers in its strongest fit.
3. Open **With reviewed additions (5)**. P05 produced 60 inliers from 191 proposed points. **Zoom to regions** shows the shared façades, and hovering over a point highlights its partner in the other photo. The reference network shows the supporting path P01 → P05 → P06.
4. Check **Withhold 744 Washington from P05** to remove descriptors whose keypoints are centered inside the marked region. The strongest surviving fit had 24 inliers, so P05 still supported P06. This intervention measures the contribution of that region while allowing other scene overlap.
5. **Reveal archive location** opens the evaluator’s held-back record. The estimated center came from P01, about 44 m from P06’s archive pin at Wentworth Place. The lab uses a 160 m search radius at that depth. The radius is an uncalibrated heuristic and the estimate is at neighborhood scale.

Select a photo to rerun the comparison, or use **Add photo** for a JPEG, PNG, or WebP. Inspect the regions before confirming a candidate as a reference. Clicking an admitted reference in the network opens its saved evidence. Removing it also removes decisions that depend on it. The **Starting references** run is always available.

## How it works

- SuperPoint extracts local descriptors from image pixels. A FLANN index votes for candidate references and their most relevant cells in a 4×3 grid. The lab verifies up to eight reference images per query.
- LightGlue proposes point correspondences. OpenCV fits local homographies and shows their bounds and inliers. The current support rule uses 20 inliers, a minimum spread, and a projection-error check. Repeated windows, signs, and landmarks can still create convincing fits. A person confirms every admission.
- The location estimate inherits the reference center and adds 65 m of search radius for each hop. The map shows that search area. It has no recovered camera pose or façade coordinates.
- Only the seed positions, pixels, and saved admissions enter the comparison. The full archive catalog is read by the separate **Reveal archive location** action. The extraction pass ignores the outer scan border and the bottom strip to reduce archive watermark and caption matches.
- The local SQLite database keeps the reviewed parent, evidence, inherited location, and timestamp for each admission. It lives in **.geo/references.sqlite3** alongside the upload directory and model weights.

The P06 run measures a single, visually selected case with assisted admission of its bridge. The rest of the dataset is available for the broader evaluation. [Matching models and export](https://github.com/fabio-sim/LightGlue-ONNX/releases/tag/v0.1.0) · [OpenCV feature matching and homography](https://docs.opencv.org/4.x/d1/de0/tutorial_py_feature_homography.html)
