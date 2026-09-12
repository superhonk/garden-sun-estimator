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
  verticalFieldOfView,
} from "./geometry.mjs";
import {
  createSolarGuidance,
  signedAngularDifference,
  targetForCaptureKey,
} from "./solar.mjs";
import {
  cameraPoseFromDeviceOrientation,
  projectDirectionToCamera,
  solarDirection,
} from "./orientation.mjs";
import { calculateMonthlySunlight } from "./sunlight.mjs";

const TFJS_URL = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const DEEPLAB_URL = "https://cdn.jsdelivr.net/npm/@tensorflow-models/deeplab@0.2.2/dist/deeplab.min.js";
const SAMPLE_WIDTH = 384;
const AUTO_SAMPLE_DEGREES = 15;
const HEADING_BIN_COUNT = 360 / AUTO_SAMPLE_DEGREES;
const COVERAGE_BINS = 48;
const STABILITY_WINDOW_MS = 650;
const STABLE_HEADING_DEGREES = 2;
const STABLE_TILT_DEGREES = 2.5;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const elements = {
  checkButton: document.querySelector("#check-device"),
  checkSummary: document.querySelector("#check-summary"),
  capabilityList: document.querySelector("#capability-list"),
  openCapture: document.querySelector("#open-capture"),
  captureLab: document.querySelector("#capture-lab"),
  captureTitle: document.querySelector("#capture-title"),
  captureWorkspace: document.querySelector("#capture-workspace"),
  closeCapture: document.querySelector("#close-capture"),
  video: document.querySelector("#camera-preview"),
  solarOverlay: document.querySelector("#solar-overlay"),
  solarGuideStatus: document.querySelector("#solar-guide-status"),
  nextTarget: document.querySelector("#next-target"),
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
  monthOptions: document.querySelector("#month-options"),
  monthlyResults: document.querySelector("#monthly-results"),
  resultsStatus: document.querySelector("#results-status"),
  resultsConfidence: document.querySelector("#results-confidence"),
  sunResults: document.querySelector("#sun-results"),
  resumeCapture: document.querySelector("#resume-capture"),
};

const state = {
  stream: null,
  model: null,
  modelPromise: null,
  cameraReady: false,
  orientation: null,
  orientationSource: "unavailable",
  location: null,
  solarGuidance: null,
  requiredKeys: new Set(),
  solarOverlayFrame: null,
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
  selectedMonths: new Set([3, 4, 5, 6, 7, 8, 9]),
  monthsTouched: false,
  monthlySunlight: null,
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
        if (!state.monthsTouched) {
          state.selectedMonths = new Set(
            coords.latitude >= 0 ? [3, 4, 5, 6, 7, 8, 9] : [9, 10, 11, 0, 1, 2, 3],
          );
          renderMonthOptions();
        }
        state.solarGuidance = createSolarGuidance(coords.latitude);
        state.requiredKeys = new Set(state.solarGuidance.requiredKeys);
        elements.location.textContent = `±${Math.round(coords.accuracy)} m`;
        elements.solarGuideStatus.textContent = `Ready at ${Math.abs(coords.latitude).toFixed(1)}° ${coords.latitude >= 0 ? "north" : "south"}. Capture the highlighted area between the lowest and highest yearly Sun paths.`;
        renderAngularMap();
        renderCoverage();
        renderNextTarget();
        queueSolarOverlayRender();
        resolve(state.location);
      },
      () => {
        elements.location.textContent = "Unavailable";
        elements.solarGuideStatus.textContent = "Location is unavailable, so the prototype will fall back to full directional coverage.";
        elements.nextTarget.textContent = "Capture both the horizon and upper pass around the full circle.";
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  });
}

function readOrientation(event) {
  let compassHeading = null;
  let source = "relative orientation";

  if (Number.isFinite(event.webkitCompassHeading)) {
    compassHeading = event.webkitCompassHeading;
    source = "iOS compass";
  } else if (Number.isFinite(event.alpha)) {
    source = event.absolute ? "absolute orientation" : "relative orientation";
  }

  const screenAngle = Number(screen.orientation?.angle ?? window.orientation ?? 0);
  const orientation = cameraPoseFromDeviceOrientation({
    alpha: event.alpha,
    beta: event.beta,
    gamma: event.gamma ?? 0,
    compassHeading,
    screenAngle,
  });
  if (!orientation) return;

  state.orientation = orientation;
  state.orientationSource = source;
  updateStability(state.orientation, performance.now());
  elements.heading.textContent = `${Math.round(state.orientation.heading)}°`;
  elements.elevation.textContent = `${Math.round(state.orientation.elevation)}°`;
  elements.roll.textContent = `${Math.round(state.orientation.roll)}°`;
  renderNextTarget();
  queueSolarOverlayRender();
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
  elements.captureWorkspace.hidden = false;
  elements.sunResults.hidden = true;
  elements.captureTitle.textContent = "Map the visible sky";
  elements.closeCapture.textContent = "Close camera";
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
  } else if (state.solarGuidance && !state.requiredKeys.has(coverageKey(state.orientation))) {
    message = "Outside Sun corridor · follow the target";
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
  const elevationBand = orientation.elevation >= (state.solarGuidance?.elevationSplit ?? 25) ? 1 : 0;
  return `${headingBin}:${elevationBand}`;
}

function allCoverageKeys() {
  const keys = new Set();
  for (let band = 0; band < 2; band += 1) {
    for (let bin = 0; bin < HEADING_BIN_COUNT; bin += 1) keys.add(`${bin}:${band}`);
  }
  return keys;
}

function activeRequiredKeys() {
  return state.solarGuidance ? state.requiredKeys : allCoverageKeys();
}

function nextTargetKey() {
  const sequence = state.solarGuidance?.sequence ?? [...allCoverageKeys()];
  return sequence.find((key) => !state.coverageBins.has(key)) ?? null;
}

function captureTarget(key) {
  return state.solarGuidance?.targets[key] ?? targetForCaptureKey(
    key,
    state.solarGuidance?.headingStep ?? AUTO_SAMPLE_DEGREES,
    state.solarGuidance?.elevationSplit ?? 25,
  );
}

function cardinalDirection(azimuth) {
  const labels = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  return labels[Math.round(normalizeHeading(azimuth) / 45) % labels.length];
}

function renderNextTarget() {
  if (!state.solarGuidance) return;

  const key = nextTargetKey();
  if (!key) {
    elements.nextTarget.textContent = "Solar corridor captured. You can review or retake individual samples below.";
    return;
  }

  const target = captureTarget(key);
  const level = target.elevationBand === 0 ? "low" : "upward";
  let movement = `Aim ${level} toward ${cardinalDirection(target.azimuth)} (${Math.round(target.azimuth)}°).`;

  if (state.orientation) {
    const turn = signedAngularDifference(target.azimuth, state.orientation.heading);
    const tilt = target.altitude - state.orientation.elevation;
    const directions = [];
    if (Math.abs(turn) > 7) directions.push(`turn ${Math.round(Math.abs(turn))}° ${turn > 0 ? "right" : "left"}`);
    if (Math.abs(tilt) > 7) directions.push(`tilt ${Math.round(Math.abs(tilt))}° ${tilt > 0 ? "up" : "down"}`);
    movement = directions.length ? `${directions.join(" and ")}.` : "Target in view—hold still to capture it.";
  }

  const capturedRequired = [...state.requiredKeys].filter((requiredKey) => state.coverageBins.has(requiredKey)).length;
  elements.nextTarget.textContent = `Next: ${movement} ${capturedRequired} of ${state.requiredKeys.size} required views captured.`;
}

async function captureSample({ manual = false } = {}) {
  if (!state.cameraReady || !state.model || state.sampling) return;
  if (!state.orientation || !state.isStable) {
    elements.modelStatus.textContent = "Hold the phone still until the capture indicator says it is ready.";
    return;
  }
  if (state.solarGuidance && !state.requiredKeys.has(coverageKey(state.orientation))) {
    elements.modelStatus.textContent = "This view is outside the yearly Sun corridor. Follow the next-target guidance.";
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
      cameraPose: orientation.pose,
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
      pose: orientation.pose,
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
    renderNextTarget();
    renderSampleList();
    renderPerformance();
    elements.sampleReviewTitle.textContent = "Accepted sample";
    elements.sampleReviewMeta.textContent = `${Math.round(orientation.heading)}° · ${(inferenceMs / 1000).toFixed(1)} s`;
    elements.modelStatus.textContent = `Accepted ${Math.round(orientation.heading)}° in ${(inferenceMs / 1000).toFixed(1)} seconds. Follow the next target and hold still again.`;
    elements.exportButton.disabled = false;
    if (captureIsComplete()) showCompletedResults();
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
  const movedEnough = state.lastSampleHeading === null || circularDistance(state.orientation.heading, state.lastSampleHeading) >= AUTO_SAMPLE_DEGREES / 2;
  const waitedEnough = now - state.lastSampleTime >= 700;
  const newCoverageBin = !state.coverageBins.has(coverageKey(state.orientation));
  const requiredView = !state.solarGuidance || state.requiredKeys.has(coverageKey(state.orientation));
  if (movedEnough && waitedEnough && newCoverageBin && requiredView) captureSample();
}

function renderCoverage() {
  const requiredKeys = activeRequiredKeys();
  const capturedRequired = [...requiredKeys].filter((key) => state.coverageBins.has(key)).length;
  const coverage = requiredKeys.size ? Math.min(100, Math.round((capturedRequired / requiredKeys.size) * 100)) : 0;
  elements.coverageBar.style.width = `${coverage}%`;
  elements.coverageReading.textContent = state.solarGuidance
    ? `${capturedRequired} of ${requiredKeys.size} required views · ${coverage}% solar-corridor coverage`
    : `${state.samples.length} ${state.samples.length === 1 ? "sample" : "samples"} · ${coverage}% directional coverage`;
  renderCoverageBand(elements.horizonCoverage, 0);
  renderCoverageBand(elements.upperCoverage, 1);
  renderMonthlyResults();
}

function captureIsComplete() {
  const requiredKeys = activeRequiredKeys();
  return Boolean(
    state.solarGuidance &&
      requiredKeys.size &&
      [...requiredKeys].every((key) => state.coverageBins.has(key)),
  );
}

function stopCaptureHardware() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  state.cameraReady = false;
  state.isStable = false;
  state.orientation = null;
  state.orientationWindow = [];
  elements.video.srcObject = null;
  elements.cameraMessage.hidden = false;
  removeOrientationListeners();
}

function showCompletedResults() {
  if (!captureIsComplete()) return;
  stopCaptureHardware();
  elements.captureWorkspace.hidden = true;
  elements.sunResults.hidden = false;
  elements.captureTitle.textContent = "Your sunlight estimate";
  elements.closeCapture.textContent = "Close results";
  updateCaptureAvailability();
  requestAnimationFrame(() => elements.sunResults.scrollIntoView({ behavior: "smooth", block: "start" }));
}

function renderMonthOptions() {
  elements.monthOptions.replaceChildren(
    ...MONTH_NAMES.map((name, month) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      const text = document.createElement("span");
      label.className = "month-option";
      input.type = "checkbox";
      input.value = String(month);
      input.checked = state.selectedMonths.has(month);
      input.setAttribute("aria-label", `${name} included in foliage season`);
      input.addEventListener("change", () => {
        state.monthsTouched = true;
        if (input.checked) state.selectedMonths.add(month);
        else state.selectedMonths.delete(month);
        renderMonthlyResults();
      });
      text.textContent = name;
      label.append(input, text);
      return label;
    }),
  );
}

function formatHours(minimum, maximum) {
  if (maximum - minimum < 0.05) return `${minimum.toFixed(1)} h`;
  return `${minimum.toFixed(1)}–${maximum.toFixed(1)} h`;
}

function renderMonthlyResults() {
  const requiredKeys = activeRequiredKeys();
  const capturedRequired = [...requiredKeys].filter((key) => state.coverageBins.has(key)).length;
  const captureComplete = Boolean(state.solarGuidance && requiredKeys.size && capturedRequired === requiredKeys.size);
  state.monthlySunlight = null;

  if (!state.location || !state.solarGuidance) {
    elements.resultsStatus.textContent = "Location is needed to calculate the Sun's position for each month.";
    elements.resultsConfidence.textContent = "Waiting for location";
    elements.monthlyResults.replaceChildren();
    return;
  }
  if (!captureComplete) {
    elements.resultsStatus.textContent = `Complete the highlighted Sun corridor to calculate monthly results (${capturedRequired} of ${requiredKeys.size} views).`;
    elements.resultsConfidence.textContent = "Waiting for capture";
    elements.monthlyResults.replaceChildren();
    return;
  }

  const months = [...state.selectedMonths].sort((a, b) => a - b);
  if (!months.length) {
    elements.resultsStatus.textContent = "Select at least one foliage-season month.";
    elements.resultsConfidence.textContent = "No months selected";
    const empty = document.createElement("p");
    empty.className = "results-empty";
    empty.textContent = "Choose the months when trees have leaves and plants are actively growing.";
    elements.monthlyResults.replaceChildren(empty);
    return;
  }

  const results = calculateMonthlySunlight({
    latitude: state.location.latitude,
    classifications: resolveAngularGrid(state.grid),
    width: state.grid.width,
    height: state.grid.height,
    months,
  });
  state.monthlySunlight = results;
  const averageKnown = Math.round(results.reduce((total, result) => total + result.knownPercent, 0) / results.length);
  elements.resultsStatus.textContent = "Estimated direct sunlight after accounting for captured trees and structures.";
  elements.resultsConfidence.textContent = `${averageKnown}% of path known`;
  elements.monthlyResults.replaceChildren(
    ...results.map((result) => {
      const article = document.createElement("article");
      const name = document.createElement("div");
      const measurement = document.createElement("div");
      const hours = document.createElement("p");
      const detail = document.createElement("p");
      const category = document.createElement("div");
      article.className = "month-result";
      name.className = "month-result-name";
      name.textContent = MONTH_NAMES[result.month];
      hours.className = "month-result-hours";
      hours.textContent = formatHours(result.confirmedHours, result.possibleHours);
      detail.className = "month-result-detail";
      detail.textContent = `${result.morningHours.toFixed(1)} h morning · ${result.afternoonHours.toFixed(1)} h afternoon${result.uncertainHours >= 0.05 ? ` · up to ${result.uncertainHours.toFixed(1)} h uncertain` : ""}`;
      category.className = "month-result-category";
      category.textContent = result.category;
      measurement.append(hours, detail);
      article.append(name, measurement, category);
      article.setAttribute(
        "aria-label",
        `${MONTH_NAMES[result.month]}: ${formatHours(result.confirmedHours, result.possibleHours)} average direct sunlight per day, ${result.category}`,
      );
      return article;
    }),
  );
}

function renderCoverageBand(container, elevationBand) {
  const cells = [];
  let capturedCount = 0;
  let requiredCount = 0;
  const requiredKeys = activeRequiredKeys();

  for (let bin = 0; bin < HEADING_BIN_COUNT; bin += 1) {
    const key = `${bin}:${elevationBand}`;
    const required = requiredKeys.has(key);
    const captured = state.coverageBins.has(key);
    if (required) requiredCount += 1;
    if (captured) capturedCount += 1;
    const cell = document.createElement("span");
    cell.className = `coverage-cell${required ? " required" : ""}${captured ? " captured" : ""}`;
    cells.push(cell);
  }

  container.replaceChildren(...cells);
  const bandName = elevationBand === 0 ? "Horizon" : "Upper";
  container.setAttribute("aria-label", `${bandName}: ${capturedCount} captured, ${requiredCount} required`);
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
      cameraPose: sample.pose,
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
  renderNextTarget();
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
  drawSolarGuidanceOnMap(context);
}

function drawSolarGuidanceOnMap(context) {
  const guidance = state.solarGuidance;
  if (!guidance) return;

  const corridorImage = context.createImageData(guidance.width, guidance.height);
  for (let altitude = 0; altitude < guidance.height; altitude += 1) {
    for (let azimuth = 0; azimuth < guidance.width; azimuth += 1) {
      if (!guidance.corridorMask[altitude * guidance.width + azimuth]) continue;
      const row = guidance.height - 1 - altitude;
      const offset = (row * guidance.width + azimuth) * 4;
      corridorImage.data.set([239, 184, 76, 55], offset);
    }
  }

  const corridorCanvas = document.createElement("canvas");
  corridorCanvas.width = guidance.width;
  corridorCanvas.height = guidance.height;
  corridorCanvas.getContext("2d").putImageData(corridorImage, 0, 0);
  context.drawImage(corridorCanvas, 0, 0, elements.map.width, elements.map.height);
  drawMapTrajectory(context, guidance.highestPath, "#c88700");
  drawMapTrajectory(context, guidance.lowestPath, "#df6038");
}

function drawMapTrajectory(context, path, color) {
  if (!path.length) return;
  context.beginPath();
  context.lineWidth = 3;
  context.strokeStyle = color;
  let previous = null;

  for (const point of path) {
    const x = (point.azimuth / 360) * elements.map.width;
    const y = elements.map.height - (point.altitude / 90) * elements.map.height;
    if (!previous || Math.abs(point.azimuth - previous.azimuth) > 180) context.moveTo(x, y);
    else context.lineTo(x, y);
    previous = point;
  }
  context.stroke();
}

function projectSolarPoint(point, orientation, width, height, horizontalFov) {
  if (orientation.pose) {
    const verticalFov = verticalFieldOfView(horizontalFov, width, height);
    const projected = projectDirectionToCamera(
      solarDirection(point.azimuth, point.altitude),
      orientation.pose,
      horizontalFov,
      verticalFov,
    );
    if (!projected) return null;
    return {
      x: ((projected.normalizedX + 1) / 2) * width,
      y: ((projected.normalizedY + 1) / 2) * height,
      ...projected,
    };
  }
  const azimuthOffset = signedAngularDifference(point.azimuth, orientation.heading);
  if (Math.abs(azimuthOffset) >= 89) return null;
  const verticalFov = verticalFieldOfView(horizontalFov, width, height);
  const rotatedX = Math.tan((azimuthOffset * Math.PI) / 180) / Math.tan((horizontalFov * Math.PI) / 360);
  const elevationOffset = orientation.elevation - point.altitude;
  const rotatedY = Math.tan((elevationOffset * Math.PI) / 180) / Math.tan((verticalFov * Math.PI) / 360);
  const rollRadians = (-orientation.roll * Math.PI) / 180;
  const rollCosine = Math.cos(rollRadians);
  const rollSine = Math.sin(rollRadians);
  const normalizedX = rotatedX * rollCosine + rotatedY * rollSine;
  const normalizedY = -rotatedX * rollSine + rotatedY * rollCosine;
  return { x: ((normalizedX + 1) / 2) * width, y: ((normalizedY + 1) / 2) * height, normalizedX, normalizedY };
}

function drawLiveTrajectory(context, path, orientation, width, height, horizontalFov, color) {
  context.beginPath();
  context.lineWidth = 3;
  context.strokeStyle = color;
  context.setLineDash([8, 6]);
  let drawing = false;

  for (const point of path) {
    const projected = projectSolarPoint(point, orientation, width, height, horizontalFov);
    const visible = projected && Math.abs(projected.normalizedX) <= 1.15 && Math.abs(projected.normalizedY) <= 1.15;
    if (!visible) {
      drawing = false;
      continue;
    }
    if (!drawing) context.moveTo(projected.x, projected.y);
    else context.lineTo(projected.x, projected.y);
    drawing = true;
  }
  context.stroke();
  context.setLineDash([]);
}

function drawTargetMarker(context, orientation, width, height, horizontalFov) {
  const key = nextTargetKey();
  if (!key || !state.solarGuidance) return;
  const target = captureTarget(key);
  const projected = projectSolarPoint(target, orientation, width, height, horizontalFov);

  if (!projected) {
    const turn = signedAngularDifference(target.azimuth, orientation.heading);
    const x = turn > 0 ? width - 16 : 16;
    context.fillStyle = "rgba(255, 253, 248, 0.95)";
    context.beginPath();
    context.arc(x, height / 2, 8, 0, Math.PI * 2);
    context.fill();
    return;
  }

  const x = Math.max(18, Math.min(width - 18, projected.x));
  const y = Math.max(18, Math.min(height - 18, projected.y));
  context.fillStyle = "rgba(255, 253, 248, 0.96)";
  context.strokeStyle = "#17352a";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(x, y, 12, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.beginPath();
  context.moveTo(x - 5, y);
  context.lineTo(x + 5, y);
  context.moveTo(x, y - 5);
  context.lineTo(x, y + 5);
  context.stroke();
}

function renderSolarOverlay() {
  state.solarOverlayFrame = null;
  const guidance = state.solarGuidance;
  const orientation = state.orientation;
  if (!guidance || !orientation || !state.cameraReady) return;

  const width = elements.solarOverlay.clientWidth;
  const height = elements.solarOverlay.clientHeight;
  if (!width || !height) return;
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  elements.solarOverlay.width = Math.round(width * pixelRatio);
  elements.solarOverlay.height = Math.round(height * pixelRatio);
  const context = elements.solarOverlay.getContext("2d");
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  const horizontalFov = Number(elements.fovControl.value);
  drawLiveTrajectory(context, guidance.highestPath, orientation, width, height, horizontalFov, "#ffe27a");
  drawLiveTrajectory(context, guidance.lowestPath, orientation, width, height, horizontalFov, "#ff9368");
  drawTargetMarker(context, orientation, width, height, horizontalFov);
}

function queueSolarOverlayRender() {
  if (state.solarOverlayFrame !== null) return;
  state.solarOverlayFrame = requestAnimationFrame(renderSolarOverlay);
}

function toggleAutoSampling() {
  state.autoSampling = !state.autoSampling;
  elements.toggleAuto.textContent = `Auto-sampling ${state.autoSampling ? "on" : "off"}`;
}

function exportDiagnostics() {
  const exportedSamples = state.samples.map(({ classifications, capturedAtPerformance, completedAtPerformance, ...sample }) => sample);
  const payload = {
    format: "garden-sun-capture-diagnostic",
    version: 5,
    exportedAt: new Date().toISOString(),
    notice: "Contains precise location when access was granted. Stored only in this download.",
    device: {
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      camera: state.stream?.getVideoTracks()[0]?.getSettings() ?? null,
    },
    location: state.location,
    solarGuidance: state.solarGuidance
      ? {
          latitude: state.solarGuidance.latitude,
          marginDegrees: state.solarGuidance.marginDegrees,
          requiredCaptureKeys: state.solarGuidance.requiredKeys,
        }
      : null,
    grid: { width: state.grid.width, height: state.grid.height, classifications: Array.from(resolveAngularGrid(state.grid)) },
    performance: {
      inferenceMilliseconds: state.samples.map(({ inferenceMs }) => Math.round(inferenceMs)),
    },
    foliageMonths: [...state.selectedMonths].sort((a, b) => a - b),
    monthlySunlight: state.monthlySunlight,
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
  stopCaptureHardware();
  elements.captureLab.hidden = true;
  updateCaptureAvailability();
}

elements.checkButton?.addEventListener("click", renderCapabilityCheck);
elements.openCapture?.addEventListener("click", openCaptureTest);
elements.closeCapture?.addEventListener("click", closeCaptureTest);
elements.resumeCapture?.addEventListener("click", openCaptureTest);
elements.captureFrame?.addEventListener("click", () => captureSample({ manual: true }));
elements.toggleAuto?.addEventListener("click", toggleAutoSampling);
elements.exportButton?.addEventListener("click", exportDiagnostics);
elements.fovControl?.addEventListener("input", () => {
  elements.fovReading.textContent = `${elements.fovControl.value}°`;
  queueSolarOverlayRender();
});
renderMonthOptions();
window.addEventListener("resize", queueSolarOverlayRender);

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
