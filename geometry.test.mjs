import assert from "node:assert/strict";
import test from "node:test";

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
  SOLSTICE_DECLINATION,
  createSolarGuidance,
  dailySolarTrajectory,
  solarPositionFromHourAngle,
  targetForCaptureKey,
} from "./solar.mjs";
import {
  cameraPoseFromDeviceOrientation,
  projectDirectionToCamera,
  solarDirection,
} from "./orientation.mjs";

function approximately(actual, expected, tolerance = 0.001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("normalizes headings and measures across north", () => {
  assert.equal(normalizeHeading(-10), 350);
  assert.equal(normalizeHeading(370), 10);
  assert.equal(circularDistance(355, 5), 10);
});

test("derives a plausible vertical field of view", () => {
  const vertical = verticalFieldOfView(60, 4, 3);
  assert.ok(vertical > 45 && vertical < 48);
});

test("closes a small sky opening surrounded by tree canopy", () => {
  const source = new Uint8Array(25).fill(CELL_TREE);
  source[12] = CELL_SKY;
  const result = closeSmallCanopyGaps(source, 5, 5, 2);
  assert.equal(result[12], CELL_TREE);
});

test("preserves open sky connected to the frame edge", () => {
  const source = new Uint8Array(25).fill(CELL_TREE);
  source[0] = CELL_SKY;
  source[1] = CELL_SKY;
  const result = closeSmallCanopyGaps(source, 5, 5, 4);
  assert.equal(result[0], CELL_SKY);
  assert.equal(result[1], CELL_SKY);
});

test("does not close a gap surrounded by structures", () => {
  const source = new Uint8Array(25).fill(CELL_OBSTRUCTION);
  source[12] = CELL_SKY;
  const result = closeSmallCanopyGaps(source, 5, 5, 2);
  assert.equal(result[12], CELL_SKY);
});

test("projects the center pixel into the expected grid heading", () => {
  const grid = createAngularGrid(360, 90);
  projectFrameToGrid({
    classifications: new Uint8Array([CELL_SKY]),
    frameWidth: 1,
    frameHeight: 1,
    heading: 180,
    elevation: 30,
    horizontalFov: 60,
    grid,
    stride: 1,
  });
  const resolved = resolveAngularGrid(grid);
  const row = 90 - 1 - 30;
  assert.equal(resolved[row * 360 + 180], CELL_SKY);
  assert.equal(resolved[0], CELL_UNKNOWN);
});

test("derives a level north-facing camera pose from device vectors", () => {
  const orientation = cameraPoseFromDeviceOrientation({ alpha: 0, beta: 90, gamma: 0, compassHeading: 0 });
  approximately(orientation.heading, 0);
  approximately(orientation.elevation, 0);
  approximately(orientation.roll, 0);
  approximately(orientation.pose.forward.y, 1);
  approximately(orientation.pose.up.z, 1);
});

test("keeps pitch direction correct above the horizon", () => {
  const orientation = cameraPoseFromDeviceOrientation({ alpha: 0, beta: 120, gamma: 0, compassHeading: 0 });
  approximately(orientation.elevation, 30);
});

test("projects a solar direction consistently when the camera is rolled", () => {
  const orientation = cameraPoseFromDeviceOrientation({
    alpha: -90,
    beta: 60,
    gamma: 90,
    compassHeading: 0,
  });
  approximately(orientation.heading, 0);
  approximately(orientation.elevation, 0);
  approximately(orientation.roll, 30);

  const projected = projectDirectionToCamera(solarDirection(0, 20), orientation.pose, 60, 45);
  assert.ok(projected);
  assert.ok(projected.normalizedX < 0);
  assert.ok(projected.normalizedY < 0);
});

test("uses the camera basis when projecting a captured frame", () => {
  const orientation = cameraPoseFromDeviceOrientation({ alpha: 0, beta: 120, gamma: 0, compassHeading: 180 });
  const grid = createAngularGrid(360, 90);
  projectFrameToGrid({
    classifications: new Uint8Array([CELL_SKY]),
    frameWidth: 1,
    frameHeight: 1,
    heading: orientation.heading,
    elevation: orientation.elevation,
    roll: orientation.roll,
    cameraPose: orientation.pose,
    horizontalFov: 60,
    grid,
    stride: 1,
  });
  const resolved = resolveAngularGrid(grid);
  const row = 90 - 1 - 30;
  assert.equal(resolved[row * 360 + 180], CELL_SKY);
});

test("places the equinox Sun overhead at equatorial solar noon", () => {
  const position = solarPositionFromHourAngle(0, 0, 0);
  assert.ok(Math.abs(position.altitude - 90) < 0.001);
});

test("creates plausible Berlin solstice trajectories", () => {
  const winter = dailySolarTrajectory(52.52, -SOLSTICE_DECLINATION);
  const summer = dailySolarTrajectory(52.52, SOLSTICE_DECLINATION);
  const winterNoon = winter.reduce((highest, point) => (point.altitude > highest.altitude ? point : highest));
  const summerNoon = summer.reduce((highest, point) => (point.altitude > highest.altitude ? point : highest));

  assert.ok(winterNoon.altitude > 13.5 && winterNoon.altitude < 14.5);
  assert.ok(summerNoon.altitude > 60.5 && summerNoon.altitude < 61.5);
  assert.ok(winter[0].azimuth > 130 && winter[0].azimuth < 132);
  assert.ok(summer[0].azimuth > 48 && summer[0].azimuth < 50);
});

test("builds a two-pass capture sequence through the annual solar corridor", () => {
  const guidance = createSolarGuidance(52.52);
  const lowerKeys = guidance.sequence.filter((key) => key.endsWith(":0"));
  const upperKeys = guidance.sequence.filter((key) => key.endsWith(":1"));

  assert.ok(guidance.requiredKeys.length > 0);
  assert.equal(guidance.sequence.length, guidance.requiredKeys.length);
  assert.ok(guidance.targets[guidance.sequence[0]].altitude < 25);
  assert.ok(targetForCaptureKey(lowerKeys[0]).azimuth < targetForCaptureKey(lowerKeys.at(-1)).azimuth);
  assert.ok(targetForCaptureKey(upperKeys[0]).azimuth > targetForCaptureKey(upperKeys.at(-1)).azimuth);
});

test("handles polar night without inventing a winter trajectory", () => {
  const guidance = createSolarGuidance(70);
  assert.equal(guidance.lowestPath.length, 0);
  assert.ok(guidance.highestPath.length > 0);
  assert.ok(guidance.requiredKeys.length > 0);
});
