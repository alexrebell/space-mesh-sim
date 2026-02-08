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

  function clearMisHighlight() {
  const v = getViewer();
  if (!v) return;
  const h = v.entities.getById(gb.misHighlightId);
  if (h) v.entities.remove(h);
}

function setMisHighlight(misId) {
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
      position: target.position,
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
}

  // -------------------------
  // UI state
  // -------------------------
  const gb = {
    panelShown: false,
    targetRect: null,

    targetEntityId: "TASKING_GB:TARGET_RECT",
    bufferEntityId: "TASKING_GB:TARGET_BUFFER_RECT",

    // Линии маршрутов (префиксы используются для набора сегментов)
    uplinkRoutePrefix: "TASKING_GB:UPLINK_ROUTE:",
    downlinkRoutePrefix: "TASKING_GB:DOWNLINK_ROUTE:",

    misHighlightId: "TASKING_GB:SELECTED_MIS_HIGHLIGHT",

    chosenMisId: null,
    chosenEtaSec: null,

    lastUplinkGsId: null,
    lastDownlinkGsId: null,
    lastUplinkRoute: null,
    lastDownlinkRoute: null,
    lastBottleneckUplinkMbps: null,
    lastBottleneckDownlinkMbps: null,
    fixedUplinkGsId: null,
    fixedDownlinkGsId: null,
    lastStationText: "—",

    // Сценарий (uplink → ожидание области → съёмка → downlink)
    task: null,
    taskTimer: null,

    // защита от двойного навешивания обработчиков
    _resetBound: false,
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
  // Imaging duration UI + getter
  // -------------------------
  function ensureImagingDurationUi() {
    if ($("tasking-gb-duration-sec")) return;

    const sizeInput = $("tasking-gb-size-mb");
    if (!sizeInput) return;

    const parent = sizeInput.closest(".row") || sizeInput.parentElement;
    if (!parent) return;

    const manualRow = document.createElement("div");
    manualRow.className = "gb-duration-block";
    manualRow.style.width = "100%";
    manualRow.style.display = "flex";
    manualRow.style.flexDirection = "column";
    manualRow.style.gap = "6px";
    manualRow.innerHTML = `
      <label class="gb-duration-toggle">
        <input id="tasking-gb-duration-manual" type="checkbox" />
        <span>Задать время съёмки вручную</span>
      </label>
      <label class="gb-duration-input">
        Время съёмки, c:
        <input id="tasking-gb-duration-sec" type="number" min="1" max="3600" step="1" value="10" disabled />
      </label>
      <div class="hint" id="tasking-gb-duration-hint"></div>
    `;

    parent.appendChild(manualRow);

    const manualCb = $("tasking-gb-duration-manual");
    const durInput = $("tasking-gb-duration-sec");
    if (manualCb && durInput) {
      manualCb.addEventListener("change", () => {
        durInput.disabled = !manualCb.checked;
      });
      durInput.addEventListener("input", () => {
        const v = parseFloat(durInput.value);
        if (!Number.isFinite(v) || v < 1) durInput.value = "10";
      });
    }
  }

  function getImagingDurationSeconds(rect) {
    const manual = $("tasking-gb-duration-manual")?.checked;
    const durInput = $("tasking-gb-duration-sec");
    if (manual && durInput) {
      const v = parseFloat(durInput.value);
      const sec = Number.isFinite(v) ? clamp(v, 1, 3600) : 10;
      durInput.value = String(sec);
      return sec;
    }

    // Автоматическая оценка: вдольтрековая протяжённость / скорость пролёта
    if (!rect) return 30;
    const rKm = getImagingRadiusKm();
    const eff = expandRectByKm(rect, rKm);
    const midLat = (eff.latMin + eff.latMax) * 0.5;
    const latRad = Cesium.Math.toRadians(midLat);
    const kmPerDegLat = 111.32;
    const kmPerDegLon = 111.32 * Math.max(0.2, Math.cos(latRad));
    const heightKm = Math.max(0, (eff.latMax - eff.latMin) * kmPerDegLat);
    const widthKm = Math.max(0, (eff.lonMax - eff.lonMin) * kmPerDegLon);

    const groundSpeedKms = 7.5; // прибл. скорость проекции LEO
    const alongTrackKm = Math.max(heightKm, 1);
    let sec = alongTrackKm / groundSpeedKms;

    // если полоса слишком узкая относительно ширины — добавим коэффициент
    const swathKm = Math.max(2 * rKm, widthKm * 0.5);
    if (swathKm < widthKm) {
      sec *= widthKm / Math.max(swathKm, 1);
    }

    sec = clamp(sec, 5, 1800);
    return sec;
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

    // Обновим подсказку по оценке времени съёмки (авто/ручной)
    const hint = $("tasking-gb-duration-hint");
    if (hint) {
      const rect = gb.targetRect;
      const sec = getImagingDurationSeconds(rect);
      hint.textContent = `Оценка времени съёмки: ~${sec.toFixed(0)} c`;
    }
  }

  // -------------------------
  // Radio routing (используем активные sat↔sat рёбра из radio.js + добавляем GS↔sat рёбра)
  // -------------------------
  function getRadio() {
    return window.spaceMesh?.radio || null;
  }

  function getEdgesSnapshot() {
    const r = getRadio();
    if (!r || typeof r.getActiveEdgesSnapshot !== "function") return [];
    // radio.js возвращает МАССИВ активных рёбер (не объект)
    return r.getActiveEdgesSnapshot() || [];
  }

  function getOrbitStore() {
    return window.spaceMesh?.orbitStore || window.spaceMesh?.orbits || [];
  }

  function getMeshSats(time) {
    const list = [];
    const store = getOrbitStore();
    for (const orbit of store) {
      for (const sat of (orbit.satellites || [])) {
        if (!sat) continue;
        const isMis = sat?.properties?.isMissionSatellite?.getValue?.(time);
        if (isMis) continue;
        list.push(sat);
      }
    }
    return list;
  }

  function elevationDeg(gsPos, satPos) {
    // копия логики из tasking.js: угол места над горизонтом для GS→sat
    const m = Cesium.Transforms.eastNorthUpToFixedFrame(gsPos);
    const inv = Cesium.Matrix4.inverse(m, new Cesium.Matrix4());
    const satLocal = Cesium.Matrix4.multiplyByPoint(inv, satPos, new Cesium.Cartesian3());

    // satLocal: x=east, y=north, z=up
    const x = satLocal.x, y = satLocal.y, z = satLocal.z;
    const horiz = Math.sqrt(x * x + y * y);
    const el = Math.atan2(z, horiz);
    return Cesium.Math.toDegrees(el);
  }

  /**
   * Собираем граф на текущий момент времени.
   * - sat↔sat: из radio.getActiveEdgesSnapshot()
   * - GS↔sat: добавляем вручную по LOS/углу места, только к mesh-КА (НЕ к MIS)
   * - excludeOtherMis: выкидываем все MIS кроме allowedMisId
   */
  function buildGraphSnapshot(time, gsEnt, excludeOtherMis, allowedMisId) {
    const radio = getRadio();
    const viewer = getViewer();
    if (!radio || !viewer) return null;

    const cfg = radio.getConfig?.() || {};
    const minSnr = cfg.minSnrDb ?? 5;
    const rxSens = cfg.rxSensDbm ?? -100;
    const maxRangeKm = cfg.maxRangeKm ?? 0;

    /** @type {Map<string, Array<{to:string, edge:any}>>} */
    const adj = new Map();
    const addEdge = (from, to, edge) => {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from).push({ to, edge });
    };

    const isExcludedMisNode = (nodeId) => {
      if (!excludeOtherMis) return false;
      if (!nodeId) return false;
      const ent = getEntityById(nodeId);
      if (!ent) return false;
      const isMis = isMissionSat(ent, time);
      if (!isMis) return false;
      return nodeId !== allowedMisId;
    };

    // 1) sat↔sat рёбра из radio.js
    const edges = getEdgesSnapshot();
    for (const e of edges) {
      if (!e || !e.aId || !e.bId) continue;

      // normalize имён полей
      const distKm = (e.distanceKm ?? e.distKm);
      const snrDb = e.snrDb ?? null;
      const rxPowerDbm = e.rxPowerDbm ?? null;

      if (maxRangeKm > 0 && Number.isFinite(distKm) && distKm > maxRangeKm) continue;
      if (Number.isFinite(snrDb) && snrDb < minSnr) continue;
      if (Number.isFinite(rxPowerDbm) && rxPowerDbm < rxSens) continue;

      const a = e.aId, b = e.bId;
      if (isExcludedMisNode(a) || isExcludedMisNode(b)) continue;

      let capMbps = e.capacityMbps ?? null;
      if (capMbps == null && typeof radio.computeCapacityMbps === "function" && Number.isFinite(snrDb)) {
        capMbps = radio.computeCapacityMbps(snrDb);
      }
      capMbps = Number.isFinite(capMbps) ? capMbps : 0;

      const edge = {
        kind: "sat",
        aId: a,
        bId: b,
        distanceKm: Number.isFinite(distKm) ? distKm : null,
        snrDb: Number.isFinite(snrDb) ? snrDb : null,
        rxPowerDbm: Number.isFinite(rxPowerDbm) ? rxPowerDbm : null,
        capacityMbps: capMbps
      };

      addEdge(a, b, edge);
      addEdge(b, a, edge);
    }

    // 2) GS↔sat рёбра
    if (gsEnt) {
      const gsPos = gsEnt.position?.getValue?.(time);
      const minEl = gsEnt.properties?.minElevationDeg?.getValue?.(time) ?? 10;
      if (gsPos) {
        const meshSats = getMeshSats(time);
        for (const sat of meshSats) {
          const satPos = sat.position?.getValue?.(time);
          if (!satPos) continue;

          const el = elevationDeg(gsPos, satPos);
          if (el < minEl) continue;

          const distM = Cesium.Cartesian3.distance(gsPos, satPos);
          const distKm = distM / 1000;
          if (maxRangeKm > 0 && distKm > maxRangeKm) continue;

          const b = radio.computeBudgetForDistanceMeters?.(distM);
          if (!b) continue;
          if (Number.isFinite(b.rxPowerDbm) && b.rxPowerDbm < rxSens) continue;
          if (Number.isFinite(b.snrDb) && b.snrDb < minSnr) continue;

          const capMbps = radio.computeCapacityMbps?.(b.snrDb);
          const edge = {
            kind: "gs",
            aId: gsEnt.id,
            bId: sat.id,
            distanceKm: distKm,
            snrDb: b.snrDb,
            rxPowerDbm: b.rxPowerDbm,
            noiseFloorDbm: b.noiseFloorDbm,
            capacityMbps: Number.isFinite(capMbps) ? capMbps : 0
          };

          addEdge(gsEnt.id, sat.id, edge);
          addEdge(sat.id, gsEnt.id, edge);
        }
      }
    }

    return { adj, cfg };
  }

  function routeWeight(edge, metric, dataMbits, cfg) {
    const hopPenalty = 0.05;

    const d = Number.isFinite(edge.distanceKm) ? edge.distanceKm : 1e9;
    const snr = Number.isFinite(edge.snrDb) ? edge.snrDb : -999;
    const cap = Number.isFinite(edge.capacityMbps) ? edge.capacityMbps : (cfg?.dataRateMbps ?? 1);
    const minSnr = cfg?.minSnrDb ?? 5;

    if (metric === "short") return d + hopPenalty;

    if (metric === "reliable") {
      const deficit = Math.max(0, (minSnr - snr));
      const penalty = 1 + (deficit / Math.max(1, minSnr)) * 10;
      return d * penalty + hopPenalty;
    }

    const t = dataMbits / Math.max(0.001, cap);
    return t + hopPenalty;
  }

  function dijkstra(adj, start, goal, metric, dataMbits, cfg) {
    const dist = new Map();
    const prev = new Map();
    const visited = new Set();

    dist.set(start, 0);

    while (true) {
      let u = null;
      let best = Infinity;
      for (const [node, d] of dist.entries()) {
        if (visited.has(node)) continue;
        if (d < best) { best = d; u = node; }
      }
      if (u === null) break;
      if (u === goal) break;
      visited.add(u);

      const edges = adj.get(u) || [];
      for (const { to, edge } of edges) {
        if (visited.has(to)) continue;
        const w = routeWeight(edge, metric, dataMbits, cfg);
        const alt = best + w;
        if (alt < (dist.get(to) ?? Infinity)) {
          dist.set(to, alt);
          prev.set(to, { u, edge });
        }
      }
    }

    if (!dist.has(goal)) return null;

    const path = [];
    const edgesInfo = [];
    let cur = goal;
    while (cur !== start) {
      path.push(cur);
      const p = prev.get(cur);
      if (!p) break;
      edgesInfo.push(p.edge);
      cur = p.u;
    }
    path.push(start);
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
      const d = Number.isFinite(inf.distanceKm) ? inf.distanceKm : 0;

      if (cap < minCap) minCap = cap;
      if (snr < minSnr) minSnr = snr;
      if (d > maxDist) maxDist = d;
    }

    if (minCap === Infinity) minCap = 0;
    if (minSnr === Infinity) minSnr = 0;

    return { minCapMbps: minCap, minSnrDb: minSnr, maxHopDistKm: maxDist, hops: infos.length };
  }

  // -------------------------
  // Render route (динамические сегменты)
  // -------------------------
  function clearRouteEntitiesByPrefix(prefix) {
    const v = getViewer();
    if (!v) return;
    const toRemove = [];
    for (const e of v.entities.values) {
      if (e?.id && String(e.id).startsWith(prefix)) toRemove.push(e);
    }
    for (const e of toRemove) v.entities.remove(e);
  }

  function renderRoute(route, prefix, color) {
    const v = getViewer();
    if (!v || !route) return;

    clearRouteEntitiesByPrefix(prefix);

    // Яркие и толстые линии без сглаживания: сплошной цвет с контуром.
    const routeMaterial = new Cesium.PolylineOutlineMaterialProperty({
      color: color.withAlpha(1.0),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
      outlineWidth: 2.5
    });

    for (let i = 0; i < route.path.length - 1; i++) {
      const aId = route.path[i];
      const bId = route.path[i + 1];

      const aEnt = getEntityById(aId);
      const bEnt = getEntityById(bId);
      if (!aEnt || !bEnt) continue;

      const id = `${prefix}${i}`;
      const positions = new Cesium.CallbackProperty(() => {
        const t = nowJulian(getClock());
        const aPos = aEnt.position?.getValue?.(t);
        const bPos = bEnt.position?.getValue?.(t);
        if (!aPos || !bPos) return [];
        return [aPos, bPos];
      }, false);

      v.entities.add({
        id,
        name: id,
        polyline: {
          positions,
          width: 7,
          material: routeMaterial,
          clampToGround: false,
          arcType: Cesium.ArcType.NONE, // прямой сегмент без дуги
          depthFailMaterial: routeMaterial, // рисуем и когда уходит в землю
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    }

    // Маркер на конце маршрута (стрелка/кружок), не больше толщины линии.
    const lastId = route.path[route.path.length - 1];
    const lastEnt = getEntityById(lastId);
    if (lastEnt) {
      const endPos = new Cesium.CallbackProperty(() => {
        const t = nowJulian(getClock());
        return lastEnt.position?.getValue?.(t) || null;
      }, false);

      v.entities.add({
        id: `${prefix}end`,
        position: endPos,
        point: {
          pixelSize: 8, // чуть больше 7, но компактно
          color: color.withAlpha(1.0),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
    }
  }

  // -------------------------
  // Auto GS selection
  // -------------------------
  function groundDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = Cesium.Math.toRadians(lat2 - lat1);
    const dLon = Cesium.Math.toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(Cesium.Math.toRadians(lat1)) *
        Math.cos(Cesium.Math.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function stationPosCartesian(gs) {
    return Cesium.Cartesian3.fromDegrees(
      gs.properties?.lon ?? gs.lon,
      gs.properties?.lat ?? gs.lat,
      gs.properties?.alt_m ?? gs.alt_m ?? 0
    );
  }

  function misCartoAtTime(misEnt, time) {
    const pos = misEnt?.position?.getValue?.(time);
    if (!pos) return null;
    return Cesium.Cartographic.fromCartesian(pos);
  }

  function hasLoSStationAtTime(gs, misEnt, time) {
    const gsPos = stationPosCartesian(gs);
    const satPos = misEnt?.position?.getValue?.(time);
    if (!gsPos || !satPos) return false;

    const minEl = gs.properties?.minElevationDeg?.getValue?.(time) ?? gs.properties?.min_elevation_deg ?? 10;

    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(gsPos);
    const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
    const rel = Cesium.Cartesian3.subtract(satPos, gsPos, new Cesium.Cartesian3());
    const rel4 = new Cesium.Cartesian4(rel.x, rel.y, rel.z, 0.0);
    const enu4 = Cesium.Matrix4.multiplyByVector(inv, rel4, new Cesium.Cartesian4());
    const e = enu4.x, n = enu4.y, u = enu4.z;
    const horiz = Math.sqrt(e * e + n * n);
    const el = Math.atan2(u, horiz);
    const elDeg = Cesium.Math.toDegrees(el);
    return elDeg >= minEl;
  }

  function computeBestUplinkAuto(time, misId, targetRect) {
    const stations = getGroundStations();
    const dataMbits = 1.0;
    const misEnt = getEntityById(misId);
    const misCarto = misCartoAtTime(misEnt, time);

    const targetCenter =
      targetRect
        ? { lon: (targetRect.lonMin + targetRect.lonMax) * 0.5, lat: (targetRect.latMin + targetRect.latMax) * 0.5 }
        : null;

    let best = null;
    for (const gs of stations) {
      const g = buildGraphSnapshot(time, gs, true, misId);
      if (!g) continue;
      const r = dijkstra(g.adj, gs.id, misId, "fast", dataMbits, g.cfg);
      if (!r) continue;
      const sum = summarizeRoute(r);
      if (!sum) continue;

      // Близость к КА и к центру области
      let score = 0;
      if (misCarto) {
        const dSat = groundDistanceKm(
          Cesium.Math.toDegrees(misCarto.latitude),
          Cesium.Math.toDegrees(misCarto.longitude),
          gs.properties?.lat ?? gs.lat,
          gs.properties?.lon ?? gs.lon
        );
        score += dSat;
      }
      if (targetCenter) {
        const dT = groundDistanceKm(targetCenter.lat, targetCenter.lon, gs.properties?.lat ?? gs.lat, gs.properties?.lon ?? gs.lon);
        score += dT * 0.5;
      }

      // Требуем текущую видимость, если есть хоть одна; иначе возьмём наилучший из невидимых
      const visibleNow = hasLoSStationAtTime(gs, misEnt, time);

      if (!best ||
          (visibleNow && !best.visibleNow) ||
          (visibleNow === best.visibleNow && score < best.score)) {
        best = { gsId: gs.id, route: r, summary: sum, score, visibleNow };
      }
    }
    return best;
  }

  function computeBestDownlinkAuto(time, misId, sameAsUplink, uplinkGsId) {
    const stations = getGroundStations();
    const dataMbits = getResultDataMbits();
    const misEnt = getEntityById(misId);

    if (sameAsUplink && uplinkGsId) {
      const gs = stations.find(s => s.id === uplinkGsId);
      if (gs) {
        const g = buildGraphSnapshot(time, gs, true, misId);
        const r = g ? dijkstra(g.adj, misId, uplinkGsId, "fast", dataMbits, g.cfg) : null;
        if (r) return { gsId: uplinkGsId, route: r, summary: summarizeRoute(r) };
      }
    }

    let best = null;
    const fallback = [];

    for (const gs of stations) {
      const g = buildGraphSnapshot(time, gs, true, misId);
      if (!g) continue;
      const r = dijkstra(g.adj, misId, gs.id, "fast", dataMbits, g.cfg);
      if (!r) continue;
      const sum = summarizeRoute(r);
      if (!sum) continue;

      const estSec = dataMbits / Math.max(0.001, sum.minCapMbps);
      const futureTime = Cesium.JulianDate.addSeconds(time, estSec, new Cesium.JulianDate());

      // Предсказанная позиция MIS в конце передачи
      const misFutureCarto = misCartoAtTime(misEnt, futureTime);
      const misFutureLoS = hasLoSStationAtTime(gs, misEnt, futureTime);

      let distFutureKm = Number.POSITIVE_INFINITY;
      if (misFutureCarto) {
        distFutureKm = groundDistanceKm(
          Cesium.Math.toDegrees(misFutureCarto.latitude),
          Cesium.Math.toDegrees(misFutureCarto.longitude),
          gs.properties?.lat ?? gs.lat,
          gs.properties?.lon ?? gs.lon
        );
      }

      const hops = (r?.path?.length ?? 1) - 1;
      const candidate = {
        gsId: gs.id,
        route: r,
        summary: sum,
        estSec,
        losFuture: misFutureLoS,
        distFutureKm,
        hops
      };
      fallback.push(candidate);

      if (!misFutureLoS) continue;

      // Критерий: минимальная дистанция в конце передачи, затем время, затем пропускная способность, затем меньше хопов
      if (
        !best ||
        distFutureKm < best.distFutureKm - 1e-6 ||
        (Math.abs(distFutureKm - best.distFutureKm) < 1e-6 && estSec < best.estSec - 1e-6) ||
        (Math.abs(distFutureKm - best.distFutureKm) < 1e-6 && Math.abs(estSec - best.estSec) < 1e-6 && sum.minCapMbps > best.summary.minCapMbps + 1e-6) ||
        (Math.abs(distFutureKm - best.distFutureKm) < 1e-6 && Math.abs(estSec - best.estSec) < 1e-6 && Math.abs(sum.minCapMbps - best.summary.minCapMbps) < 1e-6 && hops < (best.hops ?? 1e9))
      ) {
        best = candidate;
      }
    }

    // Если ни одна станция не видна в конце передачи, выбираем лучший по времени из общего списка
    if (!best && fallback.length) {
      best = fallback.sort((a, b) => a.estSec - b.estSec || b.summary.minCapMbps - a.summary.minCapMbps)[0];
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

    const time = nowJulian(getClock());
    const mode = $("tasking-gb-gs-mode")?.value || "auto";
    const same = !!$("tasking-gb-same-gs")?.checked;

    let uplinkGsId = null;
    let downlinkGsId = null;
    let uplinkRoute = null;
    let downlinkRoute = null;

    const uplinkCmdMbits = 1.0;
    const downDataMbits = getResultDataMbits();

    if (mode === "manual") {
      gb.fixedUplinkGsId = null;
      gb.fixedDownlinkGsId = null;

      uplinkGsId = $("tasking-gb-gs-uplink-manual")?.value || null;
      downlinkGsId = $("tasking-gb-gs-downlink-manual")?.value || null;

      const upGs = uplinkGsId ? getEntityById(uplinkGsId) : null;
      const downGs = downlinkGsId ? getEntityById(downlinkGsId) : null;

      const gUp = upGs ? buildGraphSnapshot(time, upGs, true, misId) : null;
      const gDown = downGs ? buildGraphSnapshot(time, downGs, true, misId) : null;

      if (gUp && uplinkGsId) uplinkRoute = dijkstra(gUp.adj, uplinkGsId, misId, "fast", uplinkCmdMbits, gUp.cfg);
      if (gDown && downlinkGsId) downlinkRoute = dijkstra(gDown.adj, misId, downlinkGsId, "fast", downDataMbits, gDown.cfg);
    } else {
      // AUTO: фиксируем выбранные станции, чтобы не "прыгали"
      if (!gb.fixedUplinkGsId) {
        const bestUp = computeBestUplinkAuto(time, misId, gb.targetRect);
        gb.fixedUplinkGsId = bestUp?.gsId || null;
      }
      uplinkGsId = gb.fixedUplinkGsId;

      const upGs = uplinkGsId ? getEntityById(uplinkGsId) : null;
      const gUp = upGs ? buildGraphSnapshot(time, upGs, true, misId) : null;
      if (gUp && uplinkGsId) uplinkRoute = dijkstra(gUp.adj, uplinkGsId, misId, "fast", uplinkCmdMbits, gUp.cfg);

      const upSel = $("tasking-gb-gs-uplink");
      if (upSel && uplinkGsId) upSel.value = uplinkGsId;

      if (same && uplinkGsId) gb.fixedDownlinkGsId = uplinkGsId;
      if (!gb.fixedDownlinkGsId) {
        const bestDown = computeBestDownlinkAuto(time, misId, same, uplinkGsId);
        gb.fixedDownlinkGsId = bestDown?.gsId || null;
      }
      downlinkGsId = gb.fixedDownlinkGsId;

      const downGs = downlinkGsId ? getEntityById(downlinkGsId) : null;
      const gDown = downGs ? buildGraphSnapshot(time, downGs, true, misId) : null;
      if (gDown && downlinkGsId) downlinkRoute = dijkstra(gDown.adj, misId, downlinkGsId, "fast", downDataMbits, gDown.cfg);
    }

    gb.lastUplinkGsId = uplinkGsId;
    gb.lastDownlinkGsId = downlinkGsId;
    gb.lastUplinkRoute = uplinkRoute;
    gb.lastDownlinkRoute = downlinkRoute;

    const upSum = summarizeRoute(uplinkRoute);
    const downSum = summarizeRoute(downlinkRoute);

    gb.lastBottleneckUplinkMbps = upSum?.minCapMbps ?? null;
    gb.lastBottleneckDownlinkMbps = downSum?.minCapMbps ?? null;

    clearRouteEntitiesByPrefix(gb.uplinkRoutePrefix);
    clearRouteEntitiesByPrefix(gb.downlinkRoutePrefix);
    const UPLINK_COLOR = Cesium.Color.fromCssColorString("#ff5ec4");  // ярко-розовый
    const DOWNLINK_COLOR = Cesium.Color.fromCssColorString("#00f6ff"); // неоново-голубой
    if (uplinkRoute) renderRoute(uplinkRoute, gb.uplinkRoutePrefix, UPLINK_COLOR);
    if (downlinkRoute) renderRoute(downlinkRoute, gb.downlinkRoutePrefix, DOWNLINK_COLOR);

    const upSt = $("tasking-gb-uplink-status");
    const downSt = $("tasking-gb-downlink-status");
    const upBn = $("tasking-gb-uplink-bottleneck");
    const downBn = $("tasking-gb-downlink-bottleneck");
    const est = $("tasking-gb-est-time");

    if (upSt) upSt.textContent = uplinkRoute ? `OK (${uplinkRoute.path.length - 1} hop)` : "маршрут не найден";
    if (downSt) downSt.textContent = downlinkRoute ? `OK (${downlinkRoute.path.length - 1} hop)` : "маршрут не найден";

    if (upBn) upBn.textContent = upSum ? `${upSum.minCapMbps.toFixed(2)} Mbps (min), SNR min ${upSum.minSnrDb.toFixed(1)} dB` : "—";
    if (downBn) downBn.textContent = downSum ? `${downSum.minCapMbps.toFixed(2)} Mbps (min), SNR min ${downSum.minSnrDb.toFixed(1)} dB` : "—";

    if (est) {
      if (!downlinkRoute || (downSum?.minCapMbps ?? 0) <= 0.0001) {
        est.textContent = "— (нет downlink маршрута)";
      } else {
        const sec = downDataMbits / Math.max(0.001, downSum.minCapMbps);
        est.textContent = `${formatTimeSeconds(sec)} (по bottleneck ${downSum.minCapMbps.toFixed(2)} Mbps)`;
      }
    }

    const upName = uplinkGsId ? (getEntityById(uplinkGsId)?.name || uplinkGsId) : "—";
    const downName = downlinkGsId ? (getEntityById(downlinkGsId)?.name || downlinkGsId) : "—";
    setUplinkStation(upName || "—");
    setDownlinkStation(downName || "—");
  }

  // -------------------------
  // Scenario start
  // -------------------------

  // -------------------------
  // Scenario start + runtime loop
  // -------------------------

  // -------------------------
  // Status UI (раздельные строки)
  // -------------------------
  function setStationsLine(text) {
    const el = $("tasking-gb-stations");
    if (el) el.textContent = text || "—";
    // обратная совместимость (если вдруг есть старое поле)
    const legacy = $("tasking-gb-status");
    if (legacy && !gb.task) legacy.textContent = text || "—";
  }

  function setMissionStatus(text) {
    const el = $("tasking-gb-mission-status");
    if (el) el.textContent = text || "—";
    const legacy = $("tasking-gb-status");
    if (legacy && text) legacy.textContent = text;
  }

  function setUplinkXfer(text) {
    const el = $("tasking-gb-uplink-xfer");
    if (el) el.textContent = text || "—";
  }

  function setDownlinkXfer(text) {
    const el = $("tasking-gb-downlink-xfer");
    if (el) el.textContent = text || "—";
  }

  function setUplinkStation(text) {
    const el = $("tasking-gb-station-uplink");
    if (el) el.textContent = text || "—";
  }

  function setDownlinkStation(text) {
    const el = $("tasking-gb-station-downlink");
    if (el) el.textContent = text || "—";
  }

  function setStatusLine(stageText) {
    // legacy helper: обновляет новые поля, а при наличии старого span (tasking-gb-status) — тоже.
    const station = gb.lastStationText || "—";
    if (stageText) {
      setMissionStatus(stageText);
      setStationsLine(station);
      const legacy = $("tasking-gb-status");
      if (legacy) legacy.textContent = `${stageText} | ${station}`;
    } else {
      setStationsLine(station);
      const legacy = $("tasking-gb-status");
      if (legacy) legacy.textContent = station;
    }
  }

  function stopGbTask(finalText) {
    if (gb.taskTimer) {
      clearInterval(gb.taskTimer);
      gb.taskTimer = null;
    }
    gb.task = null;
    gb.fixedUplinkGsId = null;
    gb.fixedDownlinkGsId = null;
    if (finalText) {
      setMissionStatus(finalText);
      setUplinkXfer("—");
      setDownlinkXfer("—");
    }
  }

  function finalizeMissionSuccess() {
    // Завершаем сценарий и очищаем визуализацию/выбор, чтобы была "завершаемость миссии"
    if (gb.taskTimer) {
      clearInterval(gb.taskTimer);
      gb.taskTimer = null;
    }
    gb.task = null;

    setMissionStatus("Задание выполнено. Файл передан на наземную станцию.");
    setUplinkXfer("готово");
    setDownlinkXfer("готово");

    // очистить визуализацию маршрутов
    clearRouteEntitiesByPrefix(gb.uplinkRoutePrefix);
    clearRouteEntitiesByPrefix(gb.downlinkRoutePrefix);

    // убрать подсветку выбранного MIS
    setMisHighlight(null);

    // сбросить выбранного исполнителя и UI
    gb.chosenMisId = null;
    gb.chosenEtaSec = null;
    updateChosenUi(null, null);

    // сбросить кэш маршрутов/станций и UI-строки
    gb.lastUplinkGsId = null;
    gb.lastDownlinkGsId = null;
    gb.lastUplinkRoute = null;
    gb.lastDownlinkRoute = null;
    gb.lastBottleneckUplinkMbps = null;
    gb.lastBottleneckDownlinkMbps = null;
    gb.fixedUplinkGsId = null;
    gb.fixedDownlinkGsId = null;
    gb.fixedUplinkGsId = null;
    gb.fixedDownlinkGsId = null;
    gb.fixedUplinkGsId = null;
    gb.fixedDownlinkGsId = null;
    gb.lastStationText = "—";
    setStationsLine("—");
    setUplinkStation("—");
    setDownlinkStation("—");

    // очистить маршрутные статусы/оценки
    $("tasking-gb-uplink-status") && ($("tasking-gb-uplink-status").textContent = "—");
    $("tasking-gb-downlink-status") && ($("tasking-gb-downlink-status").textContent = "—");
    $("tasking-gb-uplink-bottleneck") && ($("tasking-gb-uplink-bottleneck").textContent = "—");
    $("tasking-gb-downlink-bottleneck") && ($("tasking-gb-downlink-bottleneck").textContent = "—");
    $("tasking-gb-est-time") && ($("tasking-gb-est-time").textContent = "—");
  }

  function tickGbTask() {
    if (!gb.task) return;

    buildAndRenderRoutesSnapshot();

    const timeNow = nowJulian(getClock());
    const stage = gb.task.stage;

    if (stage === "UPLINK_WAIT_ROUTE") {
      if (gb.lastUplinkRoute && (gb.lastBottleneckUplinkMbps ?? 0) > 0) {
        gb.task.stage = "UPLINKING";
        setMissionStatus("Сценарий: uplink");
        setUplinkXfer("передача задания…");
        setDownlinkXfer("—");
        setStatusLine("Uplink: передача задания…");
      } else {
        setMissionStatus("Сценарий: uplink");
        setUplinkXfer("ожидание маршрута…");
        setDownlinkXfer("—");
        setStatusLine("Uplink: ожидание маршрута…");
      }
      return;
    }

    if (stage === "UPLINKING") {
      const cap = Math.max(0, gb.lastBottleneckUplinkMbps ?? 0);
      if (!gb.lastUplinkRoute || cap <= 0.0001) {
        gb.task.stage = "UPLINK_WAIT_ROUTE";
        setMissionStatus("Сценарий: uplink");
        setUplinkXfer("маршрут потерян, ожидание…");
        setDownlinkXfer("—");
        setStatusLine("Uplink: маршрут потерян, ожидание…");
        return;
      }
      gb.task.uplinkRemainingMbits = Math.max(0, gb.task.uplinkRemainingMbits - cap * 1.0);
      setMissionStatus("Сценарий: uplink");
      setUplinkXfer(`передача… осталось ${gb.task.uplinkRemainingMbits.toFixed(2)} Мбит`);
      setDownlinkXfer("—");
      setStatusLine(`Uplink: передача задания… осталось ${gb.task.uplinkRemainingMbits.toFixed(2)} Мбит`);

      if (gb.task.uplinkRemainingMbits <= 0.0001) {
        gb.task.stage = "WAIT_TARGET";
        setMissionStatus("Ожидание входа в область…");
        setUplinkXfer("задание доставлено");
        setDownlinkXfer("—");
        setStatusLine("Задание доставлено. Ожидание входа в область…");
      }
      return;
    }

    if (stage === "WAIT_TARGET") {
      const left = Cesium.JulianDate.secondsDifference(gb.task.targetTime, timeNow);
      if (left <= 0) {
        gb.task.stage = "IMAGING";
        gb.task.imagingRemainingSec = gb.task.imagingDurationSec;
        setMissionStatus("Съёмка области…");
        setUplinkXfer("задание доставлено");
        setDownlinkXfer("—");
        setStatusLine("Съёмка области…");
      } else {
        setMissionStatus(`Ожидание входа в область… ${formatTimeSeconds(left)}`);
        setUplinkXfer("задание доставлено");
        setDownlinkXfer("—");
        setStatusLine(`Ожидание входа в область… ${formatTimeSeconds(left)}`);
      }
      return;
    }

    if (stage === "IMAGING") {
      gb.task.imagingRemainingSec = Math.max(0, gb.task.imagingRemainingSec - 1);
      if (gb.task.imagingRemainingSec <= 0) {
        gb.task.stage = "DOWNLINK_WAIT_ROUTE";
        setMissionStatus("Съёмка завершена. Сценарий: downlink");
        setUplinkXfer("готово");
        setDownlinkXfer("ожидание маршрута…");
        setStatusLine("Съёмка завершена. Downlink: ожидание маршрута…");
      } else {
        setMissionStatus("Съёмка области…");
      setUplinkXfer("задание доставлено");
      setDownlinkXfer("—");
      setStatusLine(`Съёмка области… осталось ${gb.task.imagingRemainingSec} c`);
      }
      return;
    }

    if (stage === "DOWNLINK_WAIT_ROUTE") {
      if (gb.lastDownlinkRoute && (gb.lastBottleneckDownlinkMbps ?? 0) > 0) {
        gb.task.stage = "DOWNLINKING";
        setMissionStatus("Сценарий: downlink");
        setUplinkXfer("готово");
        setDownlinkXfer("передача результата…");
        setStatusLine("Downlink: передача результата…");
      } else {
        setMissionStatus("Сценарий: downlink");
        setUplinkXfer("готово");
        setDownlinkXfer("ожидание маршрута…");
        setStatusLine("Downlink: ожидание маршрута…");
      }
      return;
    }

    if (stage === "DOWNLINKING") {
      const cap = Math.max(0, gb.lastBottleneckDownlinkMbps ?? 0);
      if (!gb.lastDownlinkRoute || cap <= 0.0001) {
        gb.task.stage = "DOWNLINK_WAIT_ROUTE";
        setMissionStatus("Сценарий: downlink");
        setUplinkXfer("готово");
        setDownlinkXfer("маршрут потерян, ожидание…");
        setStatusLine("Downlink: маршрут потерян, ожидание…");
        return;
      }

      gb.task.downlinkRemainingMbits = Math.max(0, gb.task.downlinkRemainingMbits - cap * 1.0);
      const est = gb.task.downlinkRemainingMbits / Math.max(0.001, cap);
      setMissionStatus("Сценарий: downlink");
      setUplinkXfer("готово");
      setDownlinkXfer(`передача… осталось ${formatTimeSeconds(est)}`);
      setStatusLine(`Downlink: передача результата… осталось ${formatTimeSeconds(est)}`);

      if (gb.task.downlinkRemainingMbits <= 0.0001) {
        finalizeMissionSuccess();
      }
      return;
    }
  }

  function startGbScenario() {
    const rect = gb.targetRect;

    if (!rect) { setMissionStatus("Ошибка: сначала задайте целевую область."); setUplinkXfer("—"); setDownlinkXfer("—"); setStatusLine("Ошибка: сначала задайте целевую область."); return; }
    if (!gb.chosenMisId) { setMissionStatus("Ошибка: сначала выберите MIS-КА (исполнителя)."); setUplinkXfer("—"); setDownlinkXfer("—"); setStatusLine("Ошибка: сначала выберите MIS-КА (исполнителя)."); return; }

    if (gb.task) stopGbTask();

    buildAndRenderRoutesSnapshot();

    const t0 = nowJulian(getClock());
    const etaSec = Number.isFinite(gb.chosenEtaSec) ? gb.chosenEtaSec : 0;
    const targetTime = Cesium.JulianDate.addSeconds(t0, Math.max(0, etaSec), new Cesium.JulianDate());
    const imagingSec = getImagingDurationSeconds(rect);

    gb.task = {
      stage: "UPLINK_WAIT_ROUTE",
      uplinkRemainingMbits: 1.0,
      targetTime,
      imagingDurationSec: imagingSec,
      imagingRemainingSec: imagingSec,
      downlinkRemainingMbits: getResultDataMbits(),
    };

    setMissionStatus("Сценарий запущен. Сценарий: uplink");
    setUplinkXfer("ожидание маршрута…");
    setDownlinkXfer("—");
    setStatusLine("Сценарий запущен. Uplink: ожидание маршрута…");

    if (gb.taskTimer) clearInterval(gb.taskTimer);
    gb.taskTimer = setInterval(tickGbTask, 1000);
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
      toggle.textContent = "▲ Миссия";
    } else {
      panel.classList.add("hidden");
      toggle.textContent = "▼ Миссия";
    }
  }

  // -------------------------
  // Reset executor (must be OUTSIDE init)
  // -------------------------
  function resetExecutor(reasonText) {
    const msg = reasonText || "Исполнитель сброшен.";

    // если шел сценарий — остановить
    if (gb.task) stopGbTask(msg);

    gb.chosenMisId = null;
    gb.chosenEtaSec = null;

    // UI
    updateChosenUi(null, null);

    // подсветка MIS
    setMisHighlight(null);

    // маршруты
    clearRouteEntitiesByPrefix(gb.uplinkRoutePrefix);
    clearRouteEntitiesByPrefix(gb.downlinkRoutePrefix);

    // маршрутные поля/расчеты
    $("tasking-gb-uplink-status") && ($("tasking-gb-uplink-status").textContent = "—");
    $("tasking-gb-downlink-status") && ($("tasking-gb-downlink-status").textContent = "—");
    $("tasking-gb-uplink-bottleneck") && ($("tasking-gb-uplink-bottleneck").textContent = "—");
    $("tasking-gb-downlink-bottleneck") && ($("tasking-gb-downlink-bottleneck").textContent = "—");
    $("tasking-gb-est-time") && ($("tasking-gb-est-time").textContent = "—");

    // новые статусы
    setMissionStatus(msg);
    setUplinkXfer("—");
    setDownlinkXfer("—");

    gb.lastStationText = "—";
    setStationsLine("—");

    // если ты сделал отдельные строки станций
    if (typeof setUplinkStation === "function") setUplinkStation("—");
    if (typeof setDownlinkStation === "function") setDownlinkStation("—");

    // кэш
    gb.lastUplinkGsId = null;
    gb.lastDownlinkGsId = null;
    gb.lastUplinkRoute = null;
    gb.lastDownlinkRoute = null;
    gb.lastBottleneckUplinkMbps = null;
    gb.lastBottleneckDownlinkMbps = null;

    // legacy поле, если есть
    const legacy = $("tasking-gb-status");
    if (legacy) legacy.textContent = msg;
  }

  // -------------------------
  // Init
  // -------------------------
  function init() {
    const panel = $("tasking-gb-panel");
    const toggle = $("tasking-gb-toggle");

    ensureImagingRadiusUi();
    ensureImagingDurationUi();
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
        const msg = "Сначала задайте целевую область.";
        if (st) st.textContent = msg;
        setMissionStatus(msg);
        setUplinkXfer("—");
        setDownlinkXfer("—");
        return;
      }

      const best = pickBestMissionSat(rect);
      if (!best) {
        const msg = "Не найден подходящий MIS-КА.";
        if (st) st.textContent = msg;
        setMissionStatus(msg);
        setUplinkXfer("—");
        setDownlinkXfer("—");

        gb.chosenMisId = null;
        gb.chosenEtaSec = null;
        updateChosenUi(null, null);

        // убрать подсветку
        setMisHighlight(null);
        return;
      }

      gb.chosenMisId = best.sat.id;
      gb.chosenEtaSec = best.etaSec;
      updateChosenUi(best.sat.id, best.etaSec);

      // включить подсветку
      setMisHighlight(best.sat.id);

      const rKm = getImagingRadiusKm();
      const readyText = rKm > 0
        ? `ГОТОВО К ОТПРАВКЕ (радиус съёмки: ${rKm} км)`
        : "ГОТОВО К ОТПРАВКЕ (строго над областью)";
      if (st) st.textContent = readyText;

      setMissionStatus(readyText);
      setUplinkXfer("—");
      setDownlinkXfer("—");

      buildAndRenderRoutesSnapshot();
    });

    $("tasking-gb-send")?.addEventListener("click", (e) => {
      e.preventDefault();
      startGbScenario();
    });

    // обработчик "Сброс исполнителя" — строго внутри init()
    const rb = $("tasking-gb-reset-mis");
    if (rb && !gb._resetBound) {
      rb.addEventListener("click", (e) => {
        e.preventDefault();
        resetExecutor("Исполнитель сброшен.");
      });
      gb._resetBound = true;
    }

    $("tasking-gb-size-mb")?.addEventListener("input", () => {
      if (gb.chosenMisId) buildAndRenderRoutesSnapshot();
    });

    $("tasking-gb-same-gs")?.addEventListener("change", () => {
      if (gb.chosenMisId) buildAndRenderRoutesSnapshot();
    });

    $("tasking-gb-radius-km")?.addEventListener("input", () => {
      if (gb.targetRect) drawOrUpdateBufferRect();
      if (gb.chosenMisId) buildAndRenderRoutesSnapshot();
    });

    $("tasking-gb-duration-manual")?.addEventListener("change", () => {
      const hint = $("tasking-gb-duration-hint");
      if (hint) {
        const sec = getImagingDurationSeconds(gb.targetRect);
        hint.textContent = `Оценка времени съёмки: ~${sec.toFixed(0)} c`;
      }
    });
    $("tasking-gb-duration-sec")?.addEventListener("input", () => {
      const hint = $("tasking-gb-duration-hint");
      if (hint) {
        const sec = getImagingDurationSeconds(gb.targetRect);
        hint.textContent = `Оценка времени съёмки: ~${sec.toFixed(0)} c`;
      }
    });

    window.addEventListener("spaceMesh:radioTick", () => {
      if (!gb.panelShown) return;
      if (!gb.chosenMisId) return;
      buildAndRenderRoutesSnapshot();
    });

    refreshGsLists();
    updateGsModeUi();
    setPanelVisible(false);

    // начальные значения новых строк статуса
    setMissionStatus("—");
    setUplinkXfer("—");
    setDownlinkXfer("—");
    setStationsLine(gb.lastStationText || "—");

    // если у тебя есть раздельные строки станций — сбросим их тоже
    if (typeof setUplinkStation === "function") setUplinkStation("—");
    if (typeof setDownlinkStation === "function") setDownlinkStation("—");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
