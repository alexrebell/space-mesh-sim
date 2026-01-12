// tasking.js — панель "Задания на съёмку" (Tasking + планирование + таймлайн)
// Минимальный этап: UI + выбор области + подбор MIS-КА + имитация 15-мин. сценария.

(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function nowJulian(clock) {
    return (clock && clock.currentTime) ? clock.currentTime : Cesium.JulianDate.now();
  }

  function toDeg(rad) { return rad * 180 / Math.PI; }

  function cartesianToLonLat(cart) {
    const c = Cesium.Cartographic.fromCartesian(cart, Cesium.Ellipsoid.WGS84);
    return { lon: Cesium.Math.negativePiToPi(c.longitude) * 180 / Math.PI, lat: c.latitude * 180 / Math.PI, h: c.height };
  }

  function normalizeLon(lon) {
    let x = lon;
    while (x > 180) x -= 360;
    while (x < -180) x += 360;
    return x;
  }

  function rectContains(rect, lon, lat) {
    const x = normalizeLon(lon);
    const y = lat;
    if (y < rect.latMin || y > rect.latMax) return false;
    // ВАЖНО: пока предполагаем, что прямоугольник не пересекает линию перемены дат (lonMin < lonMax)
    return x >= rect.lonMin && x <= rect.lonMax;
  }

  // -------------------------
  // Гео-утилиты для "пятна съёмки" (простая модель)
  // -------------------------
  function deg2rad(d) { return d * Math.PI / 180; }

  // Haversine distance, км
  function haversineKm(lon1, lat1, lon2, lat2) {
    const R = 6371.0;
    const p1 = deg2rad(lat1);
    const p2 = deg2rad(lat2);
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function rectCenter(rect) {
    return {
      lon: (rect.lonMin + rect.lonMax) / 2,
      lat: (rect.latMin + rect.latMax) / 2
    };
  }

  // Приближённая минимальная дистанция (км) от точки до прямоугольника в lon/lat.
  // Для наших задач (малые области, без пересечения 180°) этого достаточно.
  function distancePointToRectKm(rect, lon, lat) {
    const clampedLon = clamp(lon, rect.lonMin, rect.lonMax);
    const clampedLat = clamp(lat, rect.latMin, rect.latMax);
    return haversineKm(lon, lat, clampedLon, clampedLat);
  }

  function setSatState(ent, stateStr) {
    try {
      if (!ent || !ent.properties || !ent.properties.state) return;
      const p = ent.properties.state;
      if (typeof p.setValue === "function") p.setValue(stateStr);
      else ent.properties.state = new Cesium.ConstantProperty(stateStr);
    } catch (e) {
      console.warn("tasking: не удалось установить state", e);
    }
  }

  function getSatState(ent, time) {
    try {
      return ent?.properties?.state?.getValue?.(time) ?? null;
    } catch { return null; }
  }

  // -------------------------
  // Draggable (копия паттерна из mission.js)
  // -------------------------
  function makeDraggable(panelEl, handleEl, storageKey = "taskingPanelPos") {
    if (!panelEl || !handleEl) return;

    // restore pos
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
        panelEl.style.left = saved.left + "px";
        panelEl.style.top = saved.top + "px";
        panelEl.style.right = "auto";
        panelEl.style.bottom = "auto";
      }
    } catch {}

    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    handleEl.addEventListener("pointerdown", (e) => {
      // не начинаем drag, если кликаем по инпутам/кнопкам внутри заголовка
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "BUTTON" || t.tagName === "SELECT" || t.closest("button"))) return;

      dragging = true;
      panelEl.setPointerCapture?.(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;

      const rect = panelEl.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      e.preventDefault();
    });

    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const left = startLeft + dx;
      const top = startTop + dy;

      panelEl.style.left = left + "px";
      panelEl.style.top = top + "px";
      panelEl.style.right = "auto";
      panelEl.style.bottom = "auto";
    });

    window.addEventListener("pointerup", () => {
      if (!dragging) return;
      dragging = false;

      try {
        const rect = panelEl.getBoundingClientRect();
        localStorage.setItem(storageKey, JSON.stringify({ left: rect.left, top: rect.top }));
      } catch {}
    });
  }

  // -------------------------
  // Основное состояние
  // -------------------------
  const tasking = {
    targetRect: null,
    targetEntityId: "TASKING:TARGET_RECT",
    chosenMisId: null,
    task: null, // текущая задача
    timer: null,
    tick: null
  };

  function getViewer() { return window.spaceMesh?.viewer || null; }
  function getClock() { return window.spaceMesh?.clock || null; }

  function getGroundStations() {
    const gs = window.spaceMesh?.groundStations;
    if (!gs) return [];
    // entities: [{id:"GS:..", name:"Наземная станция: ..."}]
    return gs.entities || [];
  }

  function getMissionSats(time) {
    const list = [];
    const store = window.spaceMesh?.missionStore || [];
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

  function getMeshSats(time) {
    const list = [];
    const store = window.spaceMesh?.orbitStore || [];
    for (const orbit of store) {
      for (const sat of (orbit.satellites || [])) {
        if (!sat) continue;
        const ent = sat.position?.getValue ? sat : (sat.entity || sat);
        if (!ent || !ent.position?.getValue) continue;
        // mesh-КА: НЕ MIS
        const isMis = ent?.properties?.isMissionSatellite?.getValue?.(time) ?? ent?.properties?.isMissionSatellite;
        if (isMis === true) continue;
        list.push(ent);
      }
    }
    return list;
  }

  // -------------------------
  // Routing (Этап 3–4)
  // -------------------------

  const ROUTE_IDS = {
    uplinkPrefix: "TASKING:UPLINK:hop:",
    downlinkPrefix: "TASKING:DOWNLINK:hop:",
  };

  function clearRouteEntities(prefix) {
    const viewer = getViewer();
    if (!viewer) return;
    const all = viewer.entities.values;
    // обратный цикл — безопаснее при remove
    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i];
      if (typeof e?.id === "string" && e.id.startsWith(prefix)) {
        viewer.entities.remove(e);
      }
    }
  }

  function ensureRoutingUi() {
    const panel = $("tasking-panel");
    if (!panel) return;
    if ($("tasking-routing-block")) return; // уже создан

    const block = document.createElement("div");
    block.id = "tasking-routing-block";
    block.className = "hint";
    block.style.marginTop = "10px";
    block.innerHTML = `
      <h2 style="margin:10px 0 6px;">Маршрутизация</h2>
      <div class="row" style="gap:8px;">
        <label style="width:100%;">Оптимизация маршрута:
          <select id="tasking-route-metric">
            <option value="fast">Самый быстрый (по пропускной способности)</option>
            <option value="reliable">Самый надёжный (по запасу SNR)</option>
            <option value="short">Самый короткий (по дальности)</option>
          </select>
        </label>
        <label style="width:100%;">Автоперестройка в реальном времени:
          <select id="tasking-route-autoupd">
            <option value="off">Выкл</option>
            <option value="on">Вкл (по обновлению radio.js)</option>
          </select>
        </label>
      </div>
      <div class="row" style="gap:8px;">
        <label style="width:100%;">Команда (uplink), КБ:
          <input id="tasking-cmd-kb" type="number" value="8" min="1" max="1024" />
        </label>
        <label style="width:100%;">Результат (downlink), МБ:
          <input id="tasking-result-mb" type="number" value="50" min="1" max="5000" />
        </label>
      </div>
      <button id="tasking-build-routes" type="button" style="margin-top:6px;">Построить маршруты (снимок сейчас)</button>
      <div style="margin-top:8px;">
        <div><b>Uplink:</b> <span id="tasking-uplink-summary">—</span></div>
        <div id="tasking-uplink-table" style="margin-top:6px; overflow:auto; max-height:180px;"></div>
      </div>
      <div style="margin-top:10px;">
        <div><b>Downlink:</b> <span id="tasking-downlink-summary">—</span></div>
        <div id="tasking-downlink-table" style="margin-top:6px; overflow:auto; max-height:180px;"></div>
      </div>
      <div style="margin-top:8px; opacity:.8;">
        Маршруты строятся по <b>текущим активным линкам</b> radio.js. Линии маршрута динамические (двигаются вместе с КА).
      </div>
    `;

    panel.appendChild(block);
  }

  // -------------------------
  // Imaging params UI (порог "доступной области съёмки")
  // -------------------------
  function ensureImagingUi() {
    const panel = $("tasking-panel");
    if (!panel) return;
    if ($("tasking-imaging-block")) return;

    const block = document.createElement("div");
    block.id = "tasking-imaging-block";
    block.className = "hint";
    block.style.marginTop = "10px";
    block.innerHTML = `
      <h2 style="margin:10px 0 6px;">Параметры съёмки (упрощённо)</h2>
      <div class="row" style="gap:8px;">
        <label style="width:100%;">Радиус покрытия (км):
          <input id="tasking-footprint-km" type="number" value="80" min="1" max="2000" step="1" />
        </label>
        <label style="width:100%;">Шаг поиска (сек):
          <input id="tasking-search-step" type="number" value="15" min="1" max="120" step="1" />
        </label>
      </div>
      <div style="font-size:12px; opacity:.85; line-height:1.35;">
        Если прямоугольник маленький — MIS-КА считается подходящим, когда его подспутниковая точка
        попадает <b>внутрь</b> области <i>или</i> оказывается не дальше указанного радиуса от неё.
        Это имитация полосы/пятна съёмки (без оптики, без угла отклонения, без облачности).
      </div>
    `;

    // вставляем перед блоком маршрутизации, чтобы логически было сверху
    const routing = $("tasking-routing-block");
    if (routing && routing.parentNode) routing.parentNode.insertBefore(block, routing);
    else panel.appendChild(block);
  }

  function elevationDeg(gsPos, satPos) {
    // приближённо: elev = asin( dot( dir(gs->sat), up(gs) ) )
    const up = Cesium.Cartesian3.normalize(gsPos, new Cesium.Cartesian3());
    const v = Cesium.Cartesian3.subtract(satPos, gsPos, new Cesium.Cartesian3());
    const dir = Cesium.Cartesian3.normalize(v, new Cesium.Cartesian3());
    const s = Cesium.Cartesian3.dot(dir, up);
    const el = Math.asin(clamp(s, -1, 1));
    return el * 180 / Math.PI;
  }

  function buildGraphSnapshot(time, gsEnt) {
    const radioApi = window.spaceMesh?.radio;
    const viewer = getViewer();
    if (!radioApi || !viewer) return null;

    const cfg = radioApi.getConfig?.() || {};
    const minSnr = cfg.minSnrDb ?? 5;
    const rxSens = cfg.rxSensDbm ?? -100;
    const maxRangeKm = cfg.maxRangeKm ?? 0;

    /** @type {Map<string, Array<object>>} */
    const adj = new Map();
    const addEdge = (from, to, meta) => {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from).push({ from, to, ...meta });
    };

    // 1) sat↔sat рёбра из radio.js
    const edges = radioApi.getActiveEdgesSnapshot?.() || [];
    for (const e of edges) {
      // фильтр sanity
      if (!e || !e.aId || !e.bId) continue;
      if (maxRangeKm > 0 && Number.isFinite(e.distanceKm) && e.distanceKm > maxRangeKm) continue;
      if (Number.isFinite(e.snrDb) && e.snrDb < minSnr) continue;
      if (Number.isFinite(e.rxPowerDbm) && e.rxPowerDbm < rxSens) continue;

      addEdge(e.aId, e.bId, { kind: "sat", ...e });
      addEdge(e.bId, e.aId, { kind: "sat", ...e });
    }

    // 2) GS↔sat рёбра: строим к видимым mesh-КА (НЕ к MIS)
    if (gsEnt) {
      const gsPos = gsEnt.position?.getValue?.(time);
      const minEl = gsEnt.properties?.minElevationDeg?.getValue?.(time) ?? 10;
      const meshSats = getMeshSats(time);
      for (const sat of meshSats) {
        const satPos = sat.position?.getValue?.(time);
        if (!gsPos || !satPos) continue;
        const el = elevationDeg(gsPos, satPos);
        if (el < minEl) continue;

        const dist = Cesium.Cartesian3.distance(gsPos, satPos);
        const distKm = dist / 1000;
        if (maxRangeKm > 0 && distKm > maxRangeKm) continue;

        const b = radioApi.computeBudgetForDistanceMeters?.(dist);
        if (!b) continue;
        if (Number.isFinite(b.rxPowerDbm) && b.rxPowerDbm < rxSens) continue;
        if (Number.isFinite(b.snrDb) && b.snrDb < minSnr) continue;

        const capMbps = radioApi.computeCapacityMbps?.(b.snrDb);
        const meta = {
          key: `GS|${sat.id}`,
          aId: gsEnt.id,
          bId: sat.id,
          distanceKm: distKm,
          rxPowerDbm: b.rxPowerDbm,
          snrDb: b.snrDb,
          noiseFloorDbm: b.noiseFloorDbm,
          capacityMbps: capMbps,
          kind: "gs"
        };
        addEdge(gsEnt.id, sat.id, meta);
        addEdge(sat.id, gsEnt.id, meta);
      }
    }

    return { adj, cfg };
  }

  function routeWeight(edge, metric, dataMbits, cfg) {
    const hopPenalty = 0.05; // небольшое наказание за количество переходов
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

    // fast: время передачи
    const t = dataMbits / Math.max(0.001, cap); // секунды, т.к. Мбит / (Мбит/с)
    return t + hopPenalty;
  }

  function dijkstra(adj, startId, goalId, metric, dataMbits, cfg) {
    const dist = new Map();
    const prev = new Map();
    const visited = new Set();

    dist.set(startId, 0);

    // простой O(V^2) — у нас маршрут локальный, и это быстрее внедрять
    while (true) {
      let u = null;
      let best = Infinity;
      for (const [node, d] of dist.entries()) {
        if (visited.has(node)) continue;
        if (d < best) { best = d; u = node; }
      }
      if (u === null) break;
      if (u === goalId) break;
      visited.add(u);

      const edges = adj.get(u) || [];
      for (const e of edges) {
        const v = e.to;
        if (visited.has(v)) continue;
        const w = routeWeight(e, metric, dataMbits, cfg);
        const alt = best + w;
        if (alt < (dist.get(v) ?? Infinity)) {
          dist.set(v, alt);
          prev.set(v, { u, edge: e });
        }
      }
    }

    if (!dist.has(goalId)) return null;

    const path = [];
    const hopEdges = [];
    let cur = goalId;
    path.push(cur);
    while (cur !== startId) {
      const p = prev.get(cur);
      if (!p) break;
      hopEdges.push(p.edge);
      cur = p.u;
      path.push(cur);
    }
    path.reverse();
    hopEdges.reverse();

    return { cost: dist.get(goalId), path, hopEdges };
  }

  function makeRouteLine(id, aEnt, bEnt, color) {
    const viewer = getViewer();
    if (!viewer || !aEnt || !bEnt) return null;
    return viewer.entities.add({
      id,
      polyline: {
        positions: new Cesium.CallbackProperty((time) => {
          const a = aEnt.position?.getValue?.(time);
          const b = bEnt.position?.getValue?.(time);
          if (!a || !b) return [];
          return [a, b];
        }, false),
        width: 4,
        material: color
      }
    });
  }

  function renderRoute(prefix, hopEdges, color) {
    const viewer = getViewer();
    if (!viewer) return;
    clearRouteEntities(prefix);

    for (let i = 0; i < hopEdges.length; i++) {
      const e = hopEdges[i];
      const aEnt = viewer.entities.getById(e.aId) || viewer.entities.getById(e.from);
      const bEnt = viewer.entities.getById(e.bId) || viewer.entities.getById(e.to);
      if (!aEnt || !bEnt) continue;
      makeRouteLine(`${prefix}${i}`, aEnt, bEnt, color);
    }
  }

  function makeHopsTable(hopEdges, title) {
    if (!hopEdges || hopEdges.length === 0) {
      return `<div style="opacity:.8;">${title}: маршрут не найден.</div>`;
    }

    const rows = hopEdges.map((e, idx) => {
      const d = Number.isFinite(e.distanceKm) ? e.distanceKm.toFixed(1) : "-";
      const snr = Number.isFinite(e.snrDb) ? e.snrDb.toFixed(1) : "-";
      const rx = Number.isFinite(e.rxPowerDbm) ? e.rxPowerDbm.toFixed(1) : "-";
      const cap = Number.isFinite(e.capacityMbps) ? e.capacityMbps.toFixed(1) : "-";
      const kind = (e.kind === "gs") ? "GS↔КА" : (e.isMisEdge ? "MIS" : "mesh");
      return `<tr>
        <td>${idx + 1}</td>
        <td style="white-space:nowrap;">${e.aId}</td>
        <td style="white-space:nowrap;">${e.bId}</td>
        <td>${kind}</td>
        <td>${d}</td>
        <td>${rx}</td>
        <td>${snr}</td>
        <td>${cap}</td>
      </tr>`;
    }).join("");

    return `
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr style="text-align:left; opacity:.85;">
            <th>#</th><th>От</th><th>К</th><th>Тип</th><th>Дальн., км</th><th>Rx, dBm</th><th>SNR, dB</th><th>C, Мбит/с</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // -------------------------
  // UI helpers
  // -------------------------
  function fillGroundStationSelect() {
    const sel = $("tasking-gs-select");
    if (!sel) return;

    const time = nowJulian(getClock());
    const stations = getGroundStations();

    // очистка
    sel.innerHTML = "";

    for (const ent of stations) {
      const name = ent?.properties?.stationName?.getValue?.(time) || ent?.name || ent?.id;
      const opt = document.createElement("option");
      opt.value = ent.id; // entity id: GS:...
      opt.textContent = name.replace(/^Наземная станция:\s*/i, "");
      sel.appendChild(opt);
    }
  }

  function updateGsModeUi() {
    const mode = $("tasking-gs-mode")?.value || "auto";
    const row = $("tasking-gs-row");
    if (row) row.style.display = (mode === "manual") ? "" : "none";
  }

  function parseRectFromInputs() {
    const lonMin = parseFloat($("tasking-lon-min")?.value);
    const lonMax = parseFloat($("tasking-lon-max")?.value);
    const latMin = parseFloat($("tasking-lat-min")?.value);
    const latMax = parseFloat($("tasking-lat-max")?.value);

    if (![lonMin, lonMax, latMin, latMax].every(Number.isFinite)) return null;

    const r = {
      lonMin: normalizeLon(Math.min(lonMin, lonMax)),
      lonMax: normalizeLon(Math.max(lonMin, lonMax)),
      latMin: clamp(Math.min(latMin, latMax), -89.999, 89.999),
      latMax: clamp(Math.max(latMin, latMax), -89.999, 89.999)
    };

    // Пока не поддерживаем пересечение линии перемены дат
    if (r.lonMin > r.lonMax) return null;

    return r;
  }

  function drawOrUpdateRect(rect) {
    const viewer = getViewer();
    if (!viewer) return;

    const corners = [
      Cesium.Cartesian3.fromDegrees(rect.lonMin, rect.latMin),
      Cesium.Cartesian3.fromDegrees(rect.lonMax, rect.latMin),
      Cesium.Cartesian3.fromDegrees(rect.lonMax, rect.latMax),
      Cesium.Cartesian3.fromDegrees(rect.lonMin, rect.latMax)
    ];

    // удалить старый, если есть
    const old = viewer.entities.getById(tasking.targetEntityId);
    if (old) viewer.entities.remove(old);

    viewer.entities.add({
      id: tasking.targetEntityId,
      name: "Целевая область (прямоугольник)",
      polygon: {
        hierarchy: corners,
        material: Cesium.Color.YELLOW.withAlpha(0.18),
        outline: true,
        outlineColor: Cesium.Color.YELLOW.withAlpha(0.9)
      },
      polyline: {
        positions: corners.concat([corners[0]]),
        width: 2,
        material: Cesium.Color.YELLOW.withAlpha(0.9)
      }
    });
  }

  function clearRect() {
    const viewer = getViewer();
    if (!viewer) return;
    const old = viewer.entities.getById(tasking.targetEntityId);
    if (old) viewer.entities.remove(old);
    tasking.targetRect = null;
    $("tasking-target-status").textContent = "—";
  }

  function pickBestMissionSat(rect) {
    const viewer = getViewer();
    const clock = getClock();
    if (!viewer || !clock) return null;

    const t0 = nowJulian(clock);
    const horizonSec = 15 * 60;
    const stepSec = clamp(parseInt($("tasking-search-step")?.value || "15", 10) || 15, 1, 120);
    const footprintKm = clamp(parseFloat($("tasking-footprint-km")?.value || "80") || 80, 0, 2000);
    const sats = getMissionSats(t0);

    let best = null; // {sat, etaSec}

    for (const sat of sats) {
      const st = getSatState(sat, t0);
      if (st !== "IDLE") continue;

      // быстрый перебор по горизонту
      for (let dt = 0; dt <= horizonSec; dt += stepSec) {
        const tt = Cesium.JulianDate.addSeconds(t0, dt, new Cesium.JulianDate());
        const pos = sat.position?.getValue?.(tt);
        if (!pos) continue;
        const ll = cartesianToLonLat(pos);
        // Критерий подхода к области:
        // 1) точка внутри прямоугольника, ИЛИ
        // 2) точка в пределах "радиуса покрытия" от прямоугольника
        const inside = rectContains(rect, ll.lon, ll.lat);
        const distKm = inside ? 0 : distancePointToRectKm(rect, ll.lon, ll.lat);
        if (inside || distKm <= footprintKm) {
          if (!best || dt < best.etaSec) {
            best = { sat, etaSec: dt, distKm };
          }
          break;
        }
      }
    }

    return best;
  }

  function updateChosenUi(ent, etaSec, distKm) {
    const time = nowJulian(getClock());
    const name = ent?.name || ent?.id || "—";
    $("tasking-mis-chosen").textContent = name;
    const etaStr = Number.isFinite(etaSec) ? `${Math.round(etaSec)} с` : "—";
    const distStr = Number.isFinite(distKm) ? `, Δ≈${distKm.toFixed(1)} км` : "";
    $("tasking-mis-eta").textContent = etaStr + distStr;
    $("tasking-status").textContent = "ГОТОВО К ОТПРАВКЕ";
  }

  function getRouteMetric() {
    return $("tasking-route-metric")?.value || "fast";
  }

  function getCmdDataMbits() {
    const kb = parseFloat($("tasking-cmd-kb")?.value || "8");
    return Math.max(0.001, (Number.isFinite(kb) ? kb : 8) * 8 / 1024); // KB -> Mbit
  }

  function getResultDataMbits() {
    const mb = parseFloat($("tasking-result-mb")?.value || "50");
    return Math.max(0.001, (Number.isFinite(mb) ? mb : 50) * 8); // MB -> Mbit
  }

  function pickGsEntityForMode() {
    const mode = $("tasking-gs-mode")?.value || "auto";
    const viewer = getViewer();
    if (!viewer) return null;
    if (mode === "manual") {
      const id = $("tasking-gs-select")?.value;
      return id ? viewer.entities.getById(id) : null;
    }
    // auto: если в панели "Станции" пользователь закрепил станцию — используем как приоритет (если есть)
    const pinned = window.spaceMesh?.groundStations?.selectedStation;
    return pinned || null;
  }

  function computeBestUplink(time, misId) {
    const viewer = getViewer();
    if (!viewer || !misId) return null;

    const metric = getRouteMetric();
    const dataMbits = getCmdDataMbits();

    const mode = $("tasking-gs-mode")?.value || "auto";
    if (mode === "manual") {
      const gs = pickGsEntityForMode();
      if (!gs) return null;
      const g = buildGraphSnapshot(time, gs);
      if (!g) return null;
      const r = dijkstra(g.adj, gs.id, misId, metric, dataMbits, g.cfg);
      return r ? { gs, graph: g, route: r } : null;
    }

    // auto: перебираем все станции и выбираем минимум по стоимости
    const stations = getGroundStations();
    let best = null;
    for (const gs of stations) {
      const g = buildGraphSnapshot(time, gs);
      if (!g) continue;
      const r = dijkstra(g.adj, gs.id, misId, metric, dataMbits, g.cfg);
      if (!r) continue;
      if (!best || r.cost < best.route.cost) {
        best = { gs, graph: g, route: r };
      }
    }
    return best;
  }

  function computeBestDownlink(time, misId) {
    const viewer = getViewer();
    if (!viewer || !misId) return null;

    const metric = getRouteMetric();
    const dataMbits = getResultDataMbits();

    const mode = $("tasking-gs-mode")?.value || "auto";
    if (mode === "manual") {
      const gs = pickGsEntityForMode();
      if (!gs) return null;
      const g = buildGraphSnapshot(time, gs);
      if (!g) return null;
      const r = dijkstra(g.adj, misId, gs.id, metric, dataMbits, g.cfg);
      return r ? { gs, graph: g, route: r } : null;
    }

    const stations = getGroundStations();
    let best = null;
    for (const gs of stations) {
      const g = buildGraphSnapshot(time, gs);
      if (!g) continue;
      const r = dijkstra(g.adj, misId, gs.id, metric, dataMbits, g.cfg);
      if (!r) continue;
      if (!best || r.cost < best.route.cost) {
        best = { gs, graph: g, route: r };
      }
    }
    return best;
  }

  function summarizeRoute(route, label, dataMbits) {
    if (!route) return `${label}: маршрут не найден.`;
    const hops = route.hopEdges.length;
    const distKm = route.hopEdges.reduce((s, e) => s + (Number.isFinite(e.distanceKm) ? e.distanceKm : 0), 0);
    let minSnr = Infinity;
    let minCap = Infinity;
    for (const e of route.hopEdges) {
      if (Number.isFinite(e.snrDb)) minSnr = Math.min(minSnr, e.snrDb);
      if (Number.isFinite(e.capacityMbps)) minCap = Math.min(minCap, e.capacityMbps);
    }
    if (!isFinite(minSnr)) minSnr = NaN;
    if (!isFinite(minCap)) minCap = NaN;
    const tMin = Number.isFinite(minCap) ? (dataMbits / Math.max(0.001, minCap)) : NaN;
    return `${label}: hops=${hops}, Σd≈${distKm.toFixed(0)} км, SNR(min)≈${Number.isFinite(minSnr) ? minSnr.toFixed(1) : "-"} dB, C(min)≈${Number.isFinite(minCap) ? minCap.toFixed(1) : "-"} Мбит/с, оценка t≈${Number.isFinite(tMin) ? tMin.toFixed(1) : "-"} с.`;
  }

  function buildAndRenderRoutesSnapshot() {
    const viewer = getViewer();
    const clock = getClock();
    if (!viewer || !clock) return;
    const time = nowJulian(clock);
    const misId = tasking.chosenMisId;
    if (!misId) return;

    // uplink
    const up = computeBestUplink(time, misId);
    if (up && up.route) {
      renderRoute(ROUTE_IDS.uplinkPrefix, up.route.hopEdges, Cesium.Color.CYAN.withAlpha(0.9));
      $("tasking-uplink-summary").textContent = summarizeRoute(up.route, "Uplink", getCmdDataMbits());
      $("tasking-uplink-table").innerHTML = makeHopsTable(up.route.hopEdges, "Uplink");
    } else {
      clearRouteEntities(ROUTE_IDS.uplinkPrefix);
      $("tasking-uplink-summary").textContent = "Uplink: маршрут не найден.";
      $("tasking-uplink-table").innerHTML = makeHopsTable([], "Uplink");
    }

    // downlink
    const down = computeBestDownlink(time, misId);
    if (down && down.route) {
      renderRoute(ROUTE_IDS.downlinkPrefix, down.route.hopEdges, Cesium.Color.LIME.withAlpha(0.9));
      $("tasking-downlink-summary").textContent = summarizeRoute(down.route, "Downlink", getResultDataMbits());
      $("tasking-downlink-table").innerHTML = makeHopsTable(down.route.hopEdges, "Downlink");
    } else {
      clearRouteEntities(ROUTE_IDS.downlinkPrefix);
      $("tasking-downlink-summary").textContent = "Downlink: маршрут не найден.";
      $("tasking-downlink-table").innerHTML = makeHopsTable([], "Downlink");
    }
  }

  function updateTimelineUi(task) {
    if (!task) return;
    $("tasking-stage").textContent = task.stageName;
    $("tasking-remaining").textContent = `${Math.max(0, Math.ceil(task.remainingSec))} с`;
    $("tasking-total-remaining").textContent = `${Math.max(0, Math.ceil(task.totalRemainingSec))} с`;

    $("tasking-uplink").textContent = `${task.uplinkSec} с`;
    $("tasking-exec").textContent = `${task.execSec} с`;
    $("tasking-downlink").textContent = `${task.downlinkSec} с`;
  }

  function stopTaskTimer() {
    if (tasking.tick) { clearInterval(tasking.tick); tasking.tick = null; }
    tasking.task = null;
  }

  function startScenario() {
    const rect = tasking.targetRect;
    const viewer = getViewer();
    const clock = getClock();
    if (!rect || !viewer || !clock) return;

    const time = nowJulian(clock);

    const chosenId = tasking.chosenMisId;
    const sat = chosenId ? viewer.entities.getById(chosenId) : null;
    if (!sat) {
      $("tasking-status").textContent = "ОШИБКА: не выбран MIS-КА";
      return;
    }

    // Снимок маршрутов на момент отправки (uplink + предварительный downlink)
    buildAndRenderRoutesSnapshot();

    // бюджеты (можно редактировать в UI)
    const uplinkSec = clamp(parseInt($("tasking-uplink-sec")?.value || "120", 10) || 120, 10, 600);
    const execMin = clamp(parseInt($("tasking-exec-min")?.value || "300", 10) || 300, 30, 900);
    const execMax = clamp(parseInt($("tasking-exec-max")?.value || "420", 10) || 420, 30, 900);
    const downlinkSec = clamp(parseInt($("tasking-downlink-sec")?.value || "360", 10) || 360, 10, 900);
    const execSec = clamp(execMin + Math.floor(Math.random() * Math.max(1, (execMax - execMin + 1))), 30, 900);

    const totalSec = uplinkSec + execSec + downlinkSec;

    const task = {
      createdAt: time,
      stage: "UPLINKING",
      stageName: "Отправка задания (uplink)",
      remainingSec: uplinkSec,
      totalRemainingSec: totalSec,
      uplinkSec,
      execSec,
      downlinkSec,
      satId: sat.id
    };

    tasking.task = task;
    $("tasking-status").textContent = "ЗАДАНИЕ В РАБОТЕ";
    updateTimelineUi(task);

    // таймер — 1 Гц
    stopTaskTimer();
    tasking.task = task;

    tasking.tick = setInterval(() => {
      if (!tasking.task) return;
      tasking.task.remainingSec -= 1;
      tasking.task.totalRemainingSec -= 1;

      if (tasking.task.remainingSec <= 0) {
        // переход этапов
        if (tasking.task.stage === "UPLINKING") {
          tasking.task.stage = "EXECUTING";
          tasking.task.stageName = "Выполнение задания (съёмка)";
          tasking.task.remainingSec = tasking.task.execSec;

          // команда "доставлена" — MIS-КА уходит из сети
          const ent = viewer.entities.getById(tasking.task.satId);
          setSatState(ent, "BUSY");
        } else if (tasking.task.stage === "EXECUTING") {
          tasking.task.stage = "DOWNLINKING";
          tasking.task.stageName = "Передача результата (downlink)";
          tasking.task.remainingSec = tasking.task.downlinkSec;

          // MIS-КА возвращается в сеть
          const ent = viewer.entities.getById(tasking.task.satId);
          setSatState(ent, "IDLE");

          // По завершении выполнения — перепланируем (КА/линки уже сместились)
          buildAndRenderRoutesSnapshot();
        } else if (tasking.task.stage === "DOWNLINKING") {
          tasking.task.stage = "DONE";
          tasking.task.stageName = "Завершено";
          tasking.task.remainingSec = 0;
          tasking.task.totalRemainingSec = 0;
          $("tasking-status").textContent = "ЗАДАНИЕ ВЫПОЛНЕНО";
          updateTimelineUi(tasking.task);
          stopTaskTimer();
          return;
        }
      }

      updateTimelineUi(tasking.task);
    }, 1000);
  }

  // -------------------------
  // Init
  // -------------------------
  function init() {
    const panel = $("tasking-panel");
    const toggle = $("tasking-toggle");
    if (panel && toggle) {
      toggle.addEventListener("click", () => {
        const hidden = panel.classList.toggle("hidden");
        toggle.textContent = hidden ? "▼ Задания" : "▲ Задания";
      });
    }

    // draggable
    if (panel) {
      const h1 = panel.querySelector("h1");
      makeDraggable(panel, h1, "taskingPanelPos");
    }

    // GS mode
    $("tasking-gs-mode")?.addEventListener("change", updateGsModeUi);

    // Buttons
    $("tasking-refresh-gs")?.addEventListener("click", (e) => {
      e.preventDefault();
      fillGroundStationSelect();
    });

    $("tasking-apply-rect")?.addEventListener("click", (e) => {
      e.preventDefault();
      const r = parseRectFromInputs();
      if (!r) {
        $("tasking-target-status").textContent = "Ошибка: проверь координаты (пока без пересечения 180°)";
        return;
      }
      tasking.targetRect = r;
      drawOrUpdateRect(r);
      $("tasking-target-status").textContent =
        `OK: lon[${r.lonMin.toFixed(3)}…${r.lonMax.toFixed(3)}], lat[${r.latMin.toFixed(3)}…${r.latMax.toFixed(3)}]`;
    });

    $("tasking-clear-rect")?.addEventListener("click", (e) => {
      e.preventDefault();
      clearRect();
    });

    $("tasking-pick-mis")?.addEventListener("click", (e) => {
      e.preventDefault();
      const rect = tasking.targetRect;
      const viewer = getViewer();
      const clock = getClock();
      if (!rect || !viewer || !clock) {
        $("tasking-status").textContent = "Ошибка: сначала задайте область";
        return;
      }

      $("tasking-status").textContent = "Подбор исполнителя…";
      const best = pickBestMissionSat(rect);
      if (!best) {
        $("tasking-status").textContent = "Не найден MIS-КА, который успевает попасть в область за 15 минут";
        tasking.chosenMisId = null;
        $("tasking-mis-chosen").textContent = "—";
        $("tasking-mis-eta").textContent = "—";
        return;
      }

      tasking.chosenMisId = best.sat.id;
      updateChosenUi(best.sat, best.etaSec, best.distKm);
    });

    // Imaging + Routing UI + events
    ensureRoutingUi();
    ensureImagingUi();
    $("tasking-build-routes")?.addEventListener("click", (e) => {
      e.preventDefault();
      buildAndRenderRoutesSnapshot();
    });

    // Автоперестройка маршрута при обновлении радио-топологии
    window.addEventListener("spaceMesh:radioTick", () => {
      const auto = $("tasking-route-autoupd")?.value || "off";
      if (auto !== "on") return;

      // перестраиваем только если выбран MIS-КА
      if (!tasking.chosenMisId) return;

      // и только если мы в фазах выяснения маршрута/передачи (чтобы не грузить лишним)
      const stage = tasking.task?.stage || "IDLE";
      if (stage === "UPLINKING" || stage === "DOWNLINKING" || stage === "IDLE") {
        buildAndRenderRoutesSnapshot();
      }
    });

    $("tasking-send")?.addEventListener("click", (e) => {
      e.preventDefault();
      startScenario();
    });

    // initial
    updateGsModeUi();
    fillGroundStationSelect();

    $("tasking-status").textContent = "Ожидание параметров…";
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();