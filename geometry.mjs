export const CELL_UNKNOWN = 0;
export const CELL_SKY = 1;
export const CELL_TREE = 2;
export const CELL_OBSTRUCTION = 3;

export function normalizeHeading(value) {
  return ((value % 360) + 360) % 360;
}

export function circularDistance(a, b) {
  const distance = Math.abs(normalizeHeading(a) - normalizeHeading(b));
  return Math.min(distance, 360 - distance);
}

export function verticalFieldOfView(horizontalFieldOfView, width, height) {
  const horizontalRadians = (horizontalFieldOfView * Math.PI) / 180;
  const verticalRadians = 2 * Math.atan(Math.tan(horizontalRadians / 2) * (height / width));
  return (verticalRadians * 180) / Math.PI;
}

export function closeSmallCanopyGaps(source, width, height, maximumArea) {
  const output = new Uint8Array(source);
  const visited = new Uint8Array(source.length);
  const queue = new Int32Array(source.length);
  const component = [];
  const neighbors = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== CELL_SKY || visited[start]) continue;

    component.length = 0;
    let head = 0;
    let tail = 0;
    let touchesEdge = false;
    let treeBoundary = 0;
    let otherBoundary = 0;

    queue[tail++] = start;
    visited[start] = 1;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);
      component.push(index);

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;

      for (const [dx, dy] of neighbors) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;

        const nextIndex = nextY * width + nextX;
        const value = source[nextIndex];
        if (value === CELL_SKY && !visited[nextIndex]) {
          visited[nextIndex] = 1;
          queue[tail++] = nextIndex;
        } else if (value === CELL_TREE) {
          treeBoundary += 1;
        } else if (value === CELL_OBSTRUCTION) {
          otherBoundary += 1;
        }
      }
    }

    const classifiedBoundary = treeBoundary + otherBoundary;
    const surroundedMostlyByTrees = classifiedBoundary > 0 && treeBoundary / classifiedBoundary >= 0.65;
    if (!touchesEdge && component.length <= maximumArea && surroundedMostlyByTrees) {
      for (const index of component) output[index] = CELL_TREE;
    }
  }

  return output;
}

export function createAngularGrid(width = 360, height = 90) {
  return { width, height, votes: new Uint16Array(width * height * 4) };
}

export function projectFrameToGrid({
  classifications,
  frameWidth,
  frameHeight,
  heading,
  elevation,
  roll = 0,
  horizontalFov,
  grid,
  stride = 3,
}) {
  const verticalFov = verticalFieldOfView(horizontalFov, frameWidth, frameHeight);
  const horizontalTangent = Math.tan((horizontalFov * Math.PI) / 360);
  const verticalTangent = Math.tan((verticalFov * Math.PI) / 360);
  const rollRadians = (-roll * Math.PI) / 180;
  const rollCosine = Math.cos(rollRadians);
  const rollSine = Math.sin(rollRadians);

  for (let y = 0; y < frameHeight; y += stride) {
    for (let x = 0; x < frameWidth; x += stride) {
      const value = classifications[y * frameWidth + x];
      if (value === CELL_UNKNOWN) continue;

      const normalizedX = ((x + 0.5) / frameWidth) * 2 - 1;
      const normalizedY = ((y + 0.5) / frameHeight) * 2 - 1;
      const rotatedX = normalizedX * rollCosine - normalizedY * rollSine;
      const rotatedY = normalizedX * rollSine + normalizedY * rollCosine;
      const azimuthOffset = (Math.atan(rotatedX * horizontalTangent) * 180) / Math.PI;
      const elevationOffset = (Math.atan(rotatedY * verticalTangent) * 180) / Math.PI;
      const azimuth = normalizeHeading(heading + azimuthOffset);
      const altitude = elevation - elevationOffset;

      if (altitude < 0 || altitude >= grid.height) continue;
      const gridX = Math.min(grid.width - 1, Math.floor((azimuth / 360) * grid.width));
      const gridY = Math.min(grid.height - 1, Math.floor(grid.height - 1 - altitude));
      const voteIndex = (gridY * grid.width + gridX) * 4 + value;
      grid.votes[voteIndex] = Math.min(65535, grid.votes[voteIndex] + 1);
    }
  }
}

export function resolveAngularGrid(grid) {
  const result = new Uint8Array(grid.width * grid.height);

  for (let index = 0; index < result.length; index += 1) {
    const voteStart = index * 4;
    let bestClass = CELL_UNKNOWN;
    let bestVotes = 0;
    for (let candidate = CELL_SKY; candidate <= CELL_OBSTRUCTION; candidate += 1) {
      const votes = grid.votes[voteStart + candidate];
      if (votes > bestVotes || (votes > 0 && votes === bestVotes && candidate !== CELL_SKY)) {
        bestVotes = votes;
        bestClass = candidate;
      }
    }
    result[index] = bestClass;
  }

  return result;
}
