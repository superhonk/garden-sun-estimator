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
const COVERAGE_BINS = 48;

const elements = {
  checkButton: document.querySelector("#check-device"),
  checkSummary: document.querySelector("#check-summary"),
  capabilityList: document.querySelector("#capability-list"),
  openCapture: document.querySelector("#open-capture"),
  captureLab: document.querySelector("#capture-lab"),
  closeCapture: document.querySelector("#close-capture"),
  video: document.querySelector("#camera-preview"),
  overlay: document.querySelector("#segmentation-overlay"),
  sampleCanvas: document.querySelector("#sample-canvas"),
  cameraMessage: document.querySelector("#camera-message"),
  heading: document.querySelector("#heading-reading"),
  elevation: document.querySelector("#elevation-reading"),
  roll: document.querySelector("#roll-reading"),
  location: document.querySelector("#location-reading"),
  captureFrame: document.querySelector("#capture-frame"),
  toggleAuto: document.querySelector("#toggle-auto"),
  coverageBar: document.querySelector("#coverage-bar"),
  coverageReading: document.querySelector("#coverage-reading"),
  modelStatus: document.querySelector("#model-status"),
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
  lastSampleHeading: null,
  lastSampleTime: 0,
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
  elements.heading.textContent = `${Math.round(state.orientation.heading)}°`;
  elements.elevation.textContent = `${Math.round(state.orientation.elevation)}°`;
  elements.roll.textContent = `${Math.round(state.orientation.roll)}°`;
  maybeAutoSample();
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
  const ready = state.cameraReady && Boolean(state.model) && !state.sampling;
  elements.captureFrame.disabled = !ready;
  elements.toggleAuto.disabled = !ready;
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
  state.sampling = true;
  updateCaptureAvailability();
  elements.modelStatus.textContent = "Analyzing this view on the device…";

  try {
    const videoWidth = elements.video.videoWidth;
    const videoHeight = elements.video.videoHeight;
    if (!videoWidth || !videoHeight) throw new Error("Camera frame is not ready.");

    const sampleHeight = Math.round(SAMPLE_WIDTH * (videoHeight / videoWidth));
    elements.sampleCanvas.width = SAMPLE_WIDTH;
    elements.sampleCanvas.height = sampleHeight;
    const context = elements.sampleCanvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(elements.video, 0, 0, SAMPLE_WIDTH, sampleHeight);

    const segmentation = await state.model.segment(elements.sampleCanvas);
    const classifications = classificationsFromSegmentation(segmentation);
    const orientation = currentOrientation();
    const horizontalFov = Number(elements.fovControl.value);

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

    state.samples.push({
      capturedAt: new Date().toISOString(),
      heading: orientation.heading,
      elevation: orientation.elevation,
      roll: orientation.roll,
      orientationSource: state.orientationSource,
      horizontalFov,
      manual,
    });
    state.coverageBins.add(coverageKey(orientation));
    state.lastSampleHeading = orientation.heading;
    state.lastSampleTime = performance.now();
    renderAngularMap();
    renderCoverage();
    elements.modelStatus.textContent = `Sky detection ready · ${window.tf.getBackend()} processing`;
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
  if (!state.autoSampling || !state.model || !state.cameraReady || state.sampling || !state.orientation) return;

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
    samples: state.samples,
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

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // Offline support is an enhancement; the core page remains usable without it.
    });
  });
}
