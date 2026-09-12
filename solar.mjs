export const SOLSTICE_DECLINATION = 23.44;

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function signedAngularDifference(angle, reference) {
  return ((angle - reference + 540) % 360) - 180;
}

export function solarPositionFromHourAngle(latitude, declination, hourAngle) {
  const latitudeRadians = toRadians(clamp(latitude, -89.999, 89.999));
  const declinationRadians = toRadians(declination);
  const hourAngleRadians = toRadians(hourAngle);
  const altitudeRadians = Math.asin(
    Math.sin(latitudeRadians) * Math.sin(declinationRadians) +
      Math.cos(latitudeRadians) * Math.cos(declinationRadians) * Math.cos(hourAngleRadians),
  );
  const azimuthRadians = Math.atan2(
    Math.sin(hourAngleRadians),
    Math.cos(hourAngleRadians) * Math.sin(latitudeRadians) -
      Math.tan(declinationRadians) * Math.cos(latitudeRadians),
  );

  return {
    azimuth: (toDegrees(azimuthRadians) + 180 + 360) % 360,
    altitude: toDegrees(altitudeRadians),
    hourAngle,
  };
}

export function dailySolarTrajectory(latitude, declination, stepDegrees = 1) {
  const latitudeRadians = toRadians(clamp(latitude, -89.999, 89.999));
  const declinationRadians = toRadians(declination);
  const sunriseCosine = -Math.tan(latitudeRadians) * Math.tan(declinationRadians);

  if (sunriseCosine > 1) return [];

  const limit = sunriseCosine < -1 ? 180 : toDegrees(Math.acos(sunriseCosine));
  const points = [];
  for (let hourAngle = -limit; hourAngle < limit; hourAngle += stepDegrees) {
    const position = solarPositionFromHourAngle(latitude, declination, hourAngle);
    if (position.altitude >= -0.01) points.push({ ...position, altitude: Math.max(0, position.altitude) });
  }

  const finalPosition = solarPositionFromHourAngle(latitude, declination, limit);
  if (finalPosition.altitude >= -0.01) points.push({ ...finalPosition, altitude: Math.max(0, finalPosition.altitude) });
  return points;
}

function markCorridorDisc(mask, width, height, azimuth, altitude, radius) {
  const centerX = Math.round(azimuth) % width;
  const centerY = Math.round(altitude);

  for (let deltaY = -radius; deltaY <= radius; deltaY += 1) {
    for (let deltaX = -radius; deltaX <= radius; deltaX += 1) {
      if (deltaX * deltaX + deltaY * deltaY > radius * radius) continue;
      const y = centerY + deltaY;
      if (y < 0 || y >= height) continue;
      const x = (centerX + deltaX + width) % width;
      mask[y * width + x] = 1;
    }
  }
}

function keyForCell(azimuth, altitude, headingStep, elevationSplit) {
  return `${Math.floor(azimuth / headingStep)}:${altitude >= elevationSplit ? 1 : 0}`;
}

export function targetForCaptureKey(key, headingStep = 15, elevationSplit = 25) {
  const [headingBin, elevationBand] = key.split(":").map(Number);
  return {
    key,
    azimuth: headingBin * headingStep + headingStep / 2,
    altitude: elevationBand === 0 ? elevationSplit / 2 : elevationSplit + (90 - elevationSplit) * 0.38,
    elevationBand,
  };
}

export function createSolarGuidance(latitude, {
  width = 360,
  height = 90,
  marginDegrees = 4,
  headingStep = 15,
  elevationSplit = 25,
} = {}) {
  const northernHemisphere = latitude >= 0;
  const summerDeclination = northernHemisphere ? SOLSTICE_DECLINATION : -SOLSTICE_DECLINATION;
  const winterDeclination = -summerDeclination;
  const highestPath = dailySolarTrajectory(latitude, summerDeclination);
  const lowestPath = dailySolarTrajectory(latitude, winterDeclination);
  const corridorMask = new Uint8Array(width * height);

  for (
    let declination = -SOLSTICE_DECLINATION;
    declination <= SOLSTICE_DECLINATION + 0.01;
    declination += 2
  ) {
    const trajectory = dailySolarTrajectory(latitude, declination, 2);
    for (const point of trajectory) {
      markCorridorDisc(corridorMask, width, height, point.azimuth, point.altitude, marginDegrees);
    }
  }

  const requiredKeys = new Set();
  const targetStats = new Map();
  for (let altitude = 0; altitude < height; altitude += 1) {
    for (let azimuth = 0; azimuth < width; azimuth += 1) {
      if (corridorMask[altitude * width + azimuth]) {
        const key = keyForCell(azimuth, altitude, headingStep, elevationSplit);
        requiredKeys.add(key);
        const stats = targetStats.get(key) ?? { azimuthTotal: 0, altitudeTotal: 0, count: 0 };
        stats.azimuthTotal += azimuth;
        stats.altitudeTotal += altitude;
        stats.count += 1;
        targetStats.set(key, stats);
      }
    }
  }

  const targets = Object.fromEntries(
    [...targetStats].map(([key, stats]) => [
      key,
      {
        key,
        azimuth: stats.azimuthTotal / stats.count,
        altitude: stats.altitudeTotal / stats.count,
        elevationBand: Number(key.split(":")[1]),
      },
    ]),
  );

  const noonDirection = northernHemisphere ? 180 : 0;
  const pathProgress = (key) => {
    const target = targetForCaptureKey(key, headingStep, elevationSplit);
    const difference = signedAngularDifference(target.azimuth, noonDirection);
    return northernHemisphere ? difference : -difference;
  };
  const lowerPass = [...requiredKeys]
    .filter((key) => key.endsWith(":0"))
    .sort((a, b) => pathProgress(a) - pathProgress(b));
  const upperPass = [...requiredKeys]
    .filter((key) => key.endsWith(":1"))
    .sort((a, b) => pathProgress(b) - pathProgress(a));

  return {
    latitude,
    highestPath,
    lowestPath,
    corridorMask,
    width,
    height,
    marginDegrees,
    headingStep,
    elevationSplit,
    requiredKeys: [...requiredKeys],
    targets,
    sequence: [...lowerPass, ...upperPass],
  };
}
