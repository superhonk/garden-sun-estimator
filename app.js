import {
  CELL_OBSTRUCTION,
  CELL_SKY,
  CELL_TREE,
  CELL_UNKNOWN,
  circularDistance,
  closeSmallCanopyGaps,
  createAngularGrid,
  normalizeHeading,
  projectFrameToGrid,
  resolveAngularGrid,
} from "./geometry.mjs";

const TFJS_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const DEEPLAB_URL = "https://cdn.jsdelivr.net/npm/@tensorflow-models/deeplab@0.2.2/dist/deeplab.min.js";
const SAMPLE_WIDTH = 384;
const AUTO_SAMPLE_DEGREES = 15;
const HEADING_BIN_COUNT = 360 / AUTO_SAMPLE_DEGREES;
const COVERAGE_BINS = 48;
const STABILITY_WINDOW_MS = 650;
const STABLE_HEADING_DEGREES = 2;
const STABLE_TILT_DEGREES = 2.5;

const elements = {
  checkButton: document.querySelector("#check-device"),
  checkSummary: document.querySelector("#check-summary"),
  capabilityList: document.querySelector("#capability-list"),
  openCapture: document.querySelector("#open-capture"),
  captureLab: document.querySelector("#capture-lab"),
  closeCapture: document.querySelector("#close-capture"),
  video: document.querySelector("#camera-preview"),
  overlay: document.querySelector("#segmentation-overlay"),
  capturedFrame: document.querySelector("#captured-frame"),
  sampleReview: document.querySelector("#sample-review"),
  sampleReviewTitle: document.querySelector("#sample-review-title"),
  sampleReviewMeta: document.querySelector("#sample-review-meta"),
  sampleCanvas: document.querySelector("#sample-canvas"),
  cameraMessage: document.querySelector("#camera-message"),
  captureCue: document.querySelector("#capture-cue"),
  heading: document.querySelector("#heading-reading"),
  elevation: document.querySelector("#elevation-reading"),
  roll: document.querySelector("#roll-reading"),
  location: document.querySelector("#location-reading"),
  captureFrame: document.querySelector("#capture-frame"),
  toggleAuto: document.querySelector("#toggle-auto"),
  coverageBar: document.querySelector("#coverage-bar"),
  coverageReading: document.querySelector("#coverage-reading"),
  horizonCoverage: document.querySelector("#horizon-coverage"),
  upperCoverage: document.querySelector("#upper-coverage"),
  modelStatus: document.querySelector("#model-status"),
  performanceReading: document.querySelector("#performance-reading"),
  sampleCount: document.querySelector("#sample-count"),
  sampleList: document.querySelector("#sample-list"),
  fovControl: document.querySelector("#fov-control"),
  fovReading: document.querySelector("#fov-reading"),
  map: document.querySelector("#obstruction-map"),
  exportButton: document.querySelector("#export-diagnostics"),
};

const state = {
  stream: null,
  model: null,
  modelPromise: null,
  cameraReady: false,
  orientation: null,
  orientationSource: "unavailable",
  location: null,
  autoSampling: true,
  sampling: false,
  isStable: false,
  orientationWindow: [],
  lastSampleHeading: null,
  lastSampleTime: 0,
  nextSampleId: 1,
  reviewedSampleId: null,
  samples: [],
  coverageBins: new Set(),
  grid: createAngularGrid(),
};

function getCapabilities() {
  return [
    { name: "Camera", supported: Boolean(navigator.mediaDevices?.getUserMedia) },
    { name: "Location", supported: "geolocation" in navigator },
    { name: "Device orientation", supported: "DeviceOrientationEvent" in window },
    { name: "Local assessment storage", supported: "indexedDB" in window },
  ];
}

function renderCapabilityCheck() {
  const capabilities = getCapabilities();
  const supportedCount = capabilities.filter(({ supported }) => supported).length;

  elements.capabilityList.replaceChildren(
    ...capabilities.map(({ name, supported }) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      const result = document.createElement("strong");
      label.textContent = name;
      result.textContent = supported ? "Available" : "Not detected";
      item.append(label, result);
      return item;
    }),
  );

  elements.checkSummary.textContent =
    supportedCount === capabilities.length
      ? "This browser exposes all capabilities planned for the capture test."
      : `${supportedCount} of ${capabilities.length} planned capabilities were detected.`;
  elements.checkButton.textContent = "Check again";
  elements.openCapture.hidden = !capabilities[0].supported;
}

function loadScript(url, globalName) {
  if (window[globalName]) return Promise.resolve(window[globalName]);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-library="${globalName}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window[globalName]), { once: true });
      existing.addEventListener("error", reject, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = url;
    script.dataset.library = globalName;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => resolve(window[globalName]), { once: true });
    script.addEventListener("error", () => reject(new Error(`Could not load ${globalName}.`)), { once: true });
    document.head.append(script);
  });
}

async function ensureSegmentationModel() {
  if (state.model) return state.model;
  if (state.modelPromise) return state.modelPromise;

  state.modelPromise = (async () => {
    elements.modelStatus.textContent = "Downloading the on-device sky model for the first use…";
    await loadScript(TFJS_URL, "tf");
    await window.tf.ready();
    await loadScript(DEEPLAB_URL, "deeplab");
    elements.modelStatus.textContent = "Loading the quantized ADE20K model…";
    state.model = await window.deeplab.load({ base: "ade20k", quantizationBytes: 1 });
    elements.modelStatus.textContent = `Sky detection ready · ${window.tf.getBackend()} processing`;
    updateCaptureAvailability();
    return state.model;
  })().catch((error) => {
    state.modelPromise = null;
    elements.modelStatus.textContent = "Sky model could not be loaded. Check the connection and reopen the test.";
    throw error;
  });

  return state.modelPromise;
}

function requestOrientationPermission() {
  if (!("DeviceOrientationEvent" in window)) return Promise.resolve("unavailable");
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    return DeviceOrientationEvent.requestPermission().catch(() => "denied");
  }
  return Promise.resolve("granted");
}

function requestLocation() {
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        state.location = { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy };
        elements.location.textContent = `±${Math.round(coords.accuracy)} m`;
        resolve(state.location);
      },
      () => {
        elements.location.textContent = "Unavailable";
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}

function readOrientation(event) {
  let heading = null;
  let source = "relative orientation";

  if (Number.isFinite(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading;
    source = "iOS compass";
  } else if (Number.isFinite(event.alpha)) {
    heading = normalizeHeading(360 - event.alpha);
    source = event.absolute ? "absolute orientation" : "relative orientation";
  }

  if (!Number.isFinite(heading) || !Number.isFinite(event.beta)) return;

  state.orientation = {
    heading: normalizeHeading(heading),
    elevation: Math.max(-30, Math.min(90, 90 - event.beta)),
    roll: Number.isFinite(event.gamma) ? event.gamma : 0,
  };
  state.orientationSource = source;
  updateStability(state.orientation, performance.now());
  elements.heading.textContent = `${Math.round(state.orientation.heading)}°`;
  elements.elevation.textContent = `${Math.round(state.orientation.elevation)}°`;
  elements.roll.textContent = `${Math.round(state.orientation.roll)}°`;
  maybeAutoSample();
}

function updateStability(orientation, now) {
  state.orientationWindow.push({ ...orientation, recordedAt: now });
  state.orientationWindow = state.orientationWindow.filter(({ recordedAt }) => now - recordedAt <= STABILITY_WINDOW_MS);

  const oldest = state.orientationWindow[0];
  const coversWindow = oldest && now - oldest.recordedAt >= STABILITY_WINDOW_MS * 0.85;
  state.isStable = Boolean(
    coversWindow &&
      state.orientationWindow.every(
        (reading) =>
          circularDistance(reading.heading, orientation.heading) <= STABLE_HEADING_DEGREES &&
          Math.abs(reading.elevation - orientation.elevation) <= STABLE_TILT_DEGREES &&
          Math.abs(reading.roll - orientation.roll) <= STABLE_TILT_DEGREES,
      ),
  );

  renderCaptureCue();
  updateCaptureAvailability();
}

function addOrientationListeners() {
  window.addEventListener("deviceorientationabsolute", readOrientation, true);
  window.addEventListener("deviceorientation", readOrientation, true);
}

function removeOrientationListeners() {
  window.removeEventListener("deviceorientationabsolute", readOrientation, true);
  window.removeEventListener("deviceorientation", readOrientation, true);
}

async function openCaptureTest() {
  elements.openCapture.disabled = true;
  elements.captureLab.hidden = false;
  elements.captureLab.scrollIntoView({ behavior: "smooth", block: "start" });
  elements.cameraMessage.hidden = false;
  elements.cameraMessage.textContent = "Requesting camera and sensor access…";

  const orientationPermission = requestOrientationPermission();
  const cameraRequest = navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  const locationRequest = requestLocation();

  const permission = await orientationPermission;
  if (permission === "granted") addOrientationListeners();
  else elements.heading.textContent = permission === "denied" ? "Permission denied" : "Unavailable";

  try {
    state.stream = await cameraRequest;
    elements.video.srcObject = state.stream;
    await elements.video.play();
    state.cameraReady = true;
    elements.cameraMessage.hidden = true;
    updateCaptureAvailability();
    ensureSegmentationModel().catch(() => {});
  } catch (error) {
    state.cameraReady = false;
    elements.cameraMessage.hidden = false;
    elements.cameraMessage.textContent =
      error?.name === "NotAllowedError"
        ? "Camera access was denied. Allow it in the browser settings and try again."
        : "The rear camera could not be started on this browser.";
  }

  await locationRequest;
  elements.openCapture.disabled = false;
}

function updateCaptureAvailability() {
  const baseReady = state.cameraReady && Boolean(state.model) && Boolean(state.orientation);
  elements.captureFrame.disabled = !baseReady || state.sampling || !state.isStable;
  elements.toggleAuto.disabled = !baseReady || state.sampling;
  renderCaptureCue();
}

function renderCaptureCue() {
  if (!elements.captureCue) return;

  let message = "Point, then hold still";
  let ready = false;

  if (state.sampling) {
    message = "Sample locked · analyzing…";
  } else if (!state.cameraReady) {
    message = "Waiting for camera";
  } else if (!state.model) {
    message = "Loading sky detection…";
  } else if (!state.orientation) {
    message = "Waiting for direction sensor";
  } else if (!state.isStable) {
    message = "Move slowly, then hold still";
  } else if (state.coverageBins.has(coverageKey(state.orientation))) {
    message = "Direction captured · keep turning";
    ready = true;
  } else {
    message = state.autoSampling ? "Hold steady · capturing…" : "Steady · ready to capture";
    ready = true;
  }

  elements.captureCue.textContent = message;
  elements.captureCue.classList.toggle("ready", ready);
}

function colorMatches(map, offset, color) {
  return color && map[offset] === color[0] && map[offset + 1] === color[1] && map[offset + 2] === color[2];
}

function classificationsFromSegmentation(segmentation) {
  const classifications = new Uint8Array(segmentation.width * segmentation.height);
  const skyColor = segmentation.legend.sky;
  const treeColors = [segmentation.legend.tree, segmentation.legend.plant].filter(Boolean);

  for (let index = 0; index < classifications.length; index += 1) {
    const offset = index * 4;
    if (colorMatches(segmentation.segmentationMap, offset, skyColor)) {
      classifications[index] = CELL_SKY;
    } else if (treeColors.some((color) => colorMatches(segmentation.segmentationMap, offset, color))) {
      classifications[index] = CELL_TREE;
    } else {
      classifications[index] = CELL_OBSTRUCTION;
    }
  }

  const maximumGapArea = Math.max(12, Math.round(segmentation.width * segmentation.height * 0.0015));
  return closeSmallCanopyGaps(classifications, segmentation.width, segmentation.height, maximumGapArea);
}

function drawSegmentationOverlay(classifications, width, height) {
  elements.overlay.width = width;
  elements.overlay.height = height;
  const context = elements.overlay.getContext("2d");
  const image = context.createImageData(width, height);
  const colors = {
    [CELL_SKY]: [85, 169, 215, 105],
    [CELL_TREE]: [26, 88, 57, 190],
    [CELL_OBSTRUCTION]: [45, 50, 47, 125],
  };

  for (let index = 0; index < classifications.length; index += 1) {
    const color = colors[classifications[index]];
    image.data.set(color, index * 4);
  }
  context.putImageData(image, 0, 0);
}

function showFrozenFrame(width, height, orientation) {
  elements.sampleReview.hidden = false;
  elements.capturedFrame.width = width;
  elements.capturedFrame.height = height;
  elements.capturedFrame.getContext("2d").drawImage(elements.sampleCanvas, 0, 0, width, height);
  elements.overlay.width = width;
  elements.overlay.height = height;
  elements.overlay.getContext("2d").clearRect(0, 0, width, height);
  elements.sampleReviewTitle.textContent = "Analyzing captured view";
  elements.sampleReviewMeta.textContent = `${Math.round(orientation.heading)}° · ${orientation.elevation >= 25 ? "upper" : "horizon"}`;
}

function currentOrientation() {
  return state.orientation ?? { heading: 0, elevation: 15, roll: 0 };
}

function coverageKey(orientation) {
  const headingBin = Math.floor(normalizeHeading(orientation.heading) / AUTO_SAMPLE_DEGREES);
  const elevationBand = orientation.elevation >= 25 ? 1 : 0;
  return `${headingBin}:${elevationBand}`;
}

async function captureSample({ manual = false } = {}) {
  if (!state.cameraReady || !state.model || state.sampling) return;
  if (!state.orientation || !state.isStable) {
    elements.modelStatus.textContent = "Hold the phone still until the capture indicator says it is ready.";
    return;
  }

  state.sampling = true;
  updateCaptureAvailability();
  elements.modelStatus.textContent = "Frame and direction locked together. Analyzing on this device…";

  try {
    const videoWidth = elements.video.videoWidth;
    const videoHeight = elements.video.videoHeight;
    if (!videoWidth || !videoHeight) throw new Error("Camera frame is not ready.");

    const sampleHeight = Math.round(SAMPLE_WIDTH * (videoHeight / videoWidth));
    elements.sampleCanvas.width = SAMPLE_WIDTH;
    elements.sampleCanvas.height = sampleHeight;
    const context = elements.sampleCanvas.getContext("2d", { willReadFrequently: true });
    const orientation = { ...state.orientation };
    const orientationSource = state.orientationSource;
    const capturedAt = new Date().toISOString();
    const capturedAtPerformance = performance.now();
    const horizontalFov = Number(elements.fovControl.value);
    context.drawImage(elements.video, 0, 0, SAMPLE_WIDTH, sampleHeight);
    showFrozenFrame(SAMPLE_WIDTH, sampleHeight, orientation);

    const inferenceStartedAt = performance.now();
    const segmentation = await state.model.segment(elements.sampleCanvas);
    const inferenceMs = performance.now() - inferenceStartedAt;
    const classifications = classificationsFromSegmentation(segmentation);

    drawSegmentationOverlay(classifications, segmentation.width, segmentation.height);
    projectFrameToGrid({
      classifications,
      frameWidth: segmentation.width,
      frameHeight: segmentation.height,
      heading: orientation.heading,
      elevation: orientation.elevation,
      roll: orientation.roll,
      horizontalFov,
      grid: state.grid,
    });

    const sample = {
      id: state.nextSampleId++,
      capturedAt,
      capturedAtPerformance,
      completedAtPerformance: performance.now(),
      heading: orientation.heading,
      elevation: orientation.elevation,
      roll: orientation.roll,
      orientationSource,
      horizontalFov,
      inferenceMs,
      manual,
      classifications,
      frameWidth: segmentation.width,
      frameHeight: segmentation.height,
    };
    state.samples.push(sample);
    state.reviewedSampleId = sample.id;
    state.coverageBins.add(coverageKey(orientation));
    state.lastSampleHeading = orientation.heading;
    state.lastSampleTime = capturedAtPerformance;
    renderAngularMap();
    renderCoverage();
    renderSampleList();
    renderPerformance();
    elements.sampleReviewTitle.textContent = "Accepted sample";
    elements.sampleReviewMeta.textContent = `${Math.round(orientation.heading)}° · ${(inferenceMs / 1000).toFixed(1)} s`;
    elements.modelStatus.textContent = `Accepted ${Math.round(orientation.heading)}° in ${(inferenceMs / 1000).toFixed(1)} seconds. Turn about 15° and hold still again.`;
    elements.exportButton.disabled = false;
  } catch (error) {
    console.error(error);
    elements.modelStatus.textContent = "That frame could not be analyzed. Hold still and try again.";
  } finally {
    state.sampling = false;
    updateCaptureAvailability();
  }
}

function maybeAutoSample() {
  if (!state.autoSampling || !state.model || !state.cameraReady || state.sampling || !state.orientation || !state.isStable) return;

  const now = performance.now();
  const movedEnough = state.lastSampleHeading === null || circularDistance(state.orientation.heading, state.lastSampleHeading) >= AUTO_SAMPLE_DEGREES;
  const waitedEnough = now - state.lastSampleTime >= 700;
  const newCoverageBin = !state.coverageBins.has(coverageKey(state.orientation));
  if (movedEnough && waitedEnough && newCoverageBin) captureSample();
}

function renderCoverage() {
  const coverage = Math.min(100, Math.round((state.coverageBins.size / COVERAGE_BINS) * 100));
  elements.coverageBar.style.width = `${coverage}%`;
  elements.coverageReading.textContent = `${state.samples.length} ${state.samples.length === 1 ? "sample" : "samples"} · ${coverage}% directional coverage`;
  renderCoverageBand(elements.horizonCoverage, 0);
  renderCoverageBand(elements.upperCoverage, 1);
}

function renderCoverageBand(container, elevationBand) {
  const cells = [];
  let capturedCount = 0;

  for (let bin = 0; bin < HEADING_BIN_COUNT; bin += 1) {
    const captured = state.coverageBins.has(`${bin}:${elevationBand}`);
    if (captured) capturedCount += 1;
    const cell = document.createElement("span");
    cell.className = `coverage-cell${captured ? " captured" : ""}`;
    cells.push(cell);
  }

  container.replaceChildren(...cells);
  const bandName = elevationBand === 0 ? "Horizon" : "Upper";
  container.setAttribute("aria-label", `${bandName}: ${capturedCount} of ${HEADING_BIN_COUNT} directions captured`);
}

function renderPerformance() {
  if (!state.samples.length) {
    elements.performanceReading.textContent = "Timing appears after the first accepted sample.";
    return;
  }

  const durations = state.samples.map(({ inferenceMs }) => inferenceMs).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const median = durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
  const latest = state.samples.at(-1);
  let rateCopy = "sample rate available after the next sample";

  if (state.samples.length > 1) {
    const first = state.samples[0];
    const elapsedMinutes = (latest.completedAtPerformance - first.capturedAtPerformance) / 60000;
    const samplesPerMinute = (state.samples.length - 1) / elapsedMinutes;
    rateCopy = `${samplesPerMinute.toFixed(1)} accepted samples/min`;
  }

  elements.performanceReading.textContent = `Inference: ${(latest.inferenceMs / 1000).toFixed(1)} s last · ${(median / 1000).toFixed(1)} s median · ${rateCopy}.`;
}

function rebuildCaptureResults() {
  state.grid = createAngularGrid();
  state.coverageBins = new Set();

  for (const sample of state.samples) {
    projectFrameToGrid({
      classifications: sample.classifications,
      frameWidth: sample.frameWidth,
      frameHeight: sample.frameHeight,
      heading: sample.heading,
      elevation: sample.elevation,
      roll: sample.roll,
      horizontalFov: sample.horizontalFov,
      grid: state.grid,
    });
    state.coverageBins.add(coverageKey(sample));
  }

  state.lastSampleHeading = state.samples.at(-1)?.heading ?? null;
  renderAngularMap();
  renderCoverage();
  renderPerformance();
  elements.exportButton.disabled = state.samples.length === 0;
}

function removeSample(sampleId) {
  const sample = state.samples.find(({ id }) => id === sampleId);
  if (!sample) return;

  state.samples = state.samples.filter(({ id }) => id !== sampleId);
  if (state.reviewedSampleId === sampleId) {
    state.reviewedSampleId = null;
    elements.sampleReview.hidden = true;
  }
  rebuildCaptureResults();
  renderSampleList();
  elements.modelStatus.textContent = `Removed the sample at ${Math.round(sample.heading)}°. Return to that direction and hold still to retake it.`;
  renderCaptureCue();
}

function renderSampleList() {
  elements.sampleCount.textContent = state.samples.length;
  if (!state.samples.length) {
    const empty = document.createElement("li");
    empty.className = "empty-samples";
    empty.textContent = "No samples accepted yet.";
    elements.sampleList.replaceChildren(empty);
    return;
  }

  elements.sampleList.replaceChildren(
    ...state.samples.map((sample, index) => {
      const item = document.createElement("li");
      const description = document.createElement("span");
      const removeButton = document.createElement("button");
      description.textContent = `${index + 1}. ${Math.round(sample.heading)}° · ${sample.elevation >= 25 ? "upper" : "horizon"} · ${(sample.inferenceMs / 1000).toFixed(1)} s`;
      removeButton.type = "button";
      removeButton.textContent = "Remove & retake";
      removeButton.setAttribute("aria-label", `Remove sample ${index + 1} at ${Math.round(sample.heading)} degrees so it can be retaken`);
      removeButton.addEventListener("click", () => removeSample(sample.id));
      item.append(description, removeButton);
      return item;
    }),
  );
}

function renderAngularMap() {
  const classifications = resolveAngularGrid(state.grid);
  const context = elements.map.getContext("2d");
  const image = context.createImageData(state.grid.width, state.grid.height);
  const colors = {
    [CELL_UNKNOWN]: [232, 225, 209, 255],
    [CELL_SKY]: [132, 194, 224, 255],
    [CELL_TREE]: [36, 95, 69, 255],
    [CELL_OBSTRUCTION]: [87, 91, 86, 255],
  };

  for (let index = 0; index < classifications.length; index += 1) {
    image.data.set(colors[classifications[index]], index * 4);
  }

  const buffer = document.createElement("canvas");
  buffer.width = state.grid.width;
  buffer.height = state.grid.height;
  buffer.getContext("2d").putImageData(image, 0, 0);
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, elements.map.width, elements.map.height);
  context.drawImage(buffer, 0, 0, elements.map.width, elements.map.height);
}

function toggleAutoSampling() {
  state.autoSampling = !state.autoSampling;
  elements.toggleAuto.textContent = `Auto-sampling ${state.autoSampling ? "on" : "off"}`;
}

function exportDiagnostics() {
  const exportedSamples = state.samples.map(({ classifications, capturedAtPerformance, completedAtPerformance, ...sample }) => sample);
  const payload = {
    format: "garden-sun-capture-diagnostic",
    version: 1,
    exportedAt: new Date().toISOString(),
    notice: "Contains precise location when access was granted. Stored only in this download.",
    device: {
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      camera: state.stream?.getVideoTracks()[0]?.getSettings() ?? null,
    },
    location: state.location,
    grid: { width: state.grid.width, height: state.grid.height, classifications: Array.from(resolveAngularGrid(state.grid)) },
    performance: {
      inferenceMilliseconds: state.samples.map(({ inferenceMs }) => Math.round(inferenceMs)),
    },
    samples: exportedSamples,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `garden-sun-diagnostic-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function closeCaptureTest() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.cameraReady = false;
  state.isStable = false;
  state.orientationWindow = [];
  elements.video.srcObject = null;
  elements.captureLab.hidden = true;
  elements.cameraMessage.hidden = false;
  removeOrientationListeners();
  updateCaptureAvailability();
}

elements.checkButton?.addEventListener("click", renderCapabilityCheck);
elements.openCapture?.addEventListener("click", openCaptureTest);
elements.closeCapture?.addEventListener("click", closeCaptureTest);
elements.captureFrame?.addEventListener("click", () => captureSample({ manual: true }));
elements.toggleAuto?.addEventListener("click", toggleAutoSampling);
elements.exportButton?.addEventListener("click", exportDiagnostics);
elements.fovControl?.addEventListener("input", () => {
  elements.fovReading.textContent = `${elements.fovControl.value}°`;
});

renderAngularMap();
renderCoverage();
renderSampleList();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // Offline support is an enhancement; the core page remains usable without it.
    });
  });
}
