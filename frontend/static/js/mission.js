// static/js/mission.js
// Панель "КА заданий" (MIS) — сделана в стиле панели "Орбиты и КА" из app.js

(function () {
  if (typeof Cesium === "undefined") {
    console.warn("mission.js: Cesium не найден, миссионный слой отключён.");
    return;
  }

  // --- доступ к общему namespace ---
  const sm = (window.spaceMesh = window.spaceMesh || {});
  const viewer = sm.viewer || window.viewer;
  const clock = sm.clock || (viewer ? viewer.clock : null);
  const startTime = sm.start || window.start;
  const EARTH_RADIUS = sm.EARTH_RADIUS || window.EARTH_RADIUS;

  if (!viewer || !clock || !startTime || !EARTH_RADIUS) {
    console.warn(
      "mission.js: нет доступа к viewer/clock/start/EARTH_RADIUS. Проверь порядок подключения (app.js должен быть раньше)."
    );
    return;
  }

  // --- константы ---
  const DEG2RAD = Math.PI / 180;
  const MU = 3.986004418e14; // м^3/с^2
  const T_SIDEREAL = 86164; // сек
  const OMEGA_E = (2 * Math.PI) / T_SIDEREAL;

  // --- полярная "дырка" (как в app.js) ---
  const POLAR_CAP_DEG = 8;
  const POLAR_LAT_LIMIT_DEG = 90 - POLAR_CAP_DEG; // 82°

  function orbitReachesForbiddenPolarZone(inclinationDeg, latLimitDeg) {
    const maxLat = Math.min(inclinationDeg, 180 - inclinationDeg);
    return maxLat > latLimitDeg;
  }

  // --- хранилище MIS-орбит ---
  const missionStore = sm.missionStore || [];
  sm.missionStore = missionStore; // важно: сохраняем ссылку

  sm._missionIdCounter = typeof sm._missionIdCounter === "number" ? sm._missionIdCounter : 0;
  let missionIdCounter = sm._missionIdCounter;

  // --- UI: toggle ---
  const missionPanel = document.getElementById("mission-panel");
  const missionToggle = document.getElementById("mission-toggle");

  if (missionPanel && missionToggle) {
    missionToggle.addEventListener("click", () => {
      const hidden = missionPanel.classList.toggle("hidden");
      missionToggle.textContent = hidden ? "▼ КА заданий" : "▲ КА заданий";
    });
  }

  // --- Draggable (как у других панелей) ---
  function makeDraggable(panelEl, handleEl, storageKey = "missionPanelPos") {
    if (!panelEl || !handleEl) return;

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
    let startX = 0,
      startY = 0;
    let startLeft = 0,
      startTop = 0;

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

  // --- утилиты ---
  function emitTopologyChanged() {
    window.dispatchEvent(new CustomEvent("spaceMesh:topologyChanged"));
    if (window.spaceMesh?.radio?.onTopologyChanged) {
      window.spaceMesh.radio.onTopologyChanged();
    }
  }

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

  // Цвета MIS-орбит (как для орбит: золотое сечение, ярко, читаемо)
function getMissionColorByIndex(index) {
  // Приглушённая MIS-палитра (контраст к mesh), без HSL
  const palette = [
    Cesium.Color.fromCssColorString("#C8A951"), // песочно-золотой
    Cesium.Color.fromCssColorString("#9E7C45"), // бронза
    Cesium.Color.fromCssColorString("#8E6F4E"), // тёплый серо-коричневый
    Cesium.Color.fromCssColorString("#A06A4A"), // терракота
    Cesium.Color.fromCssColorString("#7E8F4E"), // оливковый
    Cesium.Color.fromCssColorString("#6E7F6A"), // серо-зелёный
    Cesium.Color.fromCssColorString("#8B5E5E"), // приглушённый красный
    Cesium.Color.fromCssColorString("#5F6B73")  // серо-сине-стальной
  ];

  const base = palette[index % palette.length];

  // Небольшая вариация яркости: -1 / 0 / +1
  const v = (index % 3) - 1;

  // Смешивание с белым/чёрным (надёжно для Cesium.Color)
  const mix = (a, b, t) =>
    new Cesium.Color(
      a.red * (1 - t) + b.red * t,
      a.green * (1 - t) + b.green * t,
      a.blue * (1 - t) + b.blue * t,
      1.0
    );

  if (v === 1) return mix(base, Cesium.Color.WHITE, 0.12); // чуть светлее
  if (v === -1) return mix(base, Cesium.Color.BLACK, 0.10); // чуть темнее
  return base;
}

  // --- орбитальная динамика (как в app.js) ---
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

    // Межвитковый сдвиг трассы (к западу) за один период (как в app.js)
    const interOrbitShiftDeg = 360 * (period / T_SIDEREAL);
    const interOrbitShiftKmEquator =
      (Math.abs(interOrbitShiftDeg) * Math.PI / 180) * (EARTH_RADIUS / 1000);

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
      phaseOffsetRad,
      interOrbitShiftDeg,
      interOrbitShiftKmEquator
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
        name: orbit.name + " path (MIS)",
        polyline: {
          positions: positionsCallback,
          width: 1.4,
          material: new Cesium.PolylineDashMaterialProperty({
            color: color.withAlpha(0.85),
            dashLength: 6.0 // ← меньше = чаще пунктир (попробуй 4..8)
          })
        }
      });
  }

  // --- MIS-КА на орбите (квадрат, как было) ---
  function createMissionSatelliteOnOrbit(orbit, color, satIndex, totalSatellites, participatesInMeshFlag, orbitGroupId) {
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

    const fillCss = cesiumColorToCss(color);
    const img = makeSquareDataUri(fillCss);

    const satIndexHuman = satIndex + 1;
    const altitudeKm = orbit.altitude / 1000;
    const inclinationDeg = (orbit.inclination * 180) / Math.PI;
    const periodMin = orbit.period / 60;
    const speedKms = orbit.orbitalSpeed / 1000;

    // Параметры шага (для инфо)
    const r = EARTH_RADIUS + orbit.altitude;
    const phaseDeg = (deltaThetaRad * 180) / Math.PI;
    const arcDistanceKm = (deltaThetaRad * r) / 1000;

    const descriptionHtml = `
      <div style="font-size:13px;">
        <h3 style="margin-top:0;">MIS-КА №${satIndexHuman}</h3>
        <p><b>Орбита:</b> ${orbit.name}</p>
        <p><b>Высота орбиты:</b> ${altitudeKm.toFixed(0)} км</p>
        <p><b>Наклонение:</b> ${inclinationDeg.toFixed(1)}°</p>
        <p><b>Орбитальный период:</b> ${periodMin.toFixed(1)} мин</p>
        <p><b>Орбитальная скорость:</b> ${speedKms.toFixed(2)} км/с</p>
        <p><b>Фазовый шаг между соседними КА:</b> ${phaseDeg.toFixed(1)}°</p>
        <p><b>Эквивалентное расстояние по орбите:</b> ${arcDistanceKm.toFixed(0)} км</p>
      </div>
    `;

    return viewer.entities.add({
      name: `MIS-КА #${satIndexHuman}`,
      position: positionProperty,
      billboard: {
        image: img,
        width: 22,
        height: 22,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        scaleByDistance: new Cesium.NearFarScalar(1e6, 1.2, 1.2e7, 0.6)
      },
      description: new Cesium.ConstantProperty(descriptionHtml),
      properties: {
        isSatellite: true,
        isMissionSatellite: true,
        orbitId: orbitGroupId ?? null,

        // unified radio mesh читает эти свойства
        participatesInMesh: new Cesium.ConstantProperty(!!participatesInMeshFlag),
        state: new Cesium.ConstantProperty("IDLE"),
        missionRole: new Cesium.ConstantProperty("EO"),

        // данные для отладки/вывода
        orbitName: new Cesium.ConstantProperty(orbit.name),
        satelliteIndex: new Cesium.ConstantProperty(satIndexHuman)
      }
    });
  }

  // --- создание/удаление миссий ---
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
    while (missionStore.some((g) => g?.name === name)) {
      k += 1;
      name = `${withPrefix}-${k}`;
    }
    return name;
  }

  function addMissionOrbitWithSatellites(opts) {
    const color = getMissionColorByIndex(missionStore.length);
    const cssColor = cesiumColorToCss(color);
    const groupId = missionIdCounter++;

    const orbit = createOrbit({
      name: opts.name,
      altitudeKm: opts.altitudeKm,
      inclinationDeg: opts.inclinationDeg,
      numSatellites: opts.numSatellites,
      evenSpacing: opts.evenSpacing !== undefined ? !!opts.evenSpacing : true,
      phaseStepDeg: opts.phaseStepDeg !== undefined ? opts.phaseStepDeg : 0
    });

    const polylineEntity = createOrbitPolyline(orbit, color);

    const satellites = [];
    for (let i = 0; i < orbit.numSatellites; i++) {
      satellites.push(
        createMissionSatelliteOnOrbit(orbit, color, i, orbit.numSatellites, opts.participatesInMesh, groupId)
      );
    }

    const group = {
      id: groupId,
      name: orbit.name,
      color,
      cssColor,
      orbit,
      polylineEntity,
      satellites,
      participatesInMesh: !!opts.participatesInMesh
    };

    sm._missionIdCounter = missionIdCounter;
    missionStore.push(group);

    renderMissionList();
    emitTopologyChanged();
  }

  function deleteMissionOrbit(orbitId) {
    const idx = missionStore.findIndex((g) => g && g.id === orbitId);
    if (idx === -1) return;

    const group = missionStore[idx];

    if (group.polylineEntity) viewer.entities.remove(group.polylineEntity);
    if (Array.isArray(group.satellites)) group.satellites.forEach((sat) => viewer.entities.remove(sat));

    missionStore.splice(idx, 1);

    renderMissionList();
    emitTopologyChanged();
  }

  function deleteAllMissions() {
    for (let i = missionStore.length - 1; i >= 0; i--) {
      const g = missionStore[i];
      if (g?.polylineEntity) viewer.entities.remove(g.polylineEntity);
      if (Array.isArray(g?.satellites)) g.satellites.forEach((ent) => viewer.entities.remove(ent));
    }
    missionStore.length = 0;

    renderMissionList();
    emitTopologyChanged();
  }

  function rebuildMissionSatellites(group, newTotal) {
    if (!group || !group.orbit || !group.color) return;

    const total = Math.max(0, newTotal);
    const orbit = group.orbit;
    const color = group.color;
    const participates = !!group.participatesInMesh;

    if (Array.isArray(group.satellites)) {
      group.satellites.forEach((sat) => viewer.entities.remove(sat));
    }

    const satellites = [];
    for (let i = 0; i < total; i++) {
      satellites.push(createMissionSatelliteOnOrbit(orbit, color, i, total, participates, group.id));
    }

    group.satellites = satellites;
    group.orbit.numSatellites = total;
  }

  function deleteOneSatelliteFromMission(orbitId) {
    const group = missionStore.find((g) => g && g.id === orbitId);
    if (!group) return;
    const newTotal = (group.satellites?.length || 0) - 1;
    if (newTotal < 0) return;

    rebuildMissionSatellites(group, newTotal);

    renderMissionList();
    emitTopologyChanged();
  }

  function addOneSatelliteToMission(orbitId) {
    const group = missionStore.find((g) => g && g.id === orbitId);
    if (!group) return;

    rebuildMissionSatellites(group, (group.satellites?.length || 0) + 1);

    renderMissionList();
    emitTopologyChanged();
  }

  // --- UI: список MIS-орбит (в стиле app.js) ---
  const missionListEl = document.getElementById("mission-list");
  const deleteAllBtn = document.getElementById("mission-delete-all");

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

    missionStore.forEach((group) => {
      if (!group || !group.orbit) return;

      const li = document.createElement("li");
      if (group.cssColor) {
        li.style.borderLeftColor = group.cssColor;
      }

      const header = document.createElement("div");
      header.className = "orbit-header";

      const headerLeft = document.createElement("div");
      headerLeft.className = "orbit-header-left";

      const colorDot = document.createElement("div");
      colorDot.className = "orbit-color-dot";
      if (group.cssColor) colorDot.style.backgroundColor = group.cssColor;

      const nameSpan = document.createElement("span");
      nameSpan.className = "orbit-name";
      nameSpan.textContent = group.name;

      headerLeft.appendChild(colorDot);
      headerLeft.appendChild(nameSpan);

      const countSpan = document.createElement("span");
      countSpan.className = "orbit-count";
      countSpan.textContent = `КА: ${group.satellites.length}`;

      header.appendChild(headerLeft);
      header.appendChild(countSpan);

      // --- параметры (как в app.js) ---
      const paramsDiv = document.createElement("div");
      paramsDiv.className = "orbit-params";

      const altKm = (group.orbit.altitude / 1000).toFixed(0);
      const inclDeg = (group.orbit.inclination * 180) / Math.PI;
      const periodMin = (group.orbit.period / 60).toFixed(1);

      const totalSats = group.satellites.length > 0 ? group.satellites.length : group.orbit.numSatellites;

      // deltaTheta (даже если MIS всегда evenSpacing=true — считаем аналогично)
      let deltaThetaRad;
      if (group.orbit.evenSpacing || !group.orbit.phaseStepRad || group.orbit.phaseStepRad <= 0) {
        deltaThetaRad = totalSats > 0 ? (2 * Math.PI) / totalSats : 0;
      } else {
        deltaThetaRad = group.orbit.phaseStepRad;
      }

      const phaseDeg = (deltaThetaRad * 180) / Math.PI;
      const rOrbit = EARTH_RADIUS + group.orbit.altitude;
      const arcDistanceKm = (deltaThetaRad * rOrbit) / 1000;

      const shiftDeg = group.orbit.interOrbitShiftDeg || 0;
      const shiftKm = group.orbit.interOrbitShiftKmEquator || 0;

      paramsDiv.innerHTML = `
        <div>Высота орбиты, км: <b>${altKm}</b></div>
        <div>Наклонение, °: <b>${inclDeg.toFixed(1)}</b></div>
        <div>Период, мин: <b>${periodMin}</b></div>
        <div>Фазовый шаг между КА, °: <b>${phaseDeg.toFixed(1)}</b></div>
        <div>Эквивалентное расстояние по орбите, км: <b>${arcDistanceKm.toFixed(0)}</b></div>
        <div>Равномерное распределение: <b>${group.orbit.evenSpacing ? "да" : "нет"}</b></div>
        <div>Межвитковый сдвиг трассы, °: <b>${shiftDeg.toFixed(1)} (к западу)</b></div>
        <div>Смещение начала следующего витка по экватору, км: <b>${shiftKm.toFixed(0)}</b></div>
      `;

      // --- кнопки (как в app.js) ---
      const actions = document.createElement("div");
      actions.className = "orbit-actions";

      const btnDeleteOrbit = document.createElement("button");
      btnDeleteOrbit.className = "btn-delete-orbit";
      btnDeleteOrbit.type = "button";
      btnDeleteOrbit.textContent = "Удалить орбиту";
      btnDeleteOrbit.onclick = () => deleteMissionOrbit(group.id);

      const btnDeleteSat = document.createElement("button");
      btnDeleteSat.className = "btn-delete-sat";
      btnDeleteSat.type = "button";
      btnDeleteSat.textContent = "Удалить один КА";
      btnDeleteSat.onclick = () => deleteOneSatelliteFromMission(group.id);

      const btnAddSat = document.createElement("button");
      btnAddSat.className = "btn-add-sat";
      btnAddSat.type = "button";
      btnAddSat.textContent = "Добавить один КА";
      btnAddSat.onclick = () => addOneSatelliteToMission(group.id);

      actions.appendChild(btnDeleteOrbit);
      actions.appendChild(btnDeleteSat);
      actions.appendChild(btnAddSat);

      li.appendChild(header);
      li.appendChild(paramsDiv);
      li.appendChild(actions);

      missionListEl.appendChild(li);
    });
  }

  // --- UI: удалить все ---
  if (deleteAllBtn) {
    deleteAllBtn.addEventListener("click", () => deleteAllMissions());
  }

  // --- UI: создание из формы ---
  const form = document.getElementById("mission-form");
  if (!form) {
    console.warn("mission.js: не найден #mission-form (панель миссий не добавлена).");
    return;
  }

  const nameEl = document.getElementById("mission-orbit-name");
  const altEl = document.getElementById("mission-altitude");
  const incEl = document.getElementById("mission-inclination");
  const numEl = document.getElementById("mission-num-sats");

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    const name = ensureMissionName(nameEl ? nameEl.value : "MIS-LEO");
    const altitudeKm = safeNum(altEl ? altEl.value : 450, 450, 120, 2000);
    const inclinationDeg = safeNum(incEl ? incEl.value : 61, 61, 0, 180);
    const numSatellites = Math.max(1, Math.floor(safeNum(numEl ? numEl.value : 20, 20, 1, 500)));

    addMissionOrbitWithSatellites({
      name,
      altitudeKm,
      inclinationDeg,
      numSatellites,
      participatesInMesh: true
    });

    console.log(
      `[mission] created orbit=${name}, h=${altitudeKm}km, i=${inclinationDeg}°, sats=${numSatellites}, mesh=true`
    );
  });


  // --- UI: массовое создание MIS-орбит (как "Создать массив орбит" в app.js) ---
  const bulkForm = document.getElementById("mission-bulk-orbits-form");
  if (bulkForm) {
    const altInput = document.getElementById("mission-bulk-altitude");
    const numSatsInput = document.getElementById("mission-bulk-num-sats");
    const evenSpacingInput = document.getElementById("mission-bulk-even-spacing");
    const phaseStepInput = document.getElementById("mission-bulk-phase-step");
    const numOrbitsInput = document.getElementById("mission-bulk-num-orbits");
    const inclInfoEl = document.getElementById("mission-bulk-incl-info");
    const skipPolarInput = document.getElementById("mission-bulk-skip-polar");

    function updateInclInfo() {
      if (!inclInfoEl || !numOrbitsInput || !skipPolarInput) return;

      const numOrbitsRaw = parseInt(numOrbitsInput.value, 10);
      const numOrbits = Number.isInteger(numOrbitsRaw) && numOrbitsRaw > 0 ? numOrbitsRaw : 1;

      const skipPolar = !!skipPolarInput.checked;

      const gapWidthDeg = 2 * POLAR_CAP_DEG; // 16° при cap=8
      const lowMaxDeg = POLAR_LAT_LIMIT_DEG; // 82°
      const highMinDeg = 180 - POLAR_LAT_LIMIT_DEG; // 98°
      const allowedSpanDeg = 180 - (skipPolar ? gapWidthDeg : 0);

      if (!skipPolar) {
        const inclStep = 180 / numOrbits;
        inclInfoEl.textContent = `Шаг между орбитами: ${inclStep.toFixed(2)}° (равномерно от 0 до 180°, 180° исключена)`;
      } else {
        const effStep = allowedSpanDeg / numOrbits;
        inclInfoEl.textContent =
          `Исключение околополярных включено: запрещённая зона ~(${lowMaxDeg.toFixed(1)}°..${highMinDeg.toFixed(1)}°). ` +
          `Наклонения распределяются равномерно по допустимым зонам. ` +
          `Эффективный шаг по допустимому диапазону: ${effStep.toFixed(2)}° (создастся ровно ${numOrbits} орбит)`;
      }
    }

    // обновляем инфо при изменении
    [numOrbitsInput, skipPolarInput].forEach((el) => {
      if (!el) return;
      el.addEventListener("change", updateInclInfo);
      el.addEventListener("input", updateInclInfo);
    });
    updateInclInfo();

    bulkForm.addEventListener("submit", function (e) {
      e.preventDefault();

      if (
        !altInput ||
        !numSatsInput ||
        !evenSpacingInput ||
        !phaseStepInput ||
        !numOrbitsInput ||
        !skipPolarInput
      ) {
        console.error("mission.js: не найдены элементы формы массовых MIS-орбит.");
        return;
      }

      const altitudeRaw = parseFloat(altInput.value);
      const numSatsRaw = parseInt(numSatsInput.value, 10);
      const numOrbitsRaw = parseInt(numOrbitsInput.value, 10);

      const altitudeKm = Number.isFinite(altitudeRaw) ? altitudeRaw : 450;
      const numSatellites = Number.isInteger(numSatsRaw) ? numSatsRaw : 20;

      const numOrbits = Number.isInteger(numOrbitsRaw) && numOrbitsRaw > 0 ? numOrbitsRaw : 1;

      const evenSpacing = !!evenSpacingInput.checked;

      const phaseStepRaw = parseFloat(phaseStepInput.value);
      const phaseStepDeg = Number.isFinite(phaseStepRaw) ? phaseStepRaw : 0;

      const skipPolar = !!skipPolarInput.checked;

      // диап. наклонений: [0..180), 180 исключаем; при skipPolar — перепрыгиваем зону вокруг 90°
      const gapWidthDeg = 2 * POLAR_CAP_DEG;
      const lowMaxDeg = POLAR_LAT_LIMIT_DEG;
      const highMinDeg = 180 - POLAR_LAT_LIMIT_DEG;
      const allowedSpanDeg = 180 - (skipPolar ? gapWidthDeg : 0);

      for (let k = 0; k < numOrbits; k++) {
        let incl;

        if (!skipPolar) {
          incl = (k * 180) / numOrbits;
        } else {
          const t = k / numOrbits;
          const s = t * allowedSpanDeg;

          incl = s <= lowMaxDeg ? s : s + gapWidthDeg;

          if (orbitReachesForbiddenPolarZone(incl, POLAR_LAT_LIMIT_DEG)) {
            incl = highMinDeg;
          }

          if (incl >= 180) incl = 180 - 1e-6;
        }

        const inclRounded = Math.round(incl * 1000) / 1000;

        const baseName = `MIS-Shell i=${inclRounded.toFixed(1)}°`;
        const name = ensureMissionName(baseName);

        addMissionOrbitWithSatellites({
          name,
          altitudeKm,
          inclinationDeg: inclRounded,
          numSatellites,
          evenSpacing,
          phaseStepDeg,
          participatesInMesh: true
        });
      }

      console.log(`[mission] bulk created: orbits=${numOrbits}, h=${altitudeKm}km, sats=${numSatellites}`);
    });
  }

  // стартовый рендер
  renderMissionList();

  // экспорт мини-API
  sm.mission = sm.mission || {};
  sm.mission.deleteAll = deleteAllMissions;
  sm.mission.store = missionStore;
})();
