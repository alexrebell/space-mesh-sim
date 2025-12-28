// static/js/mission.js
// Слой "КА заданий": отдельный missionStore, квадратные маркеры, участие в mesh через participatesInMesh.
// НЕ зависит от window.createOrbit/... (потому что в app.js это не экспортируется в window).

(function () {
  if (typeof Cesium === "undefined") {
    console.warn("mission.js: Cesium не найден, миссионный слой отключён.");
    return;
  }

  // --- База из app.js (экспортируется в window.spaceMesh) ---
  const sm = (window.spaceMesh = window.spaceMesh || {});
  const viewer = sm.viewer || window.viewer;
  const clock = sm.clock || (viewer ? viewer.clock : null);
  const startTime = sm.start || window.start;
  const EARTH_RADIUS = sm.EARTH_RADIUS || window.EARTH_RADIUS;

  if (!viewer || !clock || !startTime || !EARTH_RADIUS) {
    console.warn("mission.js: нет доступа к viewer/clock/start/EARTH_RADIUS. Проверь порядок подключения (app.js должен быть раньше).");
    return;
  }

  // --- Константы орбитальной динамики (как в app.js) ---
  const DEG2RAD = Math.PI / 180;
  const MU = 3.986004418e14; // м^3/с^2
  const T_SIDEREAL = 86164;  // сек
  const OMEGA_E = (2 * Math.PI) / T_SIDEREAL; // рад/с

  // --- missionStore (важно: не переназначать, чтобы другие модули видели одну ссылку) ---
  const missionStore = sm.missionStore || [];
  missionStore.length = missionStore.length; // no-op: оставляем ссылку
  sm.missionStore = missionStore;

  let missionIdCounter = sm._missionIdCounter || 0;
  sm._missionIdCounter = missionIdCounter;

  // -------------------------
  // UI: toggle панели (без inline script -> CSP-friendly)
  // -------------------------
  const missionPanel = document.getElementById("mission-panel");
  const missionToggle = document.getElementById("mission-toggle");

  if (missionPanel && missionToggle) {
    missionToggle.addEventListener("click", () => {
      const hidden = missionPanel.classList.toggle("hidden");
      missionToggle.textContent = hidden ? "▼ КА заданий" : "▲ КА заданий";
    });
  }

  // -------------------------
  // Draggable (как ground-panel)
  // -------------------------
  function makeDraggable(panelEl, handleEl, storageKey = "missionPanelPos") {
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
      if (e.target && e.target.closest && e.target.closest("button, input, select, textarea")) return;

      dragging = true;
      handleEl.setPointerCapture(e.pointerId);

      const rect = panelEl.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      panelEl.style.left = rect.left + "px";
      panelEl.style.top = rect.top + "px";
      panelEl.style.right = "auto";
      panelEl.style.bottom = "auto";
    });

    handleEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const rect = panelEl.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      newLeft = Math.max(0, Math.min(window.innerWidth - w, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - h, newTop));

      panelEl.style.left = newLeft + "px";
      panelEl.style.top = newTop + "px";
    });

    function stopDrag() {
      if (!dragging) return;
      dragging = false;
      const rect = panelEl.getBoundingClientRect();
      localStorage.setItem(storageKey, JSON.stringify({ left: rect.left, top: rect.top }));
    }

    handleEl.addEventListener("pointerup", stopDrag);
    handleEl.addEventListener("pointercancel", stopDrag);
  }

  if (missionPanel) {
    const handle = missionPanel.querySelector("h1");
    makeDraggable(missionPanel, handle, "missionPanelPos");
  }

  // -------------------------
  // Орбитальная математика (локальная копия логики app.js)
  // -------------------------
  function computeOrbitDynamics(altitudeMeters) {
    const a = EARTH_RADIUS + altitudeMeters;
    const period = 2 * Math.PI * Math.sqrt(Math.pow(a, 3) / MU);
    const speed = Math.sqrt(MU / a);
    return { period, speed };
  }

  function createOrbit(options) {
    const altitudeMeters = options.altitudeKm * 1000;
    const { period, speed } = computeOrbitDynamics(altitudeMeters);

    const phaseStepDeg = options.phaseStepDeg || 0;
    const phaseStepRad = phaseStepDeg > 0 ? phaseStepDeg * DEG2RAD : null;

    const phaseOffsetRad = Math.random() * 2 * Math.PI;

    return {
      name: options.name,
      altitude: altitudeMeters,
      inclination: options.inclinationDeg * DEG2RAD,
      period,
      orbitalSpeed: speed,
      numSatellites: options.numSatellites || 1,
      evenSpacing: !!options.evenSpacing,
      phaseStepDeg,
      phaseStepRad,
      phaseOffsetRad
    };
  }

  function positionForTheta(theta, orbit, result) {
    const r = EARTH_RADIUS + orbit.altitude;

    const xPrime = r * Math.cos(theta);
    const yPrime = r * Math.sin(theta);
    const zPrime = 0.0;

    const cosI = Math.cos(orbit.inclination);
    const sinI = Math.sin(orbit.inclination);

    const x = xPrime;
    const y = yPrime * cosI - zPrime * sinI;
    const z = yPrime * sinI + zPrime * cosI;

    return Cesium.Cartesian3.fromElements(x, y, z, result);
  }

  function createOrbitPolyline(orbit, color) {
    const segments = 256;

    const positionsCallback = new Cesium.CallbackProperty(function (time, result) {
      const seconds = Cesium.JulianDate.secondsDifference(time, startTime);

      const earthRot = OMEGA_E * seconds;
      const cosE = Math.cos(-earthRot);
      const sinE = Math.sin(-earthRot);

      if (!result) result = [];
      result.length = 0;

      for (let i = 0; i <= segments; i++) {
        const theta = (2 * Math.PI * i) / segments;
        const inertialPos = positionForTheta(theta, orbit);

        const xIn = inertialPos.x;
        const yIn = inertialPos.y;
        const zIn = inertialPos.z;

        const x = xIn * cosE - yIn * sinE;
        const y = xIn * sinE + yIn * cosE;
        const z = zIn;

        result.push(new Cesium.Cartesian3(x, y, z));
      }

      return result;
    }, false);

    return viewer.entities.add({
      name: orbit.name + " path (mission)",
      polyline: {
        positions: positionsCallback,
        width: 1.6,
        material: color.withAlpha(0.75)
      }
    });
  }

  // -------------------------
  // Квадратный маркер (SVG data-uri)
  // -------------------------
  function cesiumColorToCss(color) {
    const r = Math.round(color.red * 255);
    const g = Math.round(color.green * 255);
    const b = Math.round(color.blue * 255);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function makeSquareDataUri(fillCss) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
      `<rect x="10" y="10" width="44" height="44" rx="4" ry="4" fill="${fillCss}" stroke="white" stroke-width="4"/>` +
      `</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

// --- Генерация уникальных цветов для MIS-орбит (HSL + золотое сечение) ---
function getMissionColorByIndex(index) {
  const goldenRatio = 0.618033988749895;
  const hue = (index * goldenRatio) % 1.0;

  // Чуть теплее/ярче, чтобы MIS-орбиты визуально отличались от обычных
  const saturation = 0.80;
  const lightness  = 0.58;

  return Cesium.Color.fromHsl(hue, saturation, lightness, 1.0);
}

  function createMissionSatelliteOnOrbit(orbit, color, satIndex, totalSatellites, participatesInMesh) {
    let deltaThetaRad;
    if (orbit.evenSpacing || !orbit.phaseStepRad || orbit.phaseStepRad <= 0) {
      deltaThetaRad = totalSatellites > 0 ? (2 * Math.PI) / totalSatellites : 0;
    } else {
      deltaThetaRad = orbit.phaseStepRad;
    }

    const theta0 = (orbit.phaseOffsetRad || 0) + satIndex * deltaThetaRad;

    const positionProperty = new Cesium.CallbackProperty(function (time, result) {
      const seconds = Cesium.JulianDate.secondsDifference(time, startTime);

      const baseTheta = (2 * Math.PI * (seconds % orbit.period)) / orbit.period;
      const theta = baseTheta + theta0;

      const inertialPos = positionForTheta(theta, orbit);

      const earthRot = OMEGA_E * seconds;
      const cosE = Math.cos(-earthRot);
      const sinE = Math.sin(-earthRot);

      const xIn = inertialPos.x;
      const yIn = inertialPos.y;
      const zIn = inertialPos.z;

      const x = xIn * cosE - yIn * sinE;
      const y = xIn * sinE + yIn * cosE;
      const z = zIn;

      if (!result) result = new Cesium.Cartesian3();
      return Cesium.Cartesian3.fromElements(x, y, z, result);
    }, false);

    // const fillCss = "#ff004c"; // яркий неоново-красный
    const fillCss = cesiumColorToCss(color); // берём цвет миссионной орбиты
    const img = makeSquareDataUri(fillCss);

    const ent = viewer.entities.add({
      name: `MIS-КА #${satIndex + 1}`,
      position: positionProperty,
      billboard: {
        image: img,
        width: 22,
        height: 22,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(1e6, 1.2, 1.2e7, 0.6)
      },
      properties: {
        isSatellite: true,
        isMissionSatellite: true,
        participatesInMesh: new Cesium.ConstantProperty(!!participatesInMesh),
        state: new Cesium.ConstantProperty("IDLE"),
        missionRole: new Cesium.ConstantProperty("EO")
      }
    });

    return ent;
  }

  // -------------------------
  // Создание миссий из формы
  // -------------------------
  function safeNum(v, def, min = -Infinity, max = Infinity) {
    const x = parseFloat(v);
    if (!isFinite(x)) return def;
    return Math.min(max, Math.max(min, x));
  }

  function ensureMissionName(raw) {
    const base = (raw || "").trim() || "MIS-LEO";
    const withPrefix = base.startsWith("MIS-") ? base : `MIS-${base}`;
    let name = withPrefix;
    let k = 1;
    while (missionStore.some(g => g?.name === name)) {
      k += 1;
      name = `${withPrefix}-${k}`;
    }
    return name;
  }

  function addMissionOrbitWithSatellites(opts) {
    const color = getMissionColorByIndex(missionStore.length);

    const orbit = createOrbit({
      name: opts.name,
      altitudeKm: opts.altitudeKm,
      inclinationDeg: opts.inclinationDeg,
      numSatellites: opts.numSatellites,
      evenSpacing: true,
      phaseStepDeg: 0
    });

    const polylineEntity = createOrbitPolyline(orbit, color);

    const satellites = [];
    for (let i = 0; i < orbit.numSatellites; i++) {
      const satEnt = createMissionSatelliteOnOrbit(
        orbit,
        color,
        i,
        orbit.numSatellites,
        opts.participatesInMesh
      );
      satellites.push(satEnt);
    }

    const group = {
      id: missionIdCounter++,
      name: orbit.name,
      color,
      orbit,
      polylineEntity,
      satellites
    };
    sm._missionIdCounter = missionIdCounter;

    missionStore.push(group);
  }

  function deleteAllMissions() {
    for (let i = missionStore.length - 1; i >= 0; i--) {
      const g = missionStore[i];
      if (g?.polylineEntity) viewer.entities.remove(g.polylineEntity);
      if (Array.isArray(g?.satellites)) g.satellites.forEach(ent => viewer.entities.remove(ent));
    }
    missionStore.length = 0; // сохраняем ссылку
  }
  // -------------------------
  // UI: список MIS-орбит и управление (как "Текущие орбиты")
  // -------------------------

  const missionListEl = document.getElementById("mission-list");
  const deleteAllBtn = document.getElementById("mission-delete-all");

  function emitTopologyChanged() {
    window.dispatchEvent(new Event("spaceMesh:topologyChanged"));
  }

  function formatKm(meters) {
    return (meters / 1000).toFixed(0);
  }

  function formatDeg(rad) {
    return (rad * 180 / Math.PI).toFixed(1);
  }

  function rebuildMissionSatellites(group, newCount) {
    if (!group || !group.orbit) return;

    // remove old satellites
    if (Array.isArray(group.satellites)) {
      group.satellites.forEach(ent => viewer.entities.remove(ent));
    }
    group.satellites = [];

    // update orbit count
    group.orbit.numSatellites = newCount;

    // recreate satellites with consistent spacing
    for (let i = 0; i < newCount; i++) {
      const satEnt = createMissionSatelliteOnOrbit(
        group.orbit,
        group.color,
        i,
        newCount,
        true // participatesInMesh (как у тебя сейчас)
      );
      group.satellites.push(satEnt);
    }

    emitTopologyChanged();
    renderMissionList();
  }

  function deleteMissionOrbitById(id) {
    const idx = missionStore.findIndex(g => g && g.id === id);
    if (idx < 0) return;

    const g = missionStore[idx];
    if (g?.polylineEntity) viewer.entities.remove(g.polylineEntity);
    if (Array.isArray(g?.satellites)) g.satellites.forEach(ent => viewer.entities.remove(ent));

    missionStore.splice(idx, 1);

    emitTopologyChanged();
    renderMissionList();
  }

  function addOneSatToMission(id) {
    const g = missionStore.find(x => x && x.id === id);
    if (!g || !g.orbit) return;

    const cur = Math.max(0, g.orbit.numSatellites || (g.satellites?.length || 0));
    const next = Math.min(cur + 1, 2000); // safety cap
    rebuildMissionSatellites(g, next);
  }

  function removeOneSatFromMission(id) {
    const g = missionStore.find(x => x && x.id === id);
    if (!g || !g.orbit) return;

    const cur = Math.max(0, g.orbit.numSatellites || (g.satellites?.length || 0));
    const next = Math.max(1, cur - 1); // минимум 1 КА, чтобы орбита не стала "пустой"
    rebuildMissionSatellites(g, next);
  }

  function renderMissionList() {
    if (!missionListEl) return;

    missionListEl.innerHTML = "";

    if (!missionStore.length) {
      const li = document.createElement("li");
      li.style.opacity = "0.75";
      li.textContent = "MIS-орбит нет — создайте в форме выше.";
      missionListEl.appendChild(li);
      return;
    }

    missionStore.forEach((g) => {
      if (!g || !g.orbit) return;

      const li = document.createElement("li");
      li.style.marginBottom = "8px";

      const count = g.orbit.numSatellites || (g.satellites ? g.satellites.length : 0);

      li.innerHTML = `
        <div style="display:flex; gap:8px; align-items:flex-start; justify-content:space-between;">
          <div>
            <div><b>${g.name}</b></div>
            <div style="font-size:11px; opacity:.85;">
              h=${formatKm(g.orbit.altitude)} км,
              i=${formatDeg(g.orbit.inclination)}°,
              КА=${count}
            </div>
          </div>

          <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
            <button type="button" data-act="mis-add-sat" data-id="${g.id}">➕ КА</button>
            <button type="button" data-act="mis-del-sat" data-id="${g.id}">➖ КА</button>
            <button type="button" data-act="mis-del-orbit" data-id="${g.id}" style="background:#d9534f;">
              🗑 Орбита
            </button>
          </div>
        </div>
      `;

      missionListEl.appendChild(li);
    });
  }

  // Делегирование кликов по списку
  if (missionListEl) {
    missionListEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;

      const act = btn.dataset.act;
      const id = parseInt(btn.dataset.id, 10);
      if (!act || !isFinite(id)) return;

      if (act === "mis-add-sat") addOneSatToMission(id);
      else if (act === "mis-del-sat") removeOneSatFromMission(id);
      else if (act === "mis-del-orbit") deleteMissionOrbitById(id);
    });
  }

  // Кнопка "удалить всё"
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener("click", () => {
      deleteAllMissions();
      emitTopologyChanged();
      renderMissionList();
    });
  }

  // UI элементы
  const form = document.getElementById("mission-form");
  if (!form) {
    console.warn("mission.js: не найден #mission-form (панель миссий не добавлена).");
    return;
  }

  const nameEl = document.getElementById("mission-orbit-name");
  const altEl = document.getElementById("mission-altitude");
  const incEl = document.getElementById("mission-inclination");
  const numEl = document.getElementById("mission-num-sats");

  const clearBtn = document.getElementById("clear-missions") || document.getElementById("mission-clear-all");

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    const name = ensureMissionName(nameEl ? nameEl.value : "MIS-LEO");
    const altitudeKm = safeNum(altEl ? altEl.value : 450, 450, 120, 2000);
    const inclinationDeg = safeNum(incEl ? incEl.value : 98, 98, 0, 180);
    const numSatellites = Math.max(1, Math.floor(safeNum(numEl ? numEl.value : 4, 4, 1, 500)));
    const participatesInMesh = true;

    addMissionOrbitWithSatellites({
      name,
      altitudeKm,
      inclinationDeg,
      numSatellites,
      participatesInMesh
    });
    renderMissionList();
    emitTopologyChanged();

    console.log(`[mission] created orbit=${name}, h=${altitudeKm}km, i=${inclinationDeg}°, sats=${numSatellites}, mesh=${participatesInMesh}`);
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      deleteAllMissions();
      console.log("[mission] all missions deleted");
    });
  }
  renderMissionList();

  // Экспорт полезных функций
  sm.mission = sm.mission || {};
  sm.mission.deleteAll = deleteAllMissions;
  sm.mission.store = missionStore;

})();
