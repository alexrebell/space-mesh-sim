// tasking_gb.js — панель "Задание ГБ" (uplink+downlink маршруты, оценка времени передачи)

(function () {
  "use strict";

  // -------------------------
  // Utils
  // -------------------------
  const $ = (id) => document.getElementById(id);

  function parseNum(v) {
    return parseFloat(String(v ?? "").trim().replace(",", "."));
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function getViewer() {
    return window.viewer || window.cesiumViewer || window.spaceMesh?.viewer || null;
  }

  function getClock() {
    return getViewer()?.clock || null;
  }

  function nowJulian(clock) {
    return clock?.currentTime || Cesium.JulianDate.now();
  }

  function cartesianToLonLat(cart) {
    const carto = Cesium.Cartographic.fromCartesian(cart);
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      alt: carto.height || 0,
    };
  }

  function rectCenter(rect) {
    return { lon: (rect.lonMin + rect.lonMax) * 0.5, lat: (rect.latMin + rect.latMax) * 0.5 };
  }

  function rectContains(rect, lon, lat) {
    return !!rect && lon >= rect.lonMin && lon <= rect.lonMax && lat >= rect.latMin && lat <= rect.latMax;
  }

  // -------------------------
  // Segment/Rect intersection (anti-skip)
  // -------------------------
  function segmentIntersectsRect(x1, y1, x2, y2, r) {
    if (rectContains(r, x1, y1) || rectContains(r, x2, y2)) return true;

    const minx = Math.min(x1, x2), maxx = Math.max(x1, x2);
    const miny = Math.min(y1, y2), maxy = Math.max(y1, y2);
    if (maxx < r.lonMin || minx > r.lonMax || maxy < r.latMin || miny > r.latMax) return false;

    const rx1 = r.lonMin, ry1 = r.latMin;
    const rx2 = r.lonMax, ry2 = r.latMin;
    const rx3 = r.lonMax, ry3 = r.latMax;
    const rx4 = r.lonMin, ry4 = r.latMax;

    return (
      segmentsIntersect(x1, y1, x2, y2, rx1, ry1, rx2, ry2) ||
      segmentsIntersect(x1, y1, x2, y2, rx2, ry2, rx3, ry3) ||
      segmentsIntersect(x1, y1, x2, y2, rx3, ry3, rx4, ry4) ||
      segmentsIntersect(x1, y1, x2, y2, rx4, ry4, rx1, ry1)
    );
  }

  function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const o1 = orient(ax, ay, bx, by, cx, cy);
    const o2 = orient(ax, ay, bx, by, dx, dy);
    const o3 = orient(cx, cy, dx, dy, ax, ay);
    const o4 = orient(cx, cy, dx, dy, bx, by);

    if (o1 === 0 && onSegment(ax, ay, bx, by, cx, cy)) return true;
    if (o2 === 0 && onSegment(ax, ay, bx, by, dx, dy)) return true;
    if (o3 === 0 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
    if (o4 === 0 && onSegment(cx, cy, dx, dy, bx, by)) return true;

    return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
  }

  function orient(ax, ay, bx, by, cx, cy) {
    const v = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
    if (Math.abs(v) < 1e-12) return 0;
    return v > 0 ? 1 : -1;
  }

  function onSegment(ax, ay, bx, by, px, py) {
    return (
      px >= Math.min(ax, bx) - 1e-12 && px <= Math.max(ax, bx) + 1e-12 &&
      py >= Math.min(ay, by) - 1e-12 && py <= Math.max(ay, by) + 1e-12
    );
  }

  // -------------------------
  // Rect expansion by imaging radius (km -> degrees approx)
  // -------------------------
  function expandRectByKm(rect, radiusKm) {
    const r = Math.max(0, radiusKm || 0);
    if (r <= 0) return rect;

    const c = rectCenter(rect);
    const latRad = Cesium.Math.toRadians(c.lat);

    // ~111.32 km per 1 deg latitude
    const dLat = r / 111.32;

    // ~111.32*cos(lat) km per 1 deg longitude
    const kmPerDegLon = 111.32 * Math.max(0.15, Math.cos(latRad)); // защита от полюсов
    const dLon = r / kmPerDegLon;

    return {
      lonMin: rect.lonMin - dLon,
      lonMax: rect.lonMax + dLon,
      latMin: rect.latMin - dLat,
      latMax: rect.latMax + dLat,
    };
  }

  // -------------------------
  // Data access
  // -------------------------
  function getGroundStations() {
    const gs = window.spaceMesh?.groundStations;
    return gs?.entities || [];
  }

  function getMissionStore() {
    return window.spaceMesh?.missionStore || [];
  }

  function getMissionSats(time) {
    const list = [];
    const store = getMissionStore();
    for (const orbit of store) {
      for (const sat of (orbit.satellites || [])) {
        if (!sat) continue;
        const isMis = sat?.properties?.isMissionSatellite?.getValue?.(time);
        if (!isMis) continue;
        list.push(sat);
      }
    }
    return list;
  }

  function isMissionSat(ent, time) {
    return !!ent?.properties?.isMissionSatellite?.getValue?.(time);
  }

  function getSatState(ent, time) {
    try {
      return ent?.properties?.state?.getValue?.(time) ?? null;
    } catch {
      return null;
    }
  }

  function getEntityById(id) {
    const v = getViewer();
    return v ? v.entities.getById(id) : null;
  }

  // -------------------------
  // NEW: highlight выбранного MIS-КА
  // -------------------------
  function clearMisHighlight() {
    const v = getViewer();
    if (!v) return;
    const h = v.entities.getById(gb.misHighlightId);
    if (h) v.entities.remove(h);
  }

  function setMisHighlight(misId, { flyTo = false } = {}) {
    const v = getViewer();
    if (!v) return;

    if (!misId) {
      clearMisHighlight();
      return;
    }

    const target = getEntityById(misId);
    if (!target || !target.position) return;

    let h = v.entities.getById(gb.misHighlightId);
    if (!h) {
      h = v.entities.add({
        id: gb.misHighlightId,
        name: "Выбранный MIS-КА (подсветка)",
        position: target.position, // привязка к Property → маркер следует за КА
        point: {
          pixelSize: 18,
          color: Cesium.Color.YELLOW.withAlpha(0.85),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    } else {
      h.position = target.position;
    }

    // Дополнительно: подсветка через стандартный selectedEntity (InfoBox/выделение)
    // v.selectedEntity = target;

    if (flyTo && typeof v.flyTo === "function") {
      v.flyTo(target, { duration: 1.0 });
    }
  }

  // Найти имя орбиты, к которой принадлежит выбранный MIS
  function findOrbitNameForMisId(misId) {
    const store = getMissionStore();
    for (const orbit of store) {
      for (const sat of (orbit.satellites || [])) {
        if (!sat) continue;
        if (sat.id === misId) {
          return orbit?.name || orbit?.id || "—";
        }
      }
    }
    return "—";
  }

  // -------------------------
  // UI state
  // -------------------------
  const gb = {
    panelShown: false,
    targetRect: null,

    targetEntityId: "TASKING_GB:TARGET_RECT",
    bufferEntityId: "TASKING_GB:TARGET_BUFFER_RECT",

    uplinkRouteId: "TASKING_GB:UPLINK_ROUTE",
    downlinkRouteId: "TASKING_GB:DOWNLINK_ROUTE",

    // NEW
    misHighlightId: "TASKING_GB:SELECTED_MIS_HIGHLIGHT",

    chosenMisId: null,

    lastUplinkGsId: null,
    lastDownlinkGsId: null,
    lastUplinkRoute: null,
    lastDownlinkRoute: null,
    lastBottleneckUplinkMbps: null,
    lastBottleneckDownlinkMbps: null,
  };

  // -------------------------
  // Draggable
  // -------------------------
  function makeDraggable(panel, handle, storageKey) {
    if (!panel || !handle) return;

    try {
      const s = localStorage.getItem(storageKey);
      if (s) {
        const pos = JSON.parse(s);
        if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
          panel.style.left = pos.left + "px";
          panel.style.top = pos.top + "px";
        }
      }
    } catch {}

    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const r = panel.getBoundingClientRect();
      startLeft = r.left;
      startTop = r.top;
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = (startLeft + (e.clientX - startX)) + "px";
      panel.style.top = (startTop + (e.clientY - startY)) + "px";
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      try {
        const r = panel.getBoundingClientRect();
        localStorage.setItem(storageKey, JSON.stringify({ left: r.left, top: r.top }));
      } catch {}
    });
  }

  // -------------------------
  // GS selects
  // -------------------------
  function fillStationSelect(selectEl) {
    if (!selectEl) return;
    const time = nowJulian(getClock());
    const stations = getGroundStations();

    selectEl.innerHTML = "";
    for (const ent of stations) {
      const name = ent?.properties?.stationName?.getValue?.(time) || ent?.name || ent?.id;
      const opt = document.createElement("option");
      opt.value = ent.id;
      opt.textContent = String(name).replace(/^Наземная станция:\s*/i, "");
      selectEl.appendChild(opt);
    }
  }

  function refreshGsLists() {
    fillStationSelect($("tasking-gb-gs-uplink"));
    fillStationSelect($("tasking-gb-gs-uplink-manual"));
    fillStationSelect($("tasking-gb-gs-downlink-manual"));
  }

  function updateGsModeUi() {
    const mode = $("tasking-gb-gs-mode")?.value || "auto";
    const autoBox = $("tasking-gb-gs-auto");
    const manualBox = $("tasking-gb-gs-manual");
    if (autoBox) autoBox.style.display = (mode === "auto") ? "" : "none";
    if (manualBox) manualBox.style.display = (mode === "manual") ? "" : "none";
  }

  // -------------------------
  // Rect (parse + draw)
  // -------------------------
  function parseRectFromInputs() {
    const lonMin = parseNum($("tasking-gb-lon-min")?.value);
    const lonMax = parseNum($("tasking-gb-lon-max")?.value);
    const latMin = parseNum($("tasking-gb-lat-min")?.value);
    const latMax = parseNum($("tasking-gb-lat-max")?.value);

    if (![lonMin, lonMax, latMin, latMax].every(Number.isFinite)) return null;

    const r = {
      lonMin: Math.min(lonMin, lonMax),
      lonMax: Math.max(lonMin, lonMax),
      latMin: Math.min(latMin, latMax),
      latMax: Math.max(latMin, latMax),
    };

    return r;
  }

  function rectToCornerPositions(rect) {
    const corners = [
      Cesium.Cartesian3.fromDegrees(rect.lonMin, rect.latMin),
      Cesium.Cartesian3.fromDegrees(rect.lonMax, rect.latMin),
      Cesium.Cartesian3.fromDegrees(rect.lonMax, rect.latMax),
      Cesium.Cartesian3.fromDegrees(rect.lonMin, rect.latMax),
      Cesium.Cartesian3.fromDegrees(rect.lonMin, rect.latMin),
    ];
    return corners;
  }

  function drawOrUpdateRect(rect) {
    const viewer = getViewer();
    if (!viewer) return;

    // Основная область (яркая)
    const corners = rectToCornerPositions(rect);
    const outline = corners.slice(0, 4);

    let ent = viewer.entities.getById(gb.targetEntityId);
    if (!ent) {
      ent = viewer.entities.add({
        id: gb.targetEntityId,
        name: "GB Target Rect",
        polygon: {
          hierarchy: outline,
          material: Cesium.Color.LIME.withAlpha(0.25),
          outline: true,
          outlineColor: Cesium.Color.LIME.withAlpha(1.0),
        },
        polyline: {
          positions: corners,
          width: 3,
          material: Cesium.Color.LIME.withAlpha(1.0),
          clampToGround: false,
        },
      });
    } else {
      if (ent.polygon) ent.polygon.hierarchy = outline;
      if (ent.polyline) ent.polyline.positions = corners;
    }

    // Буферная зона (если радиус > 0)
    drawOrUpdateBufferRect();
  }

  function drawOrUpdateBufferRect() {
    const viewer = getViewer();
    if (!viewer) return;

    const rect = gb.targetRect;
    if (!rect) {
      clearBufferRect();
      return;
    }

    const rKm = getImagingRadiusKm();
    if (rKm <= 0) {
      clearBufferRect();
      return;
    }

    const b = expandRectByKm(rect, rKm);
    const corners = rectToCornerPositions(b);
    const outline = corners.slice(0, 4);

    const dashed = new Cesium.PolylineDashMaterialProperty({
      color: Cesium.Color.CYAN.withAlpha(0.95),
      dashLength: 16,
    });

    let ent = viewer.entities.getById(gb.bufferEntityId);
    if (!ent) {
      ent = viewer.entities.add({
        id: gb.bufferEntityId,
        name: "GB Imaging Buffer Rect",
        polygon: {
          hierarchy: outline,
          material: Cesium.Color.CYAN.withAlpha(0.08),
          outline: true,
          outlineColor: Cesium.Color.CYAN.withAlpha(0.9),
        },
        polyline: {
          positions: corners,
          width: 3,
          material: dashed,
          clampToGround: false,
        },
      });
    } else {
      if (ent.polygon) ent.polygon.hierarchy = outline;
      if (ent.polyline) ent.polyline.positions = corners;
      if (ent.polyline) ent.polyline.material = dashed;
    }
  }

  function clearBufferRect() {
    const viewer = getViewer();
    if (!viewer) return;
    const ent = viewer.entities.getById(gb.bufferEntityId);
    if (ent) viewer.entities.remove(ent);
  }

  function clearRect() {
    const viewer = getViewer();
    if (!viewer) return;

    const ent = viewer.entities.getById(gb.targetEntityId);
    if (ent) viewer.entities.remove(ent);

    clearBufferRect();

    gb.targetRect = null;
    const st = $("tasking-gb-target-status");
    if (st) st.textContent = "—";
  }

  // -------------------------
  // Imaging radius UI + getters
  // -------------------------
  function ensureImagingRadiusUi() {
    if ($("tasking-gb-radius-km")) return;

    const sizeInput = $("tasking-gb-size-mb");
    if (!sizeInput) return;

    const parent = sizeInput.closest(".row") || sizeInput.parentElement;
    if (!parent) return;

    const label = document.createElement("label");
    label.style.width = "100%";
    label.style.marginTop = "6px";
    label.innerHTML = `
      Радиус съёмки, км (0–300):
      <input id="tasking-gb-radius-km" type="number" step="1" min="0" max="300" value="0" />
    `;
    parent.appendChild(label);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.id = "tasking-gb-radius-hint";
    hint.textContent =
      "0 — строго над областью (пересечение прямоугольника). >0 — зона съёмки расширяется на указанный радиус (off-nadir), максимум 300 км.";
    parent.appendChild(hint);

    $("tasking-gb-radius-km")?.addEventListener("input", () => {
      const v = getImagingRadiusKm();
      const inp = $("tasking-gb-radius-km");
      if (inp) inp.value = String(v);

      // Обновляем буферную зону на карте сразу
      if (gb.targetRect) drawOrUpdateBufferRect();
    });
  }

  function getImagingRadiusKm() {
    const raw = parseNum($("tasking-gb-radius-km")?.value ?? 0);
    const v = Number.isFinite(raw) ? raw : 0;
    return clamp(Math.round(v), 0, 300);
  }

  // -------------------------
  // Extra UI: orbit line under "Выбран"
  // -------------------------
  // function ensureOrbitLineUi() {
  //   if ($("tasking-gb-mis-orbit")) return;
  //
  //   const chosen = $("tasking-gb-mis-chosen");
  //   if (!chosen) return;
  //
  //   const host = chosen.parentElement;
  //   if (!host) return;
  //
  //   const line = document.createElement("div");
  //   line.style.marginTop = "4px";
  //   line.style.opacity = "0.95";
  //   line.innerHTML = `Орбита: <span id="tasking-gb-mis-orbit">—</span>`;
  //   host.appendChild(line);
  // }

  function setOrbitUiText(text) {
    const el = $("tasking-gb-mis-orbit");
    if (el) el.textContent = text || "—";
  }

  // -------------------------
  // Pick MIS (segment intersection + optional radius buffer)
  // -------------------------
  function pickBestMissionSat(rect) {
    const viewer = getViewer();
    const clock = getClock();
    if (!viewer || !clock) return null;

    const t0 = nowJulian(clock);

    // Горизонт не "время-ресурс", но ограничение нужно для вычислений
    const horizonSec = 24 * 60 * 60;

    const stepSec = 30;

    const radiusKm = getImagingRadiusKm();
    const effectiveRect = expandRectByKm(rect, radiusKm);

    const sats = getMissionSats(t0);
    let best = null; // {sat, etaSec}

    for (const sat of sats) {
      const st = getSatState(sat, t0);
      if (st && st !== "IDLE") continue;

      let prev = null;
      let foundEta = null;

      for (let dt = 0; dt <= horizonSec; dt += stepSec) {
        const tt = Cesium.JulianDate.addSeconds(t0, dt, new Cesium.JulianDate());
        const pos = sat.position?.getValue?.(tt);
        if (!pos) {
          prev = null;
          continue;
        }

        const cur = cartesianToLonLat(pos);

        if (rectContains(effectiveRect, cur.lon, cur.lat)) {
          foundEta = dt;
          break;
        }

        if (prev && segmentIntersectsRect(prev.lon, prev.lat, cur.lon, cur.lat, effectiveRect)) {
          foundEta = Math.max(0, dt - stepSec);
          break;
        }

        prev = cur;
      }

      if (foundEta == null) continue;
      if (!best || foundEta < best.etaSec) best = { sat, etaSec: foundEta };
    }

    return best;
  }

  function updateChosenUi(misId, etaSec) {
    // ensureOrbitLineUi();

    const c = $("tasking-gb-mis-chosen");
    const e = $("tasking-gb-mis-eta");

    let label = "—";
    let orbitName = "—";

    if (misId) {
      const ent = getEntityById(misId);
      label = ent?.name || misId;
      label = String(label).replace(/^КА:\s*/i, "").replace(/^MIS:\s*/i, "");
      orbitName = findOrbitNameForMisId(misId);
    }

    if (c) c.textContent = label;
    if (e) e.textContent = (etaSec != null ? `${Math.round(etaSec)} c` : "—");
    setOrbitUiText(orbitName);
  }

  // -------------------------
  // Radio routing
  // -------------------------
  function getRadio() {
    return window.spaceMesh?.radio || null;
  }

  function getEdgesSnapshot() {
    const r = getRadio();
    if (!r || typeof r.getActiveEdgesSnapshot !== "function") return null;
    return r.getActiveEdgesSnapshot();
  }

  function routeWeight(edgeInfo) {
    const cap = Math.max(0.0001, edgeInfo.capacityMbps || 0.0001);
    return 1.0 / cap;
  }

  function buildGraphSnapshot(excludeOtherMis, allowedMisId) {
    const time = nowJulian(getClock());

    const snap = getEdgesSnapshot();
    if (!snap || !Array.isArray(snap.edges)) return null;

    const g = new Map();
    const addEdge = (a, b, info) => {
      if (!g.has(a)) g.set(a, []);
      g.get(a).push({ to: b, info });
    };

    function isExcludedMisNode(nodeId) {
      if (!excludeOtherMis) return false;
      if (!nodeId) return false;
      const ent = getEntityById(nodeId);
      if (!ent) return false;

      const isMis = isMissionSat(ent, time);
      if (!isMis) return false;

      return nodeId !== allowedMisId;
    }

    const radio = getRadio();

    for (const e of snap.edges) {
      const a = e.aId;
      const b = e.bId;
      if (!a || !b) continue;

      if (isExcludedMisNode(a) || isExcludedMisNode(b)) continue;

      const distKm = e.distKm ?? null;
      const snrDb = e.snrDb ?? null;

      let cap = e.capacityMbps ?? null;
      if (cap == null && radio && typeof radio.computeCapacityMbps === "function") {
        cap = radio.computeCapacityMbps(snrDb);
      }
      cap = (Number.isFinite(cap) ? cap : 0);

      const info = { distKm, snrDb, capacityMbps: cap };
      info.weight = routeWeight(info);

      addEdge(a, b, info);
      addEdge(b, a, info);
    }

    return { g, time };
  }

  function dijkstra(graph, start, goal) {
    const dist = new Map();
    const prev = new Map();
    const prevEdge = new Map();
    const visited = new Set();

    dist.set(start, 0);

    function minNode() {
      let bestN = null;
      let bestD = Infinity;
      for (const [n, d] of dist.entries()) {
        if (visited.has(n)) continue;
        if (d < bestD) { bestD = d; bestN = n; }
      }
      return bestN;
    }

    while (true) {
      const u = minNode();
      if (!u) break;
      if (u === goal) break;
      visited.add(u);

      const edges = graph.get(u) || [];
      for (const ed of edges) {
        const v = ed.to;
        if (visited.has(v)) continue;
        const w = ed.info?.weight ?? 1;
        const alt = (dist.get(u) ?? Infinity) + w;
        if (alt < (dist.get(v) ?? Infinity)) {
          dist.set(v, alt);
          prev.set(v, u);
          prevEdge.set(v, ed.info);
        }
      }
    }

    if (!dist.has(goal)) return null;

    const path = [];
    const edgesInfo = [];
    let cur = goal;

    while (cur != null) {
      path.push(cur);
      const pe = prevEdge.get(cur);
      if (pe) edgesInfo.push(pe);
      cur = prev.get(cur) ?? null;
      if (cur === start) {
        path.push(start);
        break;
      }
    }

    path.reverse();
    edgesInfo.reverse();
    return { path, edgesInfo };
  }

  function summarizeRoute(route) {
    if (!route) return null;

    const infos = route.edgesInfo || [];
    let minCap = Infinity;
    let minSnr = Infinity;
    let maxDist = 0;

    for (const inf of infos) {
      const cap = Number.isFinite(inf.capacityMbps) ? inf.capacityMbps : 0;
      const snr = Number.isFinite(inf.snrDb) ? inf.snrDb : -999;
      const d = Number.isFinite(inf.distKm) ? inf.distKm : 0;

      if (cap < minCap) minCap = cap;
      if (snr < minSnr) minSnr = snr;
      if (d > maxDist) maxDist = d;
    }

    if (minCap === Infinity) minCap = 0;
    if (minSnr === Infinity) minSnr = 0;

    return { minCapMbps: minCap, minSnrDb: minSnr, maxHopDistKm: maxDist, hops: infos.length };
  }

  function entityPositionAt(ent, time) {
    return ent?.position?.getValue?.(time) || null;
  }

  function clearRouteEntities() {
    const v = getViewer();
    if (!v) return;
    for (const id of [gb.uplinkRouteId, gb.downlinkRouteId]) {
      const e = v.entities.getById(id);
      if (e) v.entities.remove(e);
    }
  }

  function renderRoute(route, entityId, color) {
    const v = getViewer();
    if (!v || !route) return;

    const time = nowJulian(getClock());
    const positions = [];

    for (const nodeId of route.path) {
      const ent = getEntityById(nodeId);
      if (!ent) continue;
      const pos = entityPositionAt(ent, time);
      if (pos) positions.push(pos);
    }

    if (positions.length < 2) return;

    let ent = v.entities.getById(entityId);
    if (!ent) {
      ent = v.entities.add({
        id: entityId,
        name: entityId,
        polyline: {
          positions,
          width: 3,
          material: color.withAlpha(0.9),
          clampToGround: false,
        },
      });
    } else {
      ent.polyline.positions = positions;
    }
  }

  // -------------------------
  // Auto GS selection
  // -------------------------
  function computeBestGsForRoute(fromIdList, toId, allowedMisId) {
    const snap = buildGraphSnapshot(true, allowedMisId);
    if (!snap) return null;

    let best = null;
    for (const gsId of fromIdList) {
      const route = dijkstra(snap.g, gsId, toId);
      if (!route) continue;
      const sum = summarizeRoute(route);
      if (!sum) continue;

      // Максимизируем bottleneck minCap
      if (!best || sum.minCapMbps > best.summary.minCapMbps) {
        best = { gsId, route, summary: sum };
      }
    }
    return best;
  }

  function computeBestDownlinkGs(misId, sameAsUplink, uplinkGsId) {
    const stations = getGroundStations();
    const gsIds = stations.map(s => s.id);

    const snap = buildGraphSnapshot(true, misId);
    if (!snap) return null;

    if (sameAsUplink && uplinkGsId) {
      const route = dijkstra(snap.g, misId, uplinkGsId);
      return { gsId: uplinkGsId, route, summary: summarizeRoute(route) };
    }

    let best = null;
    for (const gsId of gsIds) {
      const route = dijkstra(snap.g, misId, gsId);
      if (!route) continue;
      const sum = summarizeRoute(route);
      if (!sum) continue;

      if (!best || sum.minCapMbps > best.summary.minCapMbps) {
        best = { gsId, route, summary: sum };
      }
    }
    return best;
  }

  // -------------------------
  // Transfer math
  // -------------------------
  function getResultDataMbits() {
    const mb = parseNum($("tasking-gb-size-mb")?.value || "10240");
    const MB = Number.isFinite(mb) ? mb : 10240;
    return Math.max(0.001, MB * 8.0);
  }

  function formatTimeSeconds(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "—";
    if (sec < 60) return `${Math.round(sec)} c`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec - m * 60);
    if (m < 60) return `${m} мин ${s} c`;
    const h = Math.floor(m / 60);
    const mm = m - h * 60;
    return `${h} ч ${mm} мин`;
  }

  // -------------------------
  // Build & render (uplink/downlink)
  // -------------------------
  function buildAndRenderRoutesSnapshot() {
    const misId = gb.chosenMisId;
    if (!misId) return;

    const mode = $("tasking-gb-gs-mode")?.value || "auto";
    const same = !!$("tasking-gb-same-gs")?.checked;

    const stations = getGroundStations();
    const gsIds = stations.map(s => s.id);

    let uplinkGsId = null;
    let downlinkGsId = null;
    let uplinkRoute = null;
    let downlinkRoute = null;

    if (mode === "manual") {
      uplinkGsId = $("tasking-gb-gs-uplink-manual")?.value || null;
      downlinkGsId = $("tasking-gb-gs-downlink-manual")?.value || null;

      const snap = buildGraphSnapshot(true, misId);
      if (snap && uplinkGsId) uplinkRoute = dijkstra(snap.g, uplinkGsId, misId);
      if (snap && downlinkGsId) downlinkRoute = dijkstra(snap.g, misId, downlinkGsId);
    } else {
      const bestUp = computeBestGsForRoute(gsIds, misId, misId);
      uplinkGsId = bestUp?.gsId || null;
      uplinkRoute = bestUp?.route || null;

      const upSel = $("tasking-gb-gs-uplink");
      if (upSel && uplinkGsId) upSel.value = uplinkGsId;

      const bestDown = computeBestDownlinkGs(misId, same, uplinkGsId);
      downlinkGsId = bestDown?.gsId || null;
      downlinkRoute = bestDown?.route || null;
    }

    gb.lastUplinkGsId = uplinkGsId;
    gb.lastDownlinkGsId = downlinkGsId;
    gb.lastUplinkRoute = uplinkRoute;
    gb.lastDownlinkRoute = downlinkRoute;

    const upSum = summarizeRoute(uplinkRoute);
    const downSum = summarizeRoute(downlinkRoute);

    gb.lastBottleneckUplinkMbps = upSum?.minCapMbps ?? null;
    gb.lastBottleneckDownlinkMbps = downSum?.minCapMbps ?? null;

    clearRouteEntities();
    if (uplinkRoute) renderRoute(uplinkRoute, gb.uplinkRouteId, Cesium.Color.LIME);
    if (downlinkRoute) renderRoute(downlinkRoute, gb.downlinkRouteId, Cesium.Color.CYAN);

    const upSt = $("tasking-gb-uplink-status");
    const downSt = $("tasking-gb-downlink-status");
    const upBn = $("tasking-gb-uplink-bottleneck");
    const downBn = $("tasking-gb-downlink-bottleneck");
    const est = $("tasking-gb-est-time");

    if (upSt) upSt.textContent = uplinkRoute ? `OK (${uplinkRoute.path.length - 1} hop)` : "маршрут не найден";
    if (downSt) downSt.textContent = downlinkRoute ? `OK (${downlinkRoute.path.length - 1} hop)` : "маршрут не найден";

    if (upBn) upBn.textContent = upSum ? `${upSum.minCapMbps.toFixed(2)} Mbps (min), SNR min ${upSum.minSnrDb.toFixed(1)} dB` : "—";
    if (downBn) downBn.textContent = downSum ? `${downSum.minCapMbps.toFixed(2)} Mbps (min), SNR min ${downSum.minSnrDb.toFixed(1)} dB` : "—";

    const dataMbits = getResultDataMbits();
    const downCap = downSum?.minCapMbps ?? 0;

    if (est) {
      if (!downlinkRoute || downCap <= 0.0001) {
        est.textContent = "— (нет downlink маршрута)";
      } else {
        const sec = dataMbits / downCap;
        est.textContent = `${formatTimeSeconds(sec)} (по bottleneck ${downCap.toFixed(2)} Mbps)`;
      }
    }

    const st = $("tasking-gb-status");
    if (st) {
      const upName = uplinkGsId ? (getEntityById(uplinkGsId)?.name || uplinkGsId) : "—";
      const downName = downlinkGsId ? (getEntityById(downlinkGsId)?.name || downlinkGsId) : "—";
      st.textContent =
        `Uplink: ${String(upName).replace(/^Наземная станция:\s*/i, "")} | Downlink: ${String(downName).replace(/^Наземная станция:\s*/i, "")}`;
    }
  }

  // -------------------------
  // Scenario start
  // -------------------------
  function startGbScenario() {
    const rect = gb.targetRect;
    const st = $("tasking-gb-status");

    if (!rect) { if (st) st.textContent = "Сначала задайте целевую область."; return; }
    if (!gb.chosenMisId) { if (st) st.textContent = "Сначала выберите MIS-КА (исполнителя)."; return; }

    buildAndRenderRoutesSnapshot();
  }

  // -------------------------
  // Toggle panel
  // -------------------------
  function setPanelVisible(visible) {
    const panel = $("tasking-gb-panel");
    const toggle = $("tasking-gb-toggle");
    if (!panel || !toggle) return;

    gb.panelShown = visible;

    if (visible) {
      panel.classList.remove("hidden");
      toggle.textContent = "▲ Задание ГБ";
    } else {
      panel.classList.add("hidden");
      toggle.textContent = "▼ Задание ГБ";
    }
  }

  // -------------------------
  // Init
  // -------------------------
  function init() {
    const panel = $("tasking-gb-panel");
    const toggle = $("tasking-gb-toggle");

    ensureImagingRadiusUi();
    // ensureOrbitLineUi();

    if (toggle) {
      toggle.addEventListener("click", () => setPanelVisible(!gb.panelShown));
    }

    const h1 = panel?.querySelector("h1");
    if (panel && h1) makeDraggable(panel, h1, "taskingGbPanelPos");

    $("tasking-gb-gs-mode")?.addEventListener("change", () => {
      updateGsModeUi();
      if (gb.chosenMisId) buildAndRenderRoutesSnapshot();
    });

    $("tasking-gb-refresh-gs")?.addEventListener("click", (e) => {
      e.preventDefault();
      refreshGsLists();
    });

    $("tasking-gb-apply-rect")?.addEventListener("click", (e) => {
      e.preventDefault();
      const r = parseRectFromInputs();
      const st = $("tasking-gb-target-status");
      if (!r) {
        if (st) st.textContent = "ошибка координат";
        return;
      }
      gb.targetRect = r;
      drawOrUpdateRect(r);

      const c = rectCenter(r);
      if (st) st.textContent = `OK (центр: ${c.lat.toFixed(3)}, ${c.lon.toFixed(3)})`;
    });

    $("tasking-gb-clear-rect")?.addEventListener("click", (e) => {
      e.preventDefault();
      clearRect();
    });

    $("tasking-gb-pick-mis")?.addEventListener("click", (e) => {
      e.preventDefault();
      const st = $("tasking-gb-status");
      const rect = gb.targetRect;
      if (!rect) {
        if (st) st.textContent = "Сначала задайте целевую область.";
        return;
      }

      const best = pickBestMissionSat(rect);
      if (!best) {
        if (st) st.textContent = "Не найден подходящий MIS-КА.";
        gb.chosenMisId = null;
        updateChosenUi(null, null);

        // NEW: убрать подсветку
        setMisHighlight(null);

        return;
      }

      gb.chosenMisId = best.sat.id;
      updateChosenUi(best.sat.id, best.etaSec);

      // NEW: подсветить выбранный MIS
      setMisHighlight(best.sat.id);

      const rKm = getImagingRadiusKm();
      if (st) st.textContent = rKm > 0
        ? `ГОТОВО К ОТПРАВКЕ (радиус съёмки: ${rKm} км)`
        : "ГОТОВО К ОТПРАВКЕ (строго над областью)";

      buildAndRenderRoutesSnapshot();
    });

    $("tasking-gb-send")?.addEventListener("click", (e) => {
      e.preventDefault();
      startGbScenario();
    });

    $("tasking-gb-size-mb")?.addEventListener("input", () => {
      if (gb.chosenMisId) buildAndRenderRoutesSnapshot();
    });

    $("tasking-gb-same-gs")?.addEventListener("change", () => {
      if (gb.chosenMisId) buildAndRenderRoutesSnapshot();
    });

    // При смене радиуса — обновляем буфер и (если есть MIS) маршруты
    $("tasking-gb-radius-km")?.addEventListener("input", () => {
      if (gb.targetRect) drawOrUpdateBufferRect();
      if (gb.chosenMisId) buildAndRenderRoutesSnapshot();
    });

    window.addEventListener("spaceMesh:radioTick", () => {
      if (!gb.panelShown) return;
      if (!gb.chosenMisId) return;
      buildAndRenderRoutesSnapshot();
    });

    refreshGsLists();
    updateGsModeUi();
    setPanelVisible(false);

    // Если область уже есть (например, после hot-reload) — перерисуем
    if (gb.targetRect) drawOrUpdateRect(gb.targetRect);
$("tasking-gb-reset-mis")?.addEventListener("click", (e) => {
  e.preventDefault();

  gb.chosenMisId = null;

  // очистить UI выбранного MIS
  updateChosenUi(null, null);

  // убрать подсветку
  setMisHighlight(null);

  // убрать маршруты uplink/downlink с карты
  clearRouteEntities();

  // сбросить статусы/поля расчётов
  $("tasking-gb-status") && ($("tasking-gb-status").textContent = "Исполнитель сброшен.");
  $("tasking-gb-uplink-status") && ($("tasking-gb-uplink-status").textContent = "—");
  $("tasking-gb-downlink-status") && ($("tasking-gb-downlink-status").textContent = "—");
  $("tasking-gb-uplink-bottleneck") && ($("tasking-gb-uplink-bottleneck").textContent = "—");
  $("tasking-gb-downlink-bottleneck") && ($("tasking-gb-downlink-bottleneck").textContent = "—");
  $("tasking-gb-est-time") && ($("tasking-gb-est-time").textContent = "—");

  // сбросить кэш последнего маршрута
  gb.lastUplinkGsId = null;
  gb.lastDownlinkGsId = null;
  gb.lastUplinkRoute = null;
  gb.lastDownlinkRoute = null;
  gb.lastBottleneckUplinkMbps = null;
  gb.lastBottleneckDownlinkMbps = null;
});


  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
