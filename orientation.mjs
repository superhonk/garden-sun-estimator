const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeHeading(value) {
  return ((value % 360) + 360) % 360;
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!length) return null;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function transform(matrix, vector) {
  return {
    x: matrix[0] * vector.x + matrix[1] * vector.y + matrix[2] * vector.z,
    y: matrix[3] * vector.x + matrix[4] * vector.y + matrix[5] * vector.z,
    z: matrix[6] * vector.x + matrix[7] * vector.y + matrix[8] * vector.z,
  };
}

function rotateHeading(vector, degrees) {
  const angle = degrees * DEGREES_TO_RADIANS;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: vector.x * cosine + vector.y * sine,
    y: -vector.x * sine + vector.y * cosine,
    z: vector.z,
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function headingOf(vector) {
  if (Math.hypot(vector.x, vector.y) < 1e-6) return null;
  return normalizeHeading(Math.atan2(vector.x, vector.y) * RADIANS_TO_DEGREES);
}

// DeviceOrientation uses intrinsic Z-X-Y rotations. Converting those angles to
// vectors first avoids the discontinuities that occur when beta/gamma are used
// directly as camera pitch and roll.
function deviceRotationMatrix(alpha, beta, gamma) {
  const z = alpha * DEGREES_TO_RADIANS;
  const x = beta * DEGREES_TO_RADIANS;
  const y = gamma * DEGREES_TO_RADIANS;
  const cZ = Math.cos(z);
  const sZ = Math.sin(z);
  const cX = Math.cos(x);
  const sX = Math.sin(x);
  const cY = Math.cos(y);
  const sY = Math.sin(y);

  return [
    cZ * cY - sZ * sX * sY,
    -cX * sZ,
    cY * sZ * sX + cZ * sY,
    cY * sZ + cZ * sX * sY,
    cZ * cX,
    sZ * sY - cZ * cY * sX,
    -cX * sY,
    sX,
    cX * cY,
  ];
}

export function cameraPoseFromDeviceOrientation({
  alpha,
  beta,
  gamma = 0,
  compassHeading = null,
  screenAngle = 0,
}) {
  if (![alpha, beta, gamma].every(Number.isFinite)) return null;

  const matrix = deviceRotationMatrix(alpha, beta, gamma);
  const screenRadians = screenAngle * DEGREES_TO_RADIANS;
  const rightOnDevice = { x: Math.cos(screenRadians), y: -Math.sin(screenRadians), z: 0 };
  const upOnDevice = { x: Math.sin(screenRadians), y: Math.cos(screenRadians), z: 0 };
  let forward = normalizeVector(transform(matrix, { x: 0, y: 0, z: -1 }));
  let right = normalizeVector(transform(matrix, rightOnDevice));
  let up = normalizeVector(transform(matrix, upOnDevice));
  if (!forward || !right || !up) return null;

  const sensorHeading = headingOf(forward);
  if (Number.isFinite(compassHeading) && Number.isFinite(sensorHeading)) {
    const correction = normalizeHeading(compassHeading - sensorHeading + 180) - 180;
    forward = rotateHeading(forward, correction);
    right = rotateHeading(right, correction);
    up = rotateHeading(up, correction);
  }

  const heading = Number.isFinite(compassHeading) ? normalizeHeading(compassHeading) : headingOf(forward);
  if (!Number.isFinite(heading)) return null;

  const elevation = Math.asin(clamp(forward.z, -1, 1)) * RADIANS_TO_DEGREES;
  const worldUp = { x: 0, y: 0, z: 1 };
  const levelRight = normalizeVector(cross(forward, worldUp));
  const levelUp = levelRight && normalizeVector(cross(levelRight, forward));
  const roll = levelRight && levelUp
    ? Math.atan2(dot(up, levelRight), dot(up, levelUp)) * RADIANS_TO_DEGREES
    : 0;

  return { heading, elevation, roll, pose: { forward, right, up } };
}

export function solarDirection(azimuth, altitude) {
  const azimuthRadians = azimuth * DEGREES_TO_RADIANS;
  const altitudeRadians = altitude * DEGREES_TO_RADIANS;
  const horizontal = Math.cos(altitudeRadians);
  return {
    x: horizontal * Math.sin(azimuthRadians),
    y: horizontal * Math.cos(azimuthRadians),
    z: Math.sin(altitudeRadians),
  };
}

export function projectDirectionToCamera(direction, pose, horizontalFov, verticalFov) {
  if (!direction || !pose?.forward || !pose?.right || !pose?.up) return null;
  const depth = dot(direction, pose.forward);
  if (depth <= 1e-5) return null;
  return {
    normalizedX: dot(direction, pose.right) / (depth * Math.tan((horizontalFov * Math.PI) / 360)),
    normalizedY: -dot(direction, pose.up) / (depth * Math.tan((verticalFov * Math.PI) / 360)),
  };
}
