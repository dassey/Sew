export function createProjection(centerLat, centerLon) {
  const phi = (centerLat * Math.PI) / 180;

  const mPerDegLat =
    111132.92 -
    559.82 * Math.cos(2 * phi) +
    1.175 * Math.cos(4 * phi) -
    0.0023 * Math.cos(6 * phi);

  const mPerDegLon =
    111412.84 * Math.cos(phi) -
    93.5 * Math.cos(3 * phi) +
    0.118 * Math.cos(5 * phi);

  return {
    centerLat,
    centerLon,
    mPerDegLat,
    mPerDegLon,

    forward(lat, lon) {
      return [(lon - centerLon) * mPerDegLon, (lat - centerLat) * mPerDegLat];
    },

    inverse(x, y) {
      return [centerLat + y / mPerDegLat, centerLon + x / mPerDegLon];
    },

    metresToDegLat(m) {
      return m / mPerDegLat;
    },
    metresToDegLon(m) {
      return m / mPerDegLon;
    },
  };
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
