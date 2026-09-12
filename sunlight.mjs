import { CELL_OBSTRUCTION, CELL_SKY, CELL_TREE, CELL_UNKNOWN, normalizeHeading } from "./geometry.mjs";
import { solarPositionFromHourAngle } from "./solar.mjs";

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_START_DAYS = DAYS_IN_MONTH.map((_, month) =>
  DAYS_IN_MONTH.slice(0, month).reduce((total, days) => total + days, 1),
);

const toRadians = (degrees) => (degrees * Math.PI) / 180;
const toDegrees = (radians) => (radians * 180) / Math.PI;

export function solarDeclinationForDay(dayOfYear) {
  const yearAngle = (2 * Math.PI * (dayOfYear - 1)) / 365;
  return toDegrees(
    0.006918 -
      0.399912 * Math.cos(yearAngle) +
      0.070257 * Math.sin(yearAngle) -
      0.006758 * Math.cos(2 * yearAngle) +
      0.000907 * Math.sin(2 * yearAngle) -
      0.002697 * Math.cos(3 * yearAngle) +
      0.00148 * Math.sin(3 * yearAngle),
  );
}

export function classifySunPosition(classifications, width, height, azimuth, altitude, radius = 1) {
  const centerX = Math.floor((normalizeHeading(azimuth) / 360) * width);
  const centerY = Math.floor(height - 1 - altitude);
  let sawSky = false;
  let sawObstruction = false;

  for (let deltaY = -radius; deltaY <= radius; deltaY += 1) {
    for (let deltaX = -radius; deltaX <= radius; deltaX += 1) {
      if (deltaX * deltaX + deltaY * deltaY > radius * radius) continue;
      const y = centerY + deltaY;
      if (y < 0 || y >= height) return CELL_UNKNOWN;
      const x = (centerX + deltaX + width) % width;
      const value = classifications[y * width + x];
      if (value === CELL_UNKNOWN) return CELL_UNKNOWN;
      if (value === CELL_SKY) sawSky = true;
      if (value === CELL_TREE || value === CELL_OBSTRUCTION) sawObstruction = true;
    }
  }

  if (sawSky && sawObstruction) return CELL_UNKNOWN;
  if (sawSky) return CELL_SKY;
  return sawObstruction ? CELL_OBSTRUCTION : CELL_UNKNOWN;
}

export function lightCategory(minimumHours, maximumHours = minimumHours) {
  const categoryFor = (hours) => {
    if (hours >= 6) return "Full sun";
    if (hours >= 4) return "Partial sun";
    if (hours >= 2) return "Partial shade";
    return "Shade";
  };
  const minimumCategory = categoryFor(minimumHours);
  return minimumCategory === categoryFor(maximumHours) ? minimumCategory : "Between categories";
}

export function calculateMonthlySunlight({
  latitude,
  classifications,
  width,
  height,
  months,
  intervalMinutes = 2,
  uncertaintyRadius = 1,
}) {
  if (!Number.isFinite(latitude)) throw new TypeError("A latitude is required.");
  if (!classifications || classifications.length !== width * height) {
    throw new TypeError("The obstruction map dimensions do not match its classifications.");
  }
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    throw new TypeError("The sampling interval must be positive.");
  }

  return months.map((month) => {
    const days = DAYS_IN_MONTH[month];
    if (!days) throw new RangeError(`Invalid month index: ${month}`);
    const totals = {
      confirmedMinutes: 0,
      uncertainMinutes: 0,
      morningMinutes: 0,
      afternoonMinutes: 0,
      daylightMinutes: 0,
    };

    for (let day = 0; day < days; day += 1) {
      const declination = solarDeclinationForDay(MONTH_START_DAYS[month] + day);
      for (let minute = intervalMinutes / 2; minute < 1440; minute += intervalMinutes) {
        const hourAngle = (minute - 720) / 4;
        const position = solarPositionFromHourAngle(latitude, declination, hourAngle);
        if (position.altitude <= 0) continue;
        totals.daylightMinutes += intervalMinutes;
        const classification = classifySunPosition(
          classifications,
          width,
          height,
          position.azimuth,
          position.altitude,
          uncertaintyRadius,
        );
        if (classification === CELL_SKY) {
          totals.confirmedMinutes += intervalMinutes;
          if (hourAngle < 0) totals.morningMinutes += intervalMinutes;
          else totals.afternoonMinutes += intervalMinutes;
        } else if (classification === CELL_UNKNOWN) {
          totals.uncertainMinutes += intervalMinutes;
        }
      }
    }

    const hoursPerDay = (minutes) => minutes / days / 60;
    const confirmedHours = hoursPerDay(totals.confirmedMinutes);
    const uncertainHours = hoursPerDay(totals.uncertainMinutes);
    const daylightHours = hoursPerDay(totals.daylightMinutes);
    return {
      month,
      confirmedHours,
      possibleHours: confirmedHours + uncertainHours,
      uncertainHours,
      morningHours: hoursPerDay(totals.morningMinutes),
      afternoonHours: hoursPerDay(totals.afternoonMinutes),
      daylightHours,
      knownPercent: daylightHours > 0 ? Math.round(((daylightHours - uncertainHours) / daylightHours) * 100) : 100,
      category: lightCategory(confirmedHours, confirmedHours + uncertainHours),
    };
  });
}
