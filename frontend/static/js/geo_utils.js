// static/js/geo_utils.js
// Единый набор гео-утилит для проекта Space Mesh Simulator.
//
// API:
//   window.spaceMesh.ecefToGeo(cartesian3) -> { lat, lon, h_m }
//   window.spaceMesh.formatGeo(geo, opts) -> string
//
// Примечание:
// - В Cesium позиция Entity задаётся в ECEF (Earth-Centered, Earth-Fixed) через Cartesian3.
// - Для "где КА над Землёй" обычно нужны геодезические координаты WGS‑84: широта/долгота/высота.

(function () {
  if (typeof Cesium === "undefined") {
    console.warn("geo_utils.js: Cesium не найден, гео-утилиты не подключены.");
    return;
  }

  window.spaceMesh = window.spaceMesh || {};

  /**
   * Переводит ECEF (Cartesian3) в геодезические координаты WGS‑84.
   * @param {Cesium.Cartesian3} cartesian
   * @returns {{lat:number, lon:number, h_m:number} | null}
   */
  function ecefToGeo(cartesian) {
    if (!cartesian) return null;
    const c = Cesium.Cartographic.fromCartesian(cartesian);
    if (!c) return null;

    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
      h_m: c.height
    };
  }

  /**
   * Красиво форматирует координаты для UI.
   * @param {{lat:number, lon:number, h_m:number}} geo
   * @param {{latDigits?:number, lonDigits?:number, altDigits?:number, altUnit?:"m"|"km"}} [opts]
   */
  function formatGeo(geo, opts) {
    if (!geo) return "—";
    const o = opts || {};
    const latDigits = Number.isFinite(o.latDigits) ? o.latDigits : 4;
    const lonDigits = Number.isFinite(o.lonDigits) ? o.lonDigits : 4;
    const altDigits = Number.isFinite(o.altDigits) ? o.altDigits : 2;
    const altUnit = o.altUnit || "km";

    const lat = Number.isFinite(geo.lat) ? geo.lat.toFixed(latDigits) : "—";
    const lon = Number.isFinite(geo.lon) ? geo.lon.toFixed(lonDigits) : "—";

    let alt = "—";
    if (Number.isFinite(geo.h_m)) {
      alt = altUnit === "m"
        ? geo.h_m.toFixed(altDigits)
        : (geo.h_m / 1000).toFixed(altDigits);
    }

    return `${lat}°, ${lon}°, ${alt} ${altUnit}`;
  }

  // Экспортируем (не перетирая чужие поля)
  window.spaceMesh.ecefToGeo = ecefToGeo;
  window.spaceMesh.formatGeo = formatGeo;
})();
