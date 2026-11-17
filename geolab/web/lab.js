"use strict";

const el = id => document.getElementById(id);
const esc = text => String(text).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const photoUrl = id => "/photo/" + encodeURIComponent(id);
const svgNS = "http://www.w3.org/2000/svg";
const labels = {supported: "Supported overlap", unresolved: "Unresolved", competing: "Competing locations"};
const state = {
  library: null, query: "P06", comparison: null, mode: "baseline", busy: false, mutation: false,
  reference: null, region: 0, reviewed: false, saved: false, zoom: false, points: true, withhold: false,
  truth: null, sequence: 0, cells: {}, showCells: false, notice: "", error: false,
};
const imageSizes = new Map();

async function api(path, options = {}) {
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); }
  catch { throw new Error("The local server could not complete the request."); }
  if (!response.ok) throw new Error(data.error || "The request failed.");
  return data;
}

const json = data => ({
  method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data),
});
const result = () => state.comparison?.[state.mode] || null;
const candidate = () => result()?.candidates.find(item => item.reference === state.reference);
const hint = () => state.library?.reviewed_regions.bridge_review;
const isReviewedPair = () => state.reviewed && state.query === hint()?.query;
const savedLink = () => state.saved ? state.library.references[state.query] : null;
const inspectedReference = () => savedLink()?.parent || (isReviewedPair() ? hint().reference : state.reference);
const displayId = id => id.startsWith("U") ? id.slice(0, 7) : id;
const showChain = chain => chain.map(displayId).join(" → ");

function referenceCounts() {
  const refs = Object.values(state.library.references);
  const starting = refs.filter(ref => !ref.depth).length;
  return {starting, added: refs.length - starting, total: refs.length};
}

function notice(message = "", error = false) {
  state.notice = message;
  state.error = error;
}

function selectMode(mode) {
  state.mode = mode === "expanded" && !referenceCounts().added ? "baseline" : mode;
  state.reference = result()?.candidates[0]?.reference || null;
  state.region = 0;
  state.reviewed = false;
  state.saved = false;
  state.zoom = false;
}

async function compare(preferred = state.mode) {
  const generation = ++state.sequence;
  state.busy = true;
  state.comparison = null;
  state.reference = null;
  notice("Finding and verifying visual candidates…");
  render();
  try {
    const data = await api("/api/compare", json({query: state.query, withhold: state.withhold}));
    if (generation !== state.sequence) return;
    const {reviewed, saved} = state;
    state.comparison = data;
    selectMode(data[preferred] ? preferred : "expanded");
    state.reviewed = reviewed;
    state.saved = saved;
    notice("");
  } catch (error) {
    if (generation === state.sequence) notice(error.message, true);
  } finally {
    if (generation === state.sequence) {
      state.busy = false;
      render();
    }
  }
}

function choosePhoto(id, reviewed = false, saved = false) {
  if (state.mutation) return;
  state.query = id;
  state.truth = null;
  state.reviewed = reviewed;
  state.saved = saved;
  state.zoom = false;
  state.showCells = false;
  state.mode = referenceCounts().added ? "expanded" : "baseline";
  void compare();
}

function renderCollection() {
  const container = el("photos");
  const library = state.library;
  el("photo-count").textContent = library.photos.length + " photos";
  if (container.children.length !== library.photos.length) {
    container.innerHTML = library.photos.map(id =>
      '<button type="button" class="thumb" data-photo="' + esc(id) + '" title="' + esc(id) + '">' +
      '<img loading="lazy" alt="" src="' + photoUrl(id) + '"><span>' + esc(displayId(id)) + '<small></small></span></button>'
    ).join("");
  }
  for (const button of container.children) {
    const id = button.dataset.photo;
    button.setAttribute("aria-current", String(id === state.query));
    const reference = library.references[id];
    button.querySelector("small").textContent = reference ? (reference.depth ? "Added" : "Seed") : "";
    button.disabled = state.mutation;
  }
  if (container.scrollWidth > container.clientWidth) {
    const selected = container.querySelector('[aria-current="true"]');
    const outer = container.getBoundingClientRect();
    const inner = selected?.getBoundingClientRect();
    if (inner && inner.right > outer.right) container.scrollLeft += inner.right - outer.right + 5;
    if (inner && inner.left < outer.left) container.scrollLeft -= outer.left - inner.left + 5;
  }
}

function renderComparison() {
  el("query-title").textContent = "Search for " + displayId(state.query);
  el("truth-status").textContent = state.truth ? "Archive location revealed" :
    state.query.startsWith("P") ? "Archive location held back" : "Uploaded photo";
  const {starting, added, total} = referenceCounts();
  const comparison = state.comparison;
  const modes = [["baseline", "Starting references (" + starting + ")"]];
  if (added) modes.push(["expanded", "With reviewed additions (" + total + ")"]);
  if (comparison?.withheld) modes.push(["withheld", "With façade withheld"]);
  el("comparison").innerHTML = modes.map(([mode, label]) => {
    const value = comparison?.[mode];
    const best = value?.candidates[0];
    const detail = value ? labels[value.status] + (best ? " · " + best.inliers + " inliers" : "") :
      state.busy ? "Running…" : "Ready";
    return '<button type="button" data-mode="' + mode + '" aria-pressed="' + (state.mode === mode) + '"' +
      (value ? "" : " disabled") + "><strong>" + esc(label) + '</strong><span class="' +
      (value?.status || "") + '">' + esc(detail) + "</span></button>";
  }).join("");
  const bridge = state.library.references.P05;
  const button = el("review-bridge");
  button.hidden = !(state.query === "P05" || (state.query === "P06" && !bridge));
  button.textContent = state.query === "P05" ? (state.reviewed ? "Show automated candidates" : "Show reviewed P01–P05 regions") :
    "Review P05 for admission";
  button.disabled = state.mutation;
  el("withhold-option").hidden = !bridge || state.query === "P05";
  el("withhold").checked = state.withhold;
  el("withhold").disabled = state.busy || state.mutation;
  el("reveal").hidden = !state.query.startsWith("P");
  el("reveal").disabled = state.busy || !comparison || Boolean(state.truth);
  el("run").disabled = state.busy || state.mutation || !state.library.models_ready;
  const banner = el("notice");
  banner.textContent = state.notice;
  banner.classList.toggle("error", state.error);
  const truth = el("truth");
  truth.hidden = !state.truth;
  if (state.truth) {
    const location = result()?.estimate;
    const offset = location ? "<p>Approximate archive pin is " +
      Math.round(distance(location.center, state.truth.center)) + " m from the inherited center.</p>" : "";
    truth.innerHTML = "<p><strong>Archive location</strong> · " + esc(state.truth.view) + " · " +
      esc(state.truth.date) + '</p>' + offset +
      '<p><a href="' + esc(state.truth.source) + '" target="_blank" rel="noreferrer">Source record</a></p>';
  }
}

function renderCandidates() {
  const items = result()?.candidates || [];
  el("candidate-count").textContent = items.length || "";
  el("candidates").innerHTML = items.length ? items.map(item =>
    '<button class="candidate" type="button" data-reference="' + esc(item.reference) +
    '" aria-current="' + (!state.reviewed && !state.saved && item.reference === state.reference) +
    '"><img alt="" src="' + photoUrl(item.reference) + '"><span><strong>' + esc(displayId(item.reference)) +
    "</strong><span>" + (item.level === "supported" ? "Supported" : item.level === "tentative" ? "Tentative" : "No local fit") +
    " · " + item.inliers + " inliers</span></span></button>"
  ).join("") : '<p class="muted">' + (state.busy ? "Verifying shortlisted references…" : "No reference candidates to inspect.") + "</p>";
}

function svgElement(name, attributes) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function sizeFor(id) {
  if (!imageSizes.has(id)) {
    const promise = new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
      image.onerror = () => reject(new Error("Photo unavailable."));
      image.src = photoUrl(id);
    });
    imageSizes.set(id, promise);
  }
  return imageSizes.get(id);
}

async function drawPhoto(container, id, box, points, side, manual, cells, withheld) {
  const renderId = Symbol();
  container.photoRender = renderId;
  if (!id) {
    container.innerHTML = "<p>Select a candidate to compare two photos.</p>";
    return;
  }
  let size;
  try { size = await sizeFor(id); }
  catch {
    if (container.photoRender === renderId) container.innerHTML = "<p>Photo unavailable.</p>";
    return;
  }
  if (container.photoRender !== renderId) return;
  const [w, h] = size;
  let view = [0, 0, w, h];
  if (state.zoom && box) {
    const x1 = Math.max(0, box[0] - .05);
    const y1 = Math.max(0, box[1] - .06);
    const x2 = Math.min(1, box[2] + .05);
    const y2 = Math.min(1, box[3] + .06);
    view = [x1 * w, y1 * h, (x2 - x1) * w, (y2 - y1) * h];
  }
  const svg = svgElement("svg", {
    viewBox: view.join(" "), role: "img", "aria-label": id + (box ? " with matched region" : ""),
  });
  svg.append(svgElement("image", {href: photoUrl(id), x: 0, y: 0, width: w, height: h}));
  function drawBox(rect, style) {
    const [x0, y0, x1, y1] = rect;
    svg.append(svgElement("rect", {
      x: x0 * w, y: y0 * h, width: (x1 - x0) * w, height: (y1 - y0) * h,
      class: "region-frame " + style,
    }));
  }
  for (const cell of cells) drawBox(cell.box, "indexed");
  if (withheld) drawBox(withheld, "manual");
  if (box) drawBox(box, manual ? "manual" : "");
  if (state.points) {
    for (const [index, point] of points.entries()) {
      svg.append(svgElement("circle", {
        cx: point[side] * w, cy: point[side + 1] * h, r: Math.min(view[2], view[3]) / 100,
        class: "keypoint", "data-point": index,
      }));
    }
  }
  container.replaceChildren(svg);
}

function caption(id, role) {
  return role + (id ? " " + esc(displayId(id)) + ' <a href="' + photoUrl(id) +
    '" target="_blank" rel="noreferrer">Full scan</a>' : "");
}

function renderInspection() {
  const saved = savedLink();
  const manual = isReviewedPair() || Boolean(saved && saved.method === "reviewed regions");
  const pair = candidate();
  const region = saved?.evidence || (manual ? hint() : pair?.regions[state.region]);
  const reference = inspectedReference();
  const points = region?.points || [];
  el("pair-label").textContent = saved ? "Saved admission evidence" : reference ? (manual ? "Manually reviewed corner" :
    "LightGlue correspondence · geometric fit") : "Select a reference from the comparison.";
  el("query-caption").innerHTML = caption(state.query, "Query");
  el("reference-caption").innerHTML = caption(reference, "Reference");
  el("zoom").disabled = !region;
  el("zoom").setAttribute("aria-pressed", state.zoom);
  el("zoom").textContent = state.zoom ? "Fit full photos" : "Zoom to regions";
  el("points").disabled = !points.length;
  el("points").setAttribute("aria-pressed", state.points);
  el("regions").disabled = !reference;
  el("regions").setAttribute("aria-pressed", state.showCells);
  const exclusion = state.library.reviewed_regions.withheld_region;
  const withheld = !saved && state.mode === "withheld" && reference === exclusion.photo;
  drawPhoto(el("query-image"), state.query, region?.query_box, points, 0, manual, []);
  drawPhoto(el("reference-image"), reference, region?.reference_box, points, 2, manual,
    state.showCells ? state.cells[reference] || [] : [], withheld ? exclusion.box : null);
  const evidence = el("evidence");
  const admitted = state.library.references[state.query];
  let html = "";
  if (saved) {
    html = "<p>" + (region.note ? esc(region.note) : region.inliers + " geometric inliers at admission.") + "</p>";
    html += '<p><button type="button" id="current-matches">Return to the current comparison</button></p>';
  } else if (manual) {
    html = "<p>" + esc(region.note) +
      '</p><p class="muted">The outlines come from visual review. Admission inherits the seed location and records this review.</p>';
    if (!admitted) html += '<form id="admission"><button class="primary" type="submit"' +
      (state.mutation ? " disabled" : "") + ">Admit P05 and test P06</button></form>";
  } else if (region) {
    html = '<label for="region-select">Geometric region </label><select id="region-select">' +
      pair.regions.map((other, index) => '<option value="' + index + '"' + (index === state.region ? " selected" : "") +
        ">Region " + (index + 1) + " · " + other.inliers + " inliers</option>").join("") + "</select>";
    html += "<p><strong>" + region.inliers + "</strong> of " + pair.putative +
      " proposed points fit this region · " + region.median_error + " px median projection error.</p>";
    html += '<p class="muted">Inspect the structure before admitting a candidate. Similar windows, signs and repeating patterns can produce a fit.</p>';
    if (!admitted && state.mode !== "withheld") {
      html += '<form id="admission">' + (region.level === "supported" ? "" :
        '<input type="text" id="review-note" required minlength="8" maxlength="600" aria-label="Shared structure" placeholder="Describe the shared structure">') +
        '<button class="primary" type="submit"' + (state.mutation ? " disabled" : "") +
        ">Confirm and add reference</button></form>";
    }
  } else if (pair) {
    html = "<p>" + pair.putative + " proposed points. No stable region to inspect in this pair.</p>";
  }
  if (withheld) html += '<p class="muted">The dashed outline marks 744 Washington. Reference keypoints centered inside it were excluded.</p>';
  if (admitted && admitted.depth) html += '<p class="muted">Admitted via ' + esc(admitted.method) +
    " · " + esc(showChain(admitted.chain)) + ".</p>";
  evidence.innerHTML = html;
}

function distance(a, b) {
  const y = (a[0] - b[0]) * 111195;
  const x = (a[1] - b[1]) * 111195 * Math.cos(a[0] * Math.PI / 180);
  return Math.hypot(x, y);
}

function mapLayer(references, estimate) {
  const origin = references[0]?.center;
  if (!origin) return "";
  function xy(center) {
    return [(center[1] - origin[1]) * 111195 * Math.cos(origin[0] * Math.PI / 180),
      (origin[0] - center[0]) * 111195];
  }
  const points = references.filter(ref => !ref.depth).map(ref => ({ref, xy: xy(ref.center)}));
  let minX = Math.min(...points.map(point => point.xy[0])) - 42;
  let maxX = Math.max(...points.map(point => point.xy[0])) + 42;
  let minY = Math.min(...points.map(point => point.xy[1])) - 42;
  let maxY = Math.max(...points.map(point => point.xy[1])) + 42;
  const ring = estimate ? xy(estimate.center) : null;
  if (ring) {
    const radius = estimate.radius_m;
    minX = Math.min(minX, ring[0] - radius - 12);
    minY = Math.min(minY, ring[1] - radius - 12);
    maxX = Math.max(maxX, ring[0] + radius + 12);
    maxY = Math.max(maxY, ring[1] + radius + 12);
  }
  const scale = Math.min(220 / (maxX - minX), 125 / (maxY - minY));
  const project = ([x, y]) => [128 + (x - (maxX + minX) / 2) * scale, 75 + (y - (maxY + minY) / 2) * scale];
  let graphic = "";
  if (ring) {
    const [x, y] = project(ring);
    graphic += '<circle cx="' + x + '" cy="' + y + '" r="' + estimate.radius_m * scale +
      '" fill="#e4eee3" stroke="#507d63" stroke-dasharray="4 3"/>';
  }
  const labels = [];
  for (const point of points) {
    const [x, y] = project(point.xy);
    const group = labels.find(other => Math.hypot(x - other.x, y - other.y) < 11);
    if (group) group.ids.push(point.ref.id);
    else labels.push({x, y, ids: [point.ref.id]});
  }
  for (const label of labels) {
    graphic += '<circle cx="' + label.x + '" cy="' + label.y + '" r="3" fill="#20574a"/>' +
      '<text x="' + (label.x + 6) + '" y="' + (label.y + 3) + '">' + esc(label.ids.join(" / ")) + "</text>";
  }
  return '<svg class="map-svg" viewBox="0 0 256 153" role="img" aria-label="Approximate seed positions and search radius, north up">' +
    graphic + '<text x="11" y="17">N</text><path d="M14 21v12" stroke="#4e6250"/>' +
    '<path d="M11 24l3-3 3 3" fill="none" stroke="#4e6250"/></svg>';
}

function renderNetwork() {
  const refs = Object.values(state.library.references);
  const {starting, added, total} = referenceCounts();
  const run = result();
  const location = run?.estimate;
  el("reference-count").textContent = total + " references";
  el("reference-help").textContent = "The lab matches against " + starting + " starting photos" +
    (added ? " and " + added + " added after review." : ".");
  el("estimate").innerHTML = location ?
    '<div class="estimate"><p><strong>' + esc(location.place) + '</strong></p><p class="route">' +
    esc(showChain(location.chain)) + '</p><p class="muted">Inherited center · ' +
    location.radius_m + ' m search radius (heuristic)</p></div>' :
    '<div class="estimate"><p class="muted">' + (run?.status === "competing" ? "Strong candidates point to different areas." :
      "A supported overlap is needed for an estimate.") + "</p></div>";
  el("map").innerHTML = mapLayer(refs, location);
  const listed = [...refs].sort((a, b) => (b.depth > 0) - (a.depth > 0));
  el("references").innerHTML = listed.map(ref => '<li><div><button type="button" class="reference-link" data-open="' +
    esc(ref.id) + '" title="Inspect ' + esc(ref.id) + '">' + esc(displayId(ref.id)) + '</button><p class="muted">' +
    esc(ref.depth ? showChain(ref.chain) + " · " + ref.method : ref.place) +
    "</p></div>" + (ref.depth ? '<button type="button" data-remove="' + esc(ref.id) +
    '" title="Remove this reference and its descendants"' + (state.mutation ? " disabled" : "") + ">Remove</button>" :
    '<a class="muted" href="' + esc(ref.source) + '" target="_blank" rel="noreferrer">Source</a>') + "</li>").join("");
}

function render() {
  if (!state.library) {
    el("notice").textContent = state.notice;
    return;
  }
  el("workbench").setAttribute("aria-busy", state.busy);
  el("upload-button").disabled = state.mutation;
  renderCollection();
  renderComparison();
  renderCandidates();
  renderInspection();
  renderNetwork();
}

async function updateLibrary() {
  state.library = await api("/api/library");
}

el("photos").addEventListener("click", event => {
  const button = event.target.closest("[data-photo]");
  if (button) choosePhoto(button.dataset.photo);
});
el("comparison").addEventListener("click", event => {
  const button = event.target.closest("[data-mode]");
  if (!button) return;
  selectMode(button.dataset.mode);
  render();
  el("comparison").querySelector('[aria-pressed="true"]').focus();
});
el("candidates").addEventListener("click", event => {
  const button = event.target.closest("[data-reference]");
  if (!button) return;
  state.reviewed = false;
  state.saved = false;
  state.reference = button.dataset.reference;
  state.region = 0;
  state.zoom = false;
  state.showCells = false;
  render();
  el("candidates").querySelector('[aria-current="true"]').focus();
});
el("review-bridge").addEventListener("click", () => {
  if (state.query !== "P05") {
    choosePhoto("P05", true);
    return;
  }
  state.saved = false;
  state.reviewed = !state.reviewed;
  state.zoom = false;
  render();
});
el("run").addEventListener("click", () => compare());
el("withhold").addEventListener("change", event => {
  state.withhold = event.target.checked;
  void compare(state.withhold ? "withheld" : "expanded");
});
el("zoom").addEventListener("click", () => {
  state.zoom = !state.zoom;
  renderInspection();
});
el("points").addEventListener("click", () => {
  state.points = !state.points;
  renderInspection();
});
el("regions").addEventListener("click", async () => {
  const id = inspectedReference();
  if (!id) return;
  state.showCells = !state.showCells;
  try {
    if (state.showCells && !state.cells[id]) {
      state.cells[id] = (await api("/api/regions/" + encodeURIComponent(id))).regions;
    }
    renderInspection();
  } catch (error) {
    notice(error.message, true);
    render();
  }
});
el("evidence").addEventListener("click", event => {
  if (event.target.id !== "current-matches") return;
  state.saved = false;
  state.zoom = false;
  render();
});
for (const frame of [el("query-image"), el("reference-image")]) {
  frame.addEventListener("pointerover", event => {
    const index = event.target.dataset.point;
    if (index === undefined) return;
    for (const marker of document.querySelectorAll(".keypoint")) {
      marker.classList.toggle("paired", marker.dataset.point === index);
    }
  });
  frame.addEventListener("pointerout", () => {
    for (const marker of document.querySelectorAll(".keypoint.paired")) marker.classList.remove("paired");
  });
}
el("evidence").addEventListener("change", event => {
  if (event.target.id !== "region-select") return;
  state.region = Number(event.target.value);
  renderInspection();
  el("region-select").focus();
});
el("evidence").addEventListener("submit", async event => {
  event.preventDefault();
  if (state.mutation) return;
  const manual = isReviewedPair();
  const note = el("review-note")?.value;
  const query = state.query;
  const data = {
    query, reference: manual ? hint().reference : state.reference, region: state.region,
    method: manual ? "reviewed regions" : note ? "manual confirmation" : "reviewed geometry", note,
  };
  state.mutation = true;
  notice("Saving the reviewed link…");
  render();
  try {
    await api("/api/references", json(data));
    await updateLibrary();
    state.mutation = false;
    choosePhoto(manual ? "P06" : query);
  } catch (error) {
    state.mutation = false;
    notice(error.message, true);
    render();
    if (el("review-note")) el("review-note").value = note || "";
  }
});
el("references").addEventListener("click", async event => {
  const button = event.target.closest("button");
  if (!button || state.mutation) return;
  if (button.dataset.open) {
    const id = button.dataset.open;
    choosePhoto(id, false, Boolean(state.library.references[id].depth));
    return;
  }
  const id = button.dataset.remove;
  if (!id) return;
  state.mutation = true;
  render();
  try {
    await api("/api/references/" + encodeURIComponent(id), {method: "DELETE"});
    await updateLibrary();
    if (id === "P05") state.withhold = false;
    await compare("expanded");
  } catch (error) {
    notice(error.message, true);
  } finally {
    state.mutation = false;
    render();
  }
});
el("reveal").addEventListener("click", async () => {
  const id = state.query;
  try {
    const truth = await api("/api/reveal/" + encodeURIComponent(id));
    if (state.query !== id) return;
    state.truth = truth;
    renderComparison();
  } catch (error) {
    notice(error.message, true);
    renderComparison();
  }
});
el("upload-button").addEventListener("click", () => el("upload").click());
el("upload").addEventListener("change", async event => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || state.mutation) return;
  const body = new FormData();
  body.append("photo", file);
  state.mutation = true;
  notice("Reading the new photo…");
  render();
  try {
    const uploaded = await api("/api/photos", {method: "POST", body});
    await updateLibrary();
    state.mutation = false;
    choosePhoto(uploaded.id);
  } catch (error) {
    state.mutation = false;
    notice(error.message, true);
    render();
  }
});

(async function start() {
  try {
    await updateLibrary();
    if (!state.library.models_ready) {
      notice("Matching weights are missing. Run setup.ps1 and restart the lab.", true);
      render();
      return;
    }
    await compare(referenceCounts().added ? "expanded" : "baseline");
  } catch (error) {
    notice(error.message, true);
    render();
  }
})();
