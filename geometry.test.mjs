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
