const MET_RADAR_META = "https://gdal.met.ie/api/maps/radar";
const TILE_TEMPLATE = "https://gdal.met.ie/api/maps/radar/{src}/{x}/{y}/{z}/{mod}";
const TRANSPARENT_TILE =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"></svg>';
const MAP_MAX_ZOOM = 10;
const RADAR_NATIVE_MAX_ZOOM = 9;
const ANALYSIS_ZOOM = 9;
const CANVAS_SIZE = 768;
const FRAME_MINUTES = 5;
const FORECAST_STEPS = 24;
const FRAME_REFRESH_MS = 60_000;
const MAP_ANALYSIS_DEBOUNCE_MS = 500;
const POINT_SAMPLE_RADIUS = 6;
const MOTION_SEARCH_RADIUS = 220;
const MOTION_SEARCH_RANGE = 80;

const state = {
  frames: [],
  selectedIndex: 0,
  radarLayer: null,
  radarLayerFrameKey: "",
  intensityMode: "all",
  marker: null,
  target: { lat: 53.3498, lng: -6.2603 },
  analysing: false,
  pendingAnalysis: false,
  analysisTimer: null,
  refreshTimer: null,
};

const els = {
  headline: document.querySelector("#headline"),
  frameLabel: document.querySelector("#frameLabel"),
  motionLabel: document.querySelector("#motionLabel"),
  confidenceLabel: document.querySelector("#confidenceLabel"),
  rainLabel: document.querySelector("#rainLabel"),
  locateButton: document.querySelector("#locateButton"),
  aboutButton: document.querySelector("#aboutButton"),
  aboutClose: document.querySelector("#aboutClose"),
  aboutDialog: document.querySelector("#aboutDialog"),
  frameSlider: document.querySelector("#frameSlider"),
  intensitySelect: document.querySelector("#intensitySelect"),
  sliderTime: document.querySelector("#sliderTime"),
  latInput: document.querySelector("#latInput"),
  lngInput: document.querySelector("#lngInput"),
  timeline: document.querySelector("#timeline"),
};

const map = L.map("map", {
  zoomControl: true,
  minZoom: 5,
  maxZoom: MAP_MAX_ZOOM,
  preferCanvas: true,
}).setView([53.45, -7.75], 7);

const mapArea = document.querySelector(".map-area");
const settleMapLayout = () => {
  window.requestAnimationFrame(() => {
    map.invalidateSize({ animate: false, pan: false });
  });
};

window.addEventListener("resize", settleMapLayout);
if ("ResizeObserver" in window && mapArea) {
  new ResizeObserver(settleMapLayout).observe(mapArea);
}
setTimeout(settleMapLayout, 0);
setTimeout(settleMapLayout, 250);
setTimeout(settleMapLayout, 1000);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  errorTileUrl: TRANSPARENT_TILE,
  updateWhenIdle: true,
  updateWhenZooming: false,
  keepBuffer: 3,
  attribution: 'Map data © <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
}).addTo(map);

const targetIcon = L.divIcon({
  className: "",
  html: '<span class="target-marker"></span>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

state.marker = L.marker([state.target.lat, state.target.lng], {
  icon: targetIcon,
  draggable: false,
}).addTo(map);

map.on("click", (event) => {
  setTarget(event.latlng.lat, event.latlng.lng, true);
  scheduleAnalysis(MAP_ANALYSIS_DEBOUNCE_MS);
});

els.locateButton.addEventListener("click", locateUser);
els.aboutButton.addEventListener("click", openAboutDialog);
els.aboutClose.addEventListener("click", closeAboutDialog);
els.aboutDialog.addEventListener("click", (event) => {
  if (event.target === els.aboutDialog) {
    closeAboutDialog();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.aboutDialog.hidden) {
    closeAboutDialog();
  }
});
els.frameSlider.addEventListener("input", () => {
  state.selectedIndex = Number(els.frameSlider.value);
  updateRadarLayer();
  updateFrameLabels();
  markAnalysisStale();
  settleMapLayout();
});

els.intensitySelect.addEventListener("change", () => {
  state.intensityMode = els.intensitySelect.value;
  updateRadarLayer({ force: true });
  markAnalysisStale();
});

for (const input of [els.latInput, els.lngInput]) {
  input.addEventListener("change", () => {
    const lat = Number(els.latInput.value);
    const lng = Number(els.lngInput.value);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      setTarget(lat, lng, true);
      markAnalysisStale();
    }
  });
}

const FilteredRadarLayer = L.GridLayer.extend({
  initialize(frame, options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this.frame = frame;
    this.mode = options.mode || "all";
  },

  setFrame(frame, mode) {
    this.frame = frame;
    this.mode = mode || "all";
    this.redraw();
    return this;
  },

  createTile(coords, done) {
    const tile = L.DomUtil.create("canvas", "leaflet-tile");
    const size = this.getTileSize();
    tile.width = size.x;
    tile.height = size.y;

    const ctx = tile.getContext("2d", { willReadFrequently: true });
    const img = new Image();
    img.crossOrigin = "anonymous";
    const source = radarSourceTile(coords);
    img.onload = () => {
      try {
        ctx.drawImage(img, source.sx, source.sy, source.sw, source.sh, 0, 0, size.x, size.y);
        if (this.mode !== "all") {
          filterRadarTile(ctx, size.x, size.y, this.mode);
        }
      } catch (error) {
        ctx.clearRect(0, 0, size.x, size.y);
      }
      done(null, tile);
    };
    img.onerror = () => {
      ctx.clearRect(0, 0, size.x, size.y);
      done(null, tile);
    };
    img.src = tileUrl(this.frame, source.x, source.y, source.z);
    return tile;
  },
});

init();

async function init() {
  try {
    await loadFrames({ preserveSelection: false });
    setTarget(state.target.lat, state.target.lng, true);
    markAnalysisStale();
    state.refreshTimer = window.setInterval(refreshFrames, FRAME_REFRESH_MS);
  } catch (error) {
    console.error(error);
    els.headline.textContent = "Could not load live radar frames.";
  }
}

async function refreshFrames() {
  try {
    await loadFrames({ preserveSelection: true });
  } catch (error) {
    console.warn("Radar refresh failed", error);
  }
}

async function loadFrames({ preserveSelection } = { preserveSelection: true }) {
  const selectedFrame = state.frames[state.selectedIndex];
  const previousLatest = state.frames[state.frames.length - 1];
  const wasShowingLatest = state.frames.length === 0 || state.selectedIndex === state.frames.length - 1;
  const response = await fetch(MET_RADAR_META, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Radar metadata failed: ${response.status}`);
  }
  const frames = await response.json();
  if (!Array.isArray(frames) || frames.length < 3) {
    throw new Error("Radar metadata did not include enough frames.");
  }

  state.frames = frames;
  if (!preserveSelection || wasShowingLatest) {
    state.selectedIndex = state.frames.length - 1;
  } else if (selectedFrame) {
    const preservedIndex = state.frames.findIndex((frame) => frame.src === selectedFrame.src);
    state.selectedIndex = preservedIndex >= 0 ? preservedIndex : state.frames.length - 1;
  }

  els.frameSlider.min = "0";
  els.frameSlider.max = String(state.frames.length - 1);
  els.frameSlider.value = String(state.selectedIndex);
  updateRadarLayer();
  updateFrameLabels();
  return previousLatest?.src !== state.frames[state.frames.length - 1]?.src;
}

function updateRadarLayer({ force } = { force: false }) {
  const frame = state.frames[state.selectedIndex];
  if (!frame) return;
  const frameKey = `${frame.src}:${frame.modifiedTime}:${state.intensityMode}`;
  if (!force && state.radarLayer && state.radarLayerFrameKey === frameKey) {
    return;
  }
  if (!state.radarLayer) {
    state.radarLayer = new FilteredRadarLayer(frame, {
      mode: state.intensityMode,
      minZoom: 5,
      maxZoom: MAP_MAX_ZOOM,
      opacity: 0.72,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 2,
      attribution: 'Radar data © <a href="https://www.met.ie/">Met Eireann</a>',
    }).addTo(map);
  } else {
    state.radarLayer.setFrame(frame, state.intensityMode);
  }
  state.radarLayerFrameKey = frameKey;
  settleMapLayout();
}

function updateFrameLabels() {
  const frame = state.frames[state.selectedIndex];
  if (!frame) return;
  els.frameLabel.textContent = frame.mapTime || frame.dateAndTime || frame.src;
  els.sliderTime.textContent = frame.toolTipDate || frame.mapTime || "";
}

function tileUrl(frame, x, y, z) {
  return TILE_TEMPLATE
    .replace("{src}", frame.src)
    .replace("{x}", x)
    .replace("{y}", y)
    .replace("{z}", z)
    .replace("{mod}", frame.modifiedTime);
}

function radarSourceTile(coords) {
  const sourceZ = Math.min(coords.z, RADAR_NATIVE_MAX_ZOOM);
  const scale = 2 ** Math.max(0, coords.z - sourceZ);
  const sourceTileSize = 256 / scale;
  const tileCount = 2 ** sourceZ;
  const sourceX = Math.floor(coords.x / scale);
  const sourceY = Math.floor(coords.y / scale);

  return {
    x: ((sourceX % tileCount) + tileCount) % tileCount,
    y: sourceY,
    z: sourceZ,
    sx: (((coords.x % scale) + scale) % scale) * sourceTileSize,
    sy: (((coords.y % scale) + scale) % scale) * sourceTileSize,
    sw: sourceTileSize,
    sh: sourceTileSize,
  };
}

function filterRadarTile(ctx, width, height, mode) {
  const image = ctx.getImageData(0, 0, width, height);
  const { data } = image;

  for (let index = 0; index < data.length; index += 4) {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const alpha = data[index + 3];

    if (alpha < 10 || !keepRainPixel(red, green, blue, mode)) {
      data[index + 3] = 0;
    }
  }

  ctx.putImageData(image, 0, 0);
}

function keepRainPixel(red, green, blue, mode) {
  const isBlueLightRain = blue > green + 28 && blue > red + 45;
  const isGreenRain = green >= 145 && green > blue + 12 && green >= red * 0.85;
  const isYellowRain = red >= 165 && green >= 145 && blue <= 120;
  const isOrangeOrRedRain = red >= 180 && green >= 55 && green < 180 && blue <= 130;
  const isPurpleExtreme = red >= 130 && blue >= 120 && green <= 110;

  if (mode === "very-heavy") {
    return isYellowRain || isOrangeOrRedRain || isPurpleExtreme;
  }

  if (mode === "heavy") {
    return !isBlueLightRain && (isGreenRain || isYellowRain || isOrangeOrRedRain || isPurpleExtreme);
  }

  return true;
}

function setTarget(lat, lng, moveMap) {
  state.target = { lat, lng };
  state.marker.setLatLng([lat, lng]);
  els.latInput.value = lat.toFixed(5);
  els.lngInput.value = lng.toFixed(5);
  if (moveMap) {
    map.setView([lat, lng], Math.max(map.getZoom(), 8));
    settleMapLayout();
  }
}

function locateUser() {
  if (!navigator.geolocation) {
    els.headline.textContent = "This browser does not expose geolocation.";
    return;
  }
  els.locateButton.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (position) => {
      els.locateButton.disabled = false;
      setTarget(position.coords.latitude, position.coords.longitude, true);
      scheduleAnalysis(0);
    },
    () => {
      els.locateButton.disabled = false;
      els.headline.textContent = "Location permission was not granted. Enter coordinates or click the map.";
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
  );
}

function openAboutDialog() {
  els.aboutDialog.hidden = false;
  els.aboutClose.focus();
}

function closeAboutDialog() {
  els.aboutDialog.hidden = true;
  els.aboutButton.focus();
}

function scheduleAnalysis(delayMs) {
  window.clearTimeout(state.analysisTimer);
  state.analysisTimer = window.setTimeout(() => {
    state.analysisTimer = null;
    analysePoint();
  }, delayMs);
}

function markAnalysisStale() {
  window.clearTimeout(state.analysisTimer);
  state.analysisTimer = null;
  els.headline.textContent = "Click the map or use your location to analyse rainfall at that point.";
  els.motionLabel.textContent = "--";
  els.confidenceLabel.textContent = "--";
  els.rainLabel.textContent = "--";
  els.timeline.innerHTML = "";
}

async function analysePoint() {
  if (state.analysing) {
    state.pendingAnalysis = true;
    return;
  }
  if (state.frames.length < 3) return;
  state.analysing = true;
  const intensityMode = state.intensityMode;
  const target = { ...state.target };
  els.headline.textContent = `Analysing ${intensityLabel(intensityMode).toLowerCase()} movement...`;
  els.motionLabel.textContent = "--";
  els.confidenceLabel.textContent = "--";
  els.rainLabel.textContent = "--";

  try {
    const latest = state.frames[state.frames.length - 1];
    const previous = state.frames[state.frames.length - 2];
    const older = state.frames[state.frames.length - 4] || state.frames[0];
    const [latestCanvas, previousCanvas, olderCanvas] = await Promise.all([
      composeRadarCanvas(latest, target, intensityMode),
      composeRadarCanvas(previous, target, intensityMode),
      composeRadarCanvas(older, target, intensityMode),
    ]);

    if (intensityMode !== state.intensityMode || target.lat !== state.target.lat || target.lng !== state.target.lng) {
      return;
    }

    const currentRain = sampleRain(latestCanvas, CANVAS_SIZE / 2, CANVAS_SIZE / 2, POINT_SAMPLE_RADIUS);
    const motionA = estimateMotion(previousCanvas, latestCanvas);
    const motionB = estimateMotion(olderCanvas, latestCanvas, state.frames.length - 1 - state.frames.indexOf(older));
    const motion = combineMotion(motionA, motionB);
    const forecast = forecastAtPoint(latestCanvas, motion);

    renderResult(currentRain, motion, forecast, latest, intensityMode);
  } catch (error) {
    console.error(error);
    els.headline.textContent = "Analysis failed. The live radar tiles may not be reachable from this browser.";
  } finally {
    state.analysing = false;
    if (state.pendingAnalysis) {
      state.pendingAnalysis = false;
      window.setTimeout(analysePoint, 0);
    }
  }
}

async function composeRadarCanvas(frame, target, intensityMode = "all") {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  const center = project(target.lat, target.lng, ANALYSIS_ZOOM);
  const topLeft = {
    x: center.x - CANVAS_SIZE / 2,
    y: center.y - CANVAS_SIZE / 2,
  };
  const minTileX = Math.floor(topLeft.x / 256);
  const maxTileX = Math.floor((topLeft.x + CANVAS_SIZE) / 256);
  const minTileY = Math.floor(topLeft.y / 256);
  const maxTileY = Math.floor((topLeft.y + CANVAS_SIZE) / 256);
  const tileCount = 2 ** ANALYSIS_ZOOM;
  const jobs = [];

  for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      if (tileY < 0 || tileY >= tileCount) continue;
      const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
      const dx = tileX * 256 - topLeft.x;
      const dy = tileY * 256 - topLeft.y;
      jobs.push(loadImage(tileUrl(frame, wrappedX, tileY, ANALYSIS_ZOOM)).then((img) => {
        if (img) ctx.drawImage(img, dx, dy, 256, 256);
      }));
    }
  }

  await Promise.all(jobs);
  if (intensityMode !== "all") {
    filterRadarTile(ctx, CANVAS_SIZE, CANVAS_SIZE, intensityMode);
  }
  return canvas;
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function project(lat, lng, zoom) {
  const sin = Math.sin((lat * Math.PI) / 180);
  const scale = 256 * 2 ** zoom;
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function weightsFromCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const weights = new Float32Array(width * height);
  for (let index = 0, pixel = 0; index < data.length; index += 4, pixel += 1) {
    const alpha = data[index + 3];
    if (alpha < 10) continue;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const brightness = Math.max(red, green, blue) / 255;
    const colorfulness = (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
    weights[pixel] = (alpha / 255) * Math.max(brightness, colorfulness);
  }
  return { weights, width, height };
}

function sampleRain(canvas, x, y, radius) {
  const { weights, width, height } = weightsFromCanvas(canvas);
  return sampleRainWeights({ weights, width, height }, x, y, radius);
}

function sampleRainWeights(source, x, y, radius) {
  let wet = 0;
  let checked = 0;
  let total = 0;
  let strongest = 0;
  const startX = Math.max(0, Math.floor(x - radius));
  const endX = Math.min(source.width - 1, Math.ceil(x + radius));
  const startY = Math.max(0, Math.floor(y - radius));
  const endY = Math.min(source.height - 1, Math.ceil(y + radius));
  const radiusSquared = radius * radius;

  for (let py = startY; py <= endY; py += 2) {
    for (let px = startX; px <= endX; px += 2) {
      const dx = px - x;
      const dy = py - y;
      if (dx * dx + dy * dy > radiusSquared) continue;
      checked += 1;
      const value = source.weights[py * source.width + px];
      if (value > 0.08) wet += 1;
      strongest = Math.max(strongest, value);
      total += value;
    }
  }

  const minimumWetPixels = Math.max(2, Math.ceil(checked * 0.1));
  return {
    wet,
    checked,
    total,
    strongest,
    isWet: wet >= minimumWetPixels || strongest > 0.45,
  };
}

function estimateMotion(fromCanvas, toCanvas, frameSpan = 1) {
  const from = weightsFromCanvas(fromCanvas);
  const to = weightsFromCanvas(toCanvas);
  const center = CANVAS_SIZE / 2;
  const radius = MOTION_SEARCH_RADIUS;
  const coarse = searchMotion(from, to, center, radius, -MOTION_SEARCH_RANGE, MOTION_SEARCH_RANGE, 4);
  const refined = searchMotion(
    from,
    to,
    center,
    radius,
    coarse.dx - 6,
    coarse.dx + 6,
    1,
    coarse.dy - 6,
    coarse.dy + 6,
  );

  return {
    dx: refined.dx / frameSpan,
    dy: refined.dy / frameSpan,
    score: refined.score,
    rainPixels: refined.rainPixels,
  };
}

function searchMotion(from, to, center, radius, minDx, maxDx, step, minDy = minDx, maxDy = maxDx) {
  let best = { dx: 0, dy: 0, score: -1, rainPixels: 0 };
  for (let dy = minDy; dy <= maxDy; dy += step) {
    for (let dx = minDx; dx <= maxDx; dx += step) {
      const candidate = scoreShift(from, to, center, radius, dx, dy);
      if (candidate.score > best.score) {
        best = { dx, dy, ...candidate };
      }
    }
  }
  return best;
}

function scoreShift(from, to, center, radius, dx, dy) {
  let overlap = 0;
  let fromEnergy = 0;
  let toEnergy = 0;
  let rainPixels = 0;
  const step = 4;
  const start = Math.floor(center - radius);
  const end = Math.ceil(center + radius);

  for (let y = start; y <= end; y += step) {
    const sourceY = y - dy;
    if (sourceY < 0 || sourceY >= from.height) continue;
    for (let x = start; x <= end; x += step) {
      const sourceX = x - dx;
      if (sourceX < 0 || sourceX >= from.width) continue;
      const current = to.weights[y * to.width + x];
      const prior = from.weights[sourceY * from.width + sourceX];
      if (current > 0.04 || prior > 0.04) rainPixels += 1;
      overlap += current * prior;
      fromEnergy += prior * prior;
      toEnergy += current * current;
    }
  }

  const denominator = Math.sqrt(fromEnergy * toEnergy) || 1;
  return {
    score: overlap / denominator,
    rainPixels,
  };
}

function combineMotion(a, b) {
  if (a.rainPixels < 20 && b.rainPixels < 20) {
    return { dx: 0, dy: 0, score: 0, rainPixels: 0 };
  }
  const aWeight = Math.max(0.05, a.score) * Math.max(1, a.rainPixels);
  const bWeight = Math.max(0.05, b.score) * Math.max(1, b.rainPixels);
  return {
    dx: (a.dx * aWeight + b.dx * bWeight) / (aWeight + bWeight),
    dy: (a.dy * aWeight + b.dy * bWeight) / (aWeight + bWeight),
    score: Math.max(a.score, b.score),
    rainPixels: Math.max(a.rainPixels, b.rainPixels),
  };
}

function forecastAtPoint(latestCanvas, motion) {
  const source = weightsFromCanvas(latestCanvas);
  const center = CANVAS_SIZE / 2;
  const steps = [];
  for (let step = 0; step <= FORECAST_STEPS; step += 1) {
    const sample = sampleRainWeights(
      source,
      center - motion.dx * step,
      center - motion.dy * step,
      POINT_SAMPLE_RADIUS,
    );
    steps.push({
      minute: step * FRAME_MINUTES,
      isWet: sample.isWet,
      strength: sample.strongest,
    });
  }
  return steps;
}

function renderResult(currentRain, motion, forecast, latestFrame, intensityMode) {
  const speedKmh = pixelSpeedToKmh(motion);
  const direction = directionFromMotion(motion);
  const confidence = confidenceLabel(motion, currentRain);
  const label = intensityLabel(intensityMode);
  const currentlyWet = forecast[0]?.isWet || currentRain.isWet;
  const transition = findTransition(forecast, currentlyWet);

  els.rainLabel.textContent = currentlyWet ? "Yes" : "No";
  els.motionLabel.textContent = speedKmh > 1 ? `${Math.round(speedKmh)} km/h ${direction}` : "Weak signal";
  els.confidenceLabel.textContent = confidence;

  if (motion.rainPixels < 20) {
    els.headline.textContent = `No coherent nearby ${label.toLowerCase()} patch to extrapolate.`;
  } else if (currentlyWet && transition) {
    els.headline.textContent = `${label} likely clears this point in about ${transition.minute} minutes.`;
  } else if (!currentlyWet && transition) {
    els.headline.textContent = `${label} may reach this point in about ${transition.minute} minutes.`;
  } else if (currentlyWet) {
    els.headline.textContent = `${label} remains near this point for the next two hours.`;
  } else {
    els.headline.textContent = `No ${label.toLowerCase()} is projected over this point in the next two hours.`;
  }

  els.frameLabel.textContent = latestFrame.mapTime || latestFrame.dateAndTime || latestFrame.src;
  renderTimeline(forecast);
}

function intensityLabel(mode) {
  if (mode === "heavy") return "Heavy rain";
  if (mode === "very-heavy") return "Very heavy rain";
  return "Rain";
}

function findTransition(forecast, currentlyWet) {
  if (currentlyWet) {
    return forecast.find((step) => step.minute > 0 && !step.isWet);
  }
  return forecast.find((step) => step.minute > 0 && step.isWet);
}

function pixelSpeedToKmh(motion) {
  const metersPerPixel = metersPerPixelAtLatitude(state.target.lat, ANALYSIS_ZOOM);
  const pixelsPerFrame = Math.hypot(motion.dx, motion.dy);
  return (pixelsPerFrame * metersPerPixel) / (FRAME_MINUTES / 60) / 1000;
}

function metersPerPixelAtLatitude(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

function directionFromMotion(motion) {
  const distance = Math.hypot(motion.dx, motion.dy);
  if (distance < 0.5) return "";
  const bearing = (Math.atan2(motion.dx, -motion.dy) * 180) / Math.PI;
  const normalized = (bearing + 360) % 360;
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return names[Math.round(normalized / 45) % names.length];
}

function confidenceLabel(motion, currentRain) {
  if (motion.rainPixels < 20) return "Low";
  if (motion.score > 0.62 && currentRain.total > 2) return "High";
  if (motion.score > 0.38) return "Medium";
  return "Low";
}

function renderTimeline(forecast) {
  els.timeline.innerHTML = "";
  const track = document.createElement("div");
  track.className = "timeline-track";

  for (const step of forecast) {
    const node = document.createElement("span");
    node.className = `${step.isWet ? "rain" : "dry"}${step.minute === 0 ? " now" : ""}`;
    node.title = `${step.minute === 0 ? "now" : `${step.minute}m`}: ${step.isWet ? "rain projected" : "dry projected"}`;
    track.appendChild(node);
  }

  const labels = document.createElement("div");
  labels.className = "timeline-labels";
  for (let minute = 0; minute <= FORECAST_STEPS * FRAME_MINUTES; minute += 20) {
    const label = document.createElement("span");
    const stepIndex = minute / FRAME_MINUTES;
    label.textContent = minute === 0 ? "now" : `${minute}m`;
    label.style.gridColumn = `${stepIndex + 1}`;
    labels.appendChild(label);
  }

  els.timeline.append(track, labels);
}
