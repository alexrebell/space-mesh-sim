// --- 1. Инициализация Viewer --- БЕЗ ИНТЕРНЕТА

const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: true,
  timeline: true,
  sceneModePicker: true,

  baseLayerPicker: false, // не даём выбирать онлайн-слои
  geocoder: false,
  homeButton: true,
  navigationHelpButton: false,

  imageryProvider: false, // <– ВАЖНО: вообще не создаём дефолтный imagery
  terrainProvider: new Cesium.EllipsoidTerrainProvider()
});

// --- Переопределяем кнопку Home (View Home) -> фокус на Россию ---
if (viewer.homeButton && viewer.homeButton.viewModel && viewer.homeButton.viewModel.command) {
  viewer.homeButton.viewModel.command.beforeExecute.addEventListener(function (e) {
    // отменяем стандартный "дом" Cesium (обычно смотрит на США/0 меридиан в зависимости от сцены)
    e.cancel = true;

    const lon = 70.0; // Долгота
    const lat = 40.0; // Широта
    const height = 20000000.0; // 20 000 км

    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: {
        heading: Cesium.Math.toRadians(0.0),
        pitch: Cesium.Math.toRadians(-90.0),
        roll: 0.0
      },
      duration: 1.2
    });
  });
}


// --- 1a. Явно добавляем офлайн-подложку как первый слой ---
const offlineImagery = new Cesium.SingleTileImageryProvider({
  url: "/static/textures/earth-offline.png",
  rectangle: Cesium.Rectangle.fromDegrees(-180, -90, 180, 90)
});

viewer.imageryLayers.removeAll();
viewer.imageryLayers.addImageryProvider(offlineImagery);

console.log("Imagery layers count:", viewer.imageryLayers.length);
console.log("Layer[0] provider:", viewer.imageryLayers.get(0).imageryProvider);

// Настройки времени (симуляция ускорена)
const clock = viewer.clock;
const start = Cesium.JulianDate.now();
clock.startTime = start.clone();
clock.currentTime = start.clone();
clock.clockRange = Cesium.ClockRange.UNBOUNDED;
clock.multiplier = 1; // ×50 ускорение
clock.shouldAnimate = true;


// --- 2. Константы и полезные функции ---
const EARTH_RADIUS = 6371e3; // м
const DEG2RAD = Math.PI / 180;
const MU = 3.986004418e14; // гравитационный параметр Земли
const T_SIDEREAL = 86164; // сидерический день, сек
const OMEGA_E = (2 * Math.PI) / T_SIDEREAL; // угловая скорость вращения Земли, рад/с

// --- Полярная "дырка" вокруг полюсов (8°) ---
// Запрещаем орбиты, которые заходят в области |lat| > (90 - POLAR_CAP_DEG).
// Для 8° это |lat| > 82°.
const POLAR_CAP_DEG = 8;
const POLAR_LAT_LIMIT_DEG = 90 - POLAR_CAP_DEG; // 82°

function orbitReachesForbiddenPolarZone(inclinationDeg, latLimitDeg) {
  // maxLat = min(i, 180-i) — максимальная широта трассы (по абсолютной широте)
  const maxLat = Math.min(inclinationDeg, 180 - inclinationDeg);
  return maxLat > latLimitDeg;
}

// Хранилище орбит и КА
let orbitStore = [];
let orbitIdCounter = 0;

// DOM узел для списка орбит
const orbitListEl = document.getElementById("orbit-list");

// Выбор спутников для измерения расстояния
let selectedSatA = null;
let selectedSatB = null;
let currentLinkEntity = null;
let lastLinkInfoUpdateSeconds = 0; // троттлинг обновления панели линка

// DOM-узлы панели линка
const linkInfoBody = document.getElementById("link-info-body");
const linkResetBtn = document.getElementById("link-reset-btn");

// --- Проверка прямой видимости (LoS) между двумя КА ---
// Возвращает true, если отрезок между posA и posB НЕ пересекает сферу Земли.
function hasLineOfSight(posA, posB) {
  const R = EARTH_RADIUS;

  // Вектор от A к B
  const d = Cesium.Cartesian3.subtract(posB, posA, new Cesium.Cartesian3());
  const dLen2 = Cesium.Cartesian3.dot(d, d);
  if (dLen2 === 0) {
    // Одна и та же точка — видимость тривиально есть
    return true;
  }

  // Проекция центра (0,0,0) на линию posA + t*d
  const t = -Cesium.Cartesian3.dot(posA, d) / dLen2;

  // Ограничиваем t отрезком [0,1]
  const tClamped = Math.min(1, Math.max(0, t));

  const closestPoint = Cesium.Cartesian3.add(
    posA,
    Cesium.Cartesian3.multiplyByScalar(d, tClamped, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  // Расстояние от центра Земли до ближайшей точки на отрезке
  const distToCenter = Cesium.Cartesian3.magnitude(closestPoint);

  // Если ближайшая точка находится ниже радиуса Земли — Земля пересекает луч
  return distToCenter >= R;
}

// --- Динамическая линия между выбранными КА ---
// Создаём полилинию с CallbackProperty, которая "крепится" к спутникам.
function updateLinkBetweenSelected() {
  if (!selectedSatA || !selectedSatB) return;

  // Удаляем старую линию, если есть
  if (currentLinkEntity) {
    viewer.entities.remove(currentLinkEntity);
    currentLinkEntity = null;
  }

  // Создаём динамическую полилинию, "привязанную" к КА
  currentLinkEntity = viewer.entities.add({
    name: "Link A-B",
    polyline: {
      positions: new Cesium.CallbackProperty(function (time, result) {
        // Если выбор сброшен — пустой массив, линия не рисуется
        if (!selectedSatA || !selectedSatB) {
          if (result) {
            result.length = 0;
            return result;
          }
          return [];
        }

        const posA = selectedSatA.position.getValue(time);
        const posB = selectedSatB.position.getValue(time);

        if (!posA || !posB) {
          if (result) {
            result.length = 0;
            return result;
          }
          return [];
        }

        // Проверяем наличие прямой видимости
        const los = hasLineOfSight(posA, posB);

        // Если нет LoS — линию не рисуем
        if (!los) {
          if (result) {
            result.length = 0;
            return result;
          }
          return [];
        }

        if (!result) {
          result = [];
        }
        result.length = 0;
        result.push(posA, posB);
        return result;
      }, false),

      width: 6.0,
      material: Cesium.Color.RED.withAlpha(1.0)
    }
  });
}

// --- Орбитальная динамика ---
function computeOrbitDynamics(altitudeMeters) {
  const a = EARTH_RADIUS + altitudeMeters; // большая полуось
  const period = 2 * Math.PI * Math.sqrt(Math.pow(a, 3) / MU); // сек
  const speed = Math.sqrt(MU / a); // м/с (круговая орбита)

  return { period, speed };
}

function createOrbit(options) {
  const altitudeMeters = options.altitudeKm * 1000;
  const { period, speed } = computeOrbitDynamics(altitudeMeters);

  const phaseStepDeg = options.phaseStepDeg || 0;
  const phaseStepRad = phaseStepDeg > 0 ? phaseStepDeg * DEG2RAD : null;

  // Случайный фазовый сдвиг орбиты [0, 2π), чтобы орбиты не были "стройной колонной"
  const phaseOffsetRad = Math.random() * 2 * Math.PI;

  // Межвитковый сдвиг трассы (к западу) за один период
  const interOrbitShiftDeg = 360 * (period / T_SIDEREAL);
  const interOrbitShiftKmEquator =
    (Math.abs(interOrbitShiftDeg) * Math.PI / 180) * (EARTH_RADIUS / 1000);

  return {
    name: options.name,
    altitude: altitudeMeters,
    inclination: options.inclinationDeg * DEG2RAD,
    period: period, // сек
    orbitalSpeed: speed, // м/с
    numSatellites: options.numSatellites || 1,
    evenSpacing: options.evenSpacing, // true/false
    phaseStepDeg: phaseStepDeg, // ° (для информации)
    phaseStepRad: phaseStepRad, // рад (для вычислений)
    phaseOffsetRad: phaseOffsetRad, // случайный сдвиг орбиты
    interOrbitShiftDeg: interOrbitShiftDeg, // межвитковый сдвиг, ° (к западу)
    interOrbitShiftKmEquator: interOrbitShiftKmEquator // сдвиг начала витка по экватору, км
  };
}

// --- Геометрия положения на орбите (инерциальная система) ---
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

// Возвращаем entity орбиты (полилинию), которая сдвигается вместе с КА
function createOrbitPolyline(orbit, color) {
  const segments = 256;

  const positionsCallback = new Cesium.CallbackProperty(function (time, result) {
    const seconds = Cesium.JulianDate.secondsDifference(time, start);

    // Тот же поворот, что и для спутников (учёт вращения Земли)
    const earthRot = OMEGA_E * seconds;
    const cosE = Math.cos(-earthRot);
    const sinE = Math.sin(-earthRot);

    if (!result) {
      result = [];
    }
    result.length = 0;

    for (let i = 0; i <= segments; i++) {
      const theta = (2 * Math.PI * i) / segments;

      // Положение точки орбиты в инерциальной системе
      const inertialPos = positionForTheta(theta, orbit);

      const xIn = inertialPos.x;
      const yIn = inertialPos.y;
      const zIn = inertialPos.z;

      // Поворачиваем в «земную» систему, как КА
      const x = xIn * cosE - yIn * sinE;
      const y = xIn * sinE + yIn * cosE;
      const z = zIn;

      result.push(new Cesium.Cartesian3(x, y, z));
    }

    return result;
  }, false);

  return viewer.entities.add({
    name: orbit.name + " path",
    polyline: {
      positions: positionsCallback,
      width: 1.5,
      material: color.withAlpha(0.7)
    }
  });
}

// --- Создание спутника на орбите ---
// ВАЖНО: здесь учитывается вращение Земли (OMEGA_E),
// чтобы ground track был с межвитковым сдвигом.
function createSatelliteOnOrbit(orbit, color, satIndex, totalSatellites) {
  const r = EARTH_RADIUS + orbit.altitude;

  // Выбор фазового шага между спутниками
  let deltaThetaRad;
  if (orbit.evenSpacing || !orbit.phaseStepRad || orbit.phaseStepRad <= 0) {
    // Равномерное распределение по кругу
    deltaThetaRad = totalSatellites > 0 ? (2 * Math.PI) / totalSatellites : 0;
  } else {
    // Пользовательский фазовый шаг в радианах
    deltaThetaRad = orbit.phaseStepRad;
  }

  // Базовый фазовый угол для данного спутника: случайный сдвиг орбиты + индекс КА
  const theta0 = (orbit.phaseOffsetRad || 0) + satIndex * deltaThetaRad;

  const positionProperty = new Cesium.CallbackProperty(function (time, result) {
    const seconds = Cesium.JulianDate.secondsDifference(time, start);

    // Орбитальный угол в инерциальной системе
    const baseTheta = (2 * Math.PI * (seconds % orbit.period)) / orbit.period;
    const theta = baseTheta + theta0;

    // Положение в инерциальной системе (ECI-подобная)
    const inertialPos = positionForTheta(theta, orbit);

    // Вращение Земли: поворот вокруг оси Z на -OMEGA_E * t
    const earthRot = OMEGA_E * seconds;
    const cosE = Math.cos(-earthRot);
    const sinE = Math.sin(-earthRot);

    const xIn = inertialPos.x;
    const yIn = inertialPos.y;
    const zIn = inertialPos.z;

    const x = xIn * cosE - yIn * sinE;
    const y = xIn * sinE + yIn * cosE;
    const z = zIn;

    if (!result) {
      result = new Cesium.Cartesian3();
    }
    return Cesium.Cartesian3.fromElements(x, y, z, result);
  }, false);

  const satIndexHuman = satIndex + 1;
  const altitudeKm = orbit.altitude / 1000;
  const inclinationDeg = (orbit.inclination * 180) / Math.PI;
  const periodMin = orbit.period / 60;
  const speedKms = orbit.orbitalSpeed / 1000;

  // Для информации: фазовый шаг + эквивалентная дуга по орбите
  const phaseDeg = (deltaThetaRad * 180) / Math.PI;
  const arcDistanceKm = (deltaThetaRad * r) / 1000;

  const descriptionHtml = `
    <div style="font-size:13px;">
      <h3 style="margin-top:0;">Космический аппарат №${satIndexHuman}</h3>
      <p><b>Орбита:</b> ${orbit.name}</p>
      <p><b>Высота орбиты:</b> ${altitudeKm.toFixed(0)} км</p>
      <p><b>Наклонение:</b> ${inclinationDeg.toFixed(1)}°</p>
      <p><b>Орбитальный период:</b> ${periodMin.toFixed(1)} мин</p>
      <p><b>Орбитальная скорость:</b> ${speedKms.toFixed(2)} км/с</p>
      <p><b>Фазовый шаг между соседними КА:</b> ${phaseDeg.toFixed(1)}°</p>
      <p><b>Эквивалентное расстояние по орбите:</b> ${arcDistanceKm.toFixed(0)} км</p>
      <p><i>Далее сюда можно добавить список радиососедей, SNR, RSSI и параметры канала.</i></p>
    </div>
  `;

  const satEntity = viewer.entities.add({
    name: `КА #${satIndexHuman}`, // заголовок в InfoBox
    position: positionProperty,
    point: {
      pixelSize: 8,
      color: color,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 1
    },
    description: new Cesium.ConstantProperty(descriptionHtml),
    properties: {
      isSatellite: true,
      orbitName: orbit.name,
      satelliteIndex: satIndexHuman,
      altitudeKm: altitudeKm,
      inclinationDeg: inclinationDeg,
      periodMin: periodMin,
      speedKms: speedKms,
      phaseDeg: phaseDeg,
      arcDistanceKm: arcDistanceKm
    }
  });

  return satEntity;
}


// --- Генерация уникальных цветов для орбит (HSL + золотое сечение) ---
function getColorByIndex(index) {
  // Золотое сечение для равномерного распределения оттенков
  const goldenRatio = 0.618033988749895;

  // Hue ∈ [0, 1)
  const hue = (index * goldenRatio) % 1.0;

  // Фиксируем насыщенность и яркость для читаемости
  const saturation = 0.75; // 75%
  const lightness = 0.5 + 0.1 * ((index % 3) - 1); // 0.4 / 0.5 / 0.6


  return Cesium.Color.fromHsl(hue, saturation, lightness, 1.0);
}

function cesiumColorToCss(color) {
  const r = Math.round(color.red * 255);
  const g = Math.round(color.green * 255);
  const b = Math.round(color.blue * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

// --- Добавление орбиты с КА ---
function addOrbitWithSatellites(orbitOptions, color) {
  const orbit = createOrbit(orbitOptions);

  const polylineEntity = createOrbitPolyline(orbit, color);

  const total = orbit.numSatellites;
  const satellites = [];
  for (let i = 0; i < total; i++) {
    const satEntity = createSatelliteOnOrbit(orbit, color, i, total);
    satellites.push(satEntity);
  }

  const group = {
    id: orbitIdCounter++,
    name: orbit.name,
    color, // Cesium.Color
    cssColor: cesiumColorToCss(color),
    orbit,
    polylineEntity,
    satellites
  };

  orbitStore.push(group);
  renderOrbitList();
}

function deleteAllOrbits() {
  // Удаляем группы с конца, чтобы не путаться с индексами
  for (let i = orbitStore.length - 1; i >= 0; i--) {
    const group = orbitStore[i];

    // удаляем полилинию орбиты
    if (group.polylineEntity) {
      viewer.entities.remove(group.polylineEntity);
    }

    // удаляем все спутники
    if (Array.isArray(group.satellites)) {
      group.satellites.forEach((sat) => viewer.entities.remove(sat));
    }
  }

orbitStore.length = 0;   // важно: НЕ теряем ссылку на массив
renderOrbitList();

  // сбрасываем выбор линка (чтобы не держались ссылки на удалённые Entity)
  selectedSatA = null;
  selectedSatB = null;
  lastLinkInfoUpdateSeconds = 0;

  if (currentLinkEntity) {
    viewer.entities.remove(currentLinkEntity);
    currentLinkEntity = null;
  }

  if (linkInfoBody) {
    linkInfoBody.innerHTML = "Выберите два КА, по очереди.";
  }

  viewer.selectedEntity = undefined;
  // сообщаем радиосети, что топология изменилась
window.dispatchEvent(new CustomEvent("spaceMesh:topologyChanged"));
if (window.spaceMesh?.radio?.onTopologyChanged) {
  window.spaceMesh.radio.onTopologyChanged();
}

}

// --- 3. Удаление орбит и КА ---
function deleteOrbit(orbitId) {
  const idx = orbitStore.findIndex((o) => o.id === orbitId);
  if (idx === -1) return;

  const group = orbitStore[idx];

  if (group.polylineEntity) {
    viewer.entities.remove(group.polylineEntity);
  }

  group.satellites.forEach((sat) => {
    viewer.entities.remove(sat);
  });

  orbitStore.splice(idx, 1);
  renderOrbitList();
  window.dispatchEvent(new CustomEvent("spaceMesh:topologyChanged"));
if (window.spaceMesh?.radio?.onTopologyChanged) {
  window.spaceMesh.radio.onTopologyChanged();
}

}

function deleteOneSatelliteFromOrbit(orbitId) {
  const group = orbitStore.find((o) => o.id === orbitId);
  if (!group) return;
  if (group.satellites.length === 0) return;

  const satEntity = group.satellites.pop();
  viewer.entities.remove(satEntity);
  renderOrbitList();
  window.dispatchEvent(new CustomEvent("spaceMesh:topologyChanged"));

}

function addOneSatelliteToOrbit(orbitId) {
  const group = orbitStore.find((o) => o.id === orbitId);
  if (!group) return;

  const orbit = group.orbit;
  const color = group.color;
  const totalNow = group.satellites.length;
  const newSatIndex = totalNow;

  const satEntity = createSatelliteOnOrbit(orbit, color, newSatIndex, totalNow + 1);
  group.satellites.push(satEntity);

  renderOrbitList();
  window.dispatchEvent(new CustomEvent("spaceMesh:topologyChanged"));
if (window.spaceMesh?.radio?.onTopologyChanged) {
  window.spaceMesh.radio.onTopologyChanged();
}

}

// --- Перерисовка списка орбит ---
function renderOrbitList() {
  if (!orbitListEl) return;

  orbitListEl.innerHTML = "";

  orbitStore.forEach((group) => {
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
    if (group.cssColor) {
      colorDot.style.backgroundColor = group.cssColor;
    }

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

    // --- Параметры орбиты ---
    const paramsDiv = document.createElement("div");
    paramsDiv.className = "orbit-params";

    const altKm = (group.orbit.altitude / 1000).toFixed(0);
    const inclDeg = (group.orbit.inclination * 180) / Math.PI;
    const periodMin = (group.orbit.period / 60).toFixed(1);

    const totalSats =
      group.satellites.length > 0 ? group.satellites.length : group.orbit.numSatellites;

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

    // --- Кнопки действий ---
    const actions = document.createElement("div");
    actions.className = "orbit-actions";

    const btnDeleteOrbit = document.createElement("button");
    btnDeleteOrbit.className = "btn-delete-orbit";
    btnDeleteOrbit.textContent = "Удалить орбиту";
    btnDeleteOrbit.onclick = () => deleteOrbit(group.id);

    const btnDeleteSat = document.createElement("button");
    btnDeleteSat.className = "btn-delete-sat";
    btnDeleteSat.textContent = "Удалить один КА";
    btnDeleteSat.onclick = () => deleteOneSatelliteFromOrbit(group.id);

    const btnAddSat = document.createElement("button");
    btnAddSat.className = "btn-add-sat";
    btnAddSat.textContent = "Добавить один КА";
    btnAddSat.onclick = () => addOneSatelliteToOrbit(group.id);

    actions.appendChild(btnDeleteOrbit);
    actions.appendChild(btnDeleteSat);
    actions.appendChild(btnAddSat);

    li.appendChild(header);
    li.appendChild(paramsDiv);
    li.appendChild(actions);

    orbitListEl.appendChild(li);
  });
}

// Обработка выбора спутников пользователем
function handleSatelliteSelection(entity) {
  // Первая точка (A) или повторный выбор A
  if (!selectedSatA || selectedSatA === entity) {
    selectedSatA = entity;
    selectedSatB = null;

    if (currentLinkEntity) {
      viewer.entities.remove(currentLinkEntity);
      currentLinkEntity = null;
    }

    lastLinkInfoUpdateSeconds = 0;

    if (linkInfoBody) {
      const nameA = entity.name || "КА A";
      const orbitNameA = entity.properties?.orbitName?.getValue
        ? entity.properties.orbitName.getValue()
        : entity.properties?.orbitName || "";

      linkInfoBody.innerHTML = `
        <div><b>КА A:</b> ${nameA} (${orbitNameA})</div>
        <div style="margin-top:4px;">Теперь выберите второй КА на глобусе.</div>
      `;
    }

    return;
  }

  // Вторая точка (B), отличная от A
  if (!selectedSatB && entity !== selectedSatA) {
    selectedSatB = entity;
    lastLinkInfoUpdateSeconds = 0;
    updateLinkBetweenSelected();
    return;
  }

  // Если уже есть A и B — начинаем новую пару с новой A
  selectedSatA = entity;
  selectedSatB = null;

  if (currentLinkEntity) {
    viewer.entities.remove(currentLinkEntity);
    currentLinkEntity = null;
  }

  lastLinkInfoUpdateSeconds = 0;

  if (linkInfoBody) {
    const nameA = entity.name || "КА A";
    const orbitNameA = entity.properties?.orbitName?.getValue
      ? entity.properties.orbitName.getValue()
      : entity.properties?.orbitName || "";

    linkInfoBody.innerHTML = `
      <div><b>КА A:</b> ${nameA} (${orbitNameA})</div>
      <div style="margin-top:4px;">Теперь выберите второй КА на глобусе.</div>
    `;
  }
}

// Подписываемся на выбор entity в Cesium
viewer.selectedEntityChanged.addEventListener(function (entity) {
  if (!entity) return;

  const props = entity.properties;
  if (!props) return;

  let isSat = false;
  try {
    if (typeof props.isSatellite === "boolean") {
      isSat = props.isSatellite;
    } else if (props.isSatellite && typeof props.isSatellite.getValue === "function") {
      isSat = !!props.isSatellite.getValue(clock.currentTime);
    }
  } catch (e) {
    isSat = false;
  }

  if (!isSat) return;

  handleSatelliteSelection(entity);
});

// --- Динамическое обновление панели "Линк между КА" ---
clock.onTick.addEventListener(function (clock) {
  if (!selectedSatA || !selectedSatB || !linkInfoBody) return;

  const time = clock.currentTime;
  const seconds = Cesium.JulianDate.secondsDifference(time, start);

  // Обновляем не чаще, чем раз в 0.5 секунды
  if (seconds - lastLinkInfoUpdateSeconds < 0.5) return;
  lastLinkInfoUpdateSeconds = seconds;

  const posA = selectedSatA.position.getValue(time);
  const posB = selectedSatB.position.getValue(time);
  if (!posA || !posB) return;

  const distanceMeters = Cesium.Cartesian3.distance(posA, posB);
  const distanceKm = distanceMeters / 1000.0;
  const los = hasLineOfSight(posA, posB);

  const nameA = selectedSatA.name || "КА A";
  const nameB = selectedSatB.name || "КА B";

  const orbitNameA = selectedSatA.properties?.orbitName?.getValue
    ? selectedSatA.properties.orbitName.getValue()
    : selectedSatA.properties?.orbitName || "";
  const orbitNameB = selectedSatB.properties?.orbitName?.getValue
    ? selectedSatB.properties.orbitName.getValue()
    : selectedSatB.properties?.orbitName || "";

  if (los) {
    linkInfoBody.innerHTML = `
      <div><b>КА A:</b> ${nameA} (${orbitNameA})</div>
      <div><b>КА B:</b> ${nameB} (${orbitNameB})</div>
      <div style="margin-top:4px;"><b>Расстояние по прямой:</b> ${distanceKm.toFixed(2)} км</div>
      <div style="margin-top:4px;"><b>Прямая видимость:</b> есть (Земля не экранирует канал)</div>
    `;
  } else {
    linkInfoBody.innerHTML = `
      <div><b>КА A:</b> ${nameA} (${orbitNameA})</div>
      <div><b>КА B:</b> ${nameB} (${orbitNameB})</div>
      <div style="margin-top:4px;"><b>Расстояние по прямой (геометрическое):</b> ${distanceKm.toFixed(2)} км</div>
      <div style="margin-top:4px; color:#ff6666;"><b>Прямая видимость:</b> нет</div>
      <div style="font-size:11px; opacity:0.9; margin-top:4px; color:#ffaaaa;">
        В текущий момент луч между КА проходит через Землю — прямой радиоканал невозможен.
      </div>
    `;
  }
});

// --- 5. Обработчик формы добавления орбит (одиночная орбита) ---
const orbitForm = document.getElementById("orbit-form");
let userOrbitIndex = 0;

if (orbitForm) {
  orbitForm.addEventListener("submit", function (e) {
    e.preventDefault();

    const form = e.currentTarget;

    const nameInput = form.querySelector("#orbit-name");
    const altitudeInput = form.querySelector("#orbit-altitude");
    const inclinationInput = form.querySelector("#orbit-inclination");
    const numSatsInput = form.querySelector("#orbit-num-sats");
    const evenSpacingInput = form.querySelector("#orbit-even-spacing");
    const phaseStepInput = form.querySelector("#orbit-phase-step");

    if (
      !nameInput ||
      !altitudeInput ||
      !inclinationInput ||
      !numSatsInput ||
      !evenSpacingInput ||
      !phaseStepInput
    ) {
      console.error("Не найдены элементы формы орбиты. Проверь id полей в index.html");
      return;
    }

    const name = nameInput.value || "LEO-custom";
    const altitudeRaw = parseFloat(altitudeInput.value);
    const inclinationRaw = parseFloat(inclinationInput.value);
    const numSatsRaw = parseInt(numSatsInput.value, 10);

    // ВАЖНО: 0 — валидное значение, не используем `||` для чисел
    const altitudeKm = Number.isFinite(altitudeRaw) ? altitudeRaw : 500;
    const inclinationDeg = Number.isFinite(inclinationRaw) ? inclinationRaw : 53;
    const numSatellites = Number.isInteger(numSatsRaw) ? numSatsRaw : 1;

    const evenSpacing = evenSpacingInput.checked;

    const phaseStepRaw = parseFloat(phaseStepInput.value);
    const phaseStepDeg = Number.isFinite(phaseStepRaw) ? phaseStepRaw : 0;

    const cfg = {
      name,
      altitudeKm,
      inclinationDeg,
      numSatellites,
      evenSpacing,
      phaseStepDeg
    };

    const color = getColorByIndex(userOrbitIndex++);
    addOrbitWithSatellites(cfg, color);
  });
} else {
  console.error("Форма с id='orbit-form' не найдена в DOM");
}

// --- 5b. Обработчик формы массового создания орбит ---
const bulkForm = document.getElementById("bulk-orbits-form");

if (bulkForm) {
  bulkForm.addEventListener("submit", function (e) {
    e.preventDefault();

    const altInput = document.getElementById("bulk-altitude");
    const numSatsInput = document.getElementById("bulk-num-sats");
    const evenSpacingInput = document.getElementById("bulk-even-spacing");
    const phaseStepInput = document.getElementById("bulk-phase-step");
    const numOrbitsInput = document.getElementById("bulk-num-orbits");
    const inclInfoEl = document.getElementById("bulk-incl-info");
    const skipPolarInput = document.getElementById("bulk-skip-polar");

    if (
      !altInput ||
      !numSatsInput ||
      !evenSpacingInput ||
      !phaseStepInput ||
      !numOrbitsInput ||
      !skipPolarInput
    ) {
      console.error("Не найдены элементы формы массовых орбит.");
      return;
    }

    const altitudeRaw = parseFloat(altInput.value);
    const numSatsRaw = parseInt(numSatsInput.value, 10);
    const numOrbitsRaw = parseInt(numOrbitsInput.value, 10);

    const altitudeKm = Number.isFinite(altitudeRaw) ? altitudeRaw : 550;
    const numSatellites = Number.isInteger(numSatsRaw) ? numSatsRaw : 8;

    const numOrbits =
      Number.isInteger(numOrbitsRaw) && numOrbitsRaw > 0 ? numOrbitsRaw : 1;

    const evenSpacing = evenSpacingInput.checked;

    const phaseStepRaw = parseFloat(phaseStepInput.value);
    const phaseStepDeg = Number.isFinite(phaseStepRaw) ? phaseStepRaw : 0;

    const skipPolar = skipPolarInput.checked;

// Диапазон наклонений: [0 .. 180), 180° ИСКЛЮЧАЕМ
// Требование: создать РОВНО numOrbits орбит.
// Если включён skipPolar — распределяем наклонения равномерно по ДОПУСТИМЫМ зонам,
// "перепрыгивая" запрещённую полосу вокруг 90°.

const gapWidthDeg = 2 * POLAR_CAP_DEG;            // напр. 16° при POLAR_CAP_DEG=8
const lowMaxDeg = POLAR_LAT_LIMIT_DEG;            // напр. 82°
const highMinDeg = 180 - POLAR_LAT_LIMIT_DEG;     // напр. 98°
const allowedSpanDeg = 180 - (skipPolar ? gapWidthDeg : 0); // 180 или 164

if (inclInfoEl) {
  if (!skipPolar) {
    const inclStep = 180 / numOrbits;
    inclInfoEl.textContent = `Шаг между орбитами: ${inclStep.toFixed(
      2
    )}° (равномерно от 0 до 180°, 180° исключена)`;
  } else {
    const effStep = allowedSpanDeg / numOrbits;
    inclInfoEl.textContent =
      `Исключение околополярных включено: запрещённая зона ~(${lowMaxDeg.toFixed(1)}°..${highMinDeg.toFixed(1)}°). ` +
      `Наклонения распределяются равномерно по допустимым зонам. ` +
      `Эффективный шаг по допустимому диапазону: ${effStep.toFixed(2)}° (создастся ровно ${numOrbits} орбит)`;
  }
}

for (let k = 0; k < numOrbits; k++) {
  let incl;

  if (!skipPolar) {
    // Старое поведение: равномерно по [0..180)
    incl = (k * 180) / numOrbits;
  } else {
    // Новое поведение: равномерно по допустимому диапазону, с "перепрыгиванием" gap
    // Берём параметр t в [0..1) и раскладываем его по длине allowedSpanDeg (= 164° при cap=8°).
    const t = k / numOrbits;                 // 0 .. (1 - 1/N)
    const s = t * allowedSpanDeg;            // 0 .. <allowedSpanDeg

    // s в [0..82] -> incl = s
    // s в (82..164) -> incl = s + gapWidth (перепрыгиваем 82..98)
    incl = (s <= lowMaxDeg) ? s : (s + gapWidthDeg);

    // На всякий случай, если из-за чисел попадём в запрещённую — чуть сдвигаем
    if (orbitReachesForbiddenPolarZone(incl, POLAR_LAT_LIMIT_DEG)) {
      incl = highMinDeg; // прижимаем к краю разрешённой зоны
    }

    // Защитим от 180° (всё равно исключаем верхнюю границу)
    if (incl >= 180) incl = 180 - 1e-6;
  }

  const inclRounded = Math.round(incl * 1000) / 1000;

  const cfg = {
    name: `Shell i=${inclRounded.toFixed(1)}°`,
    altitudeKm,
    inclinationDeg: inclRounded,
    numSatellites,
    evenSpacing,
    phaseStepDeg
  };

  const color = getColorByIndex(userOrbitIndex++);
  addOrbitWithSatellites(cfg, color);
}

  });
}

// Обработчик кнопки "Сбросить выбор"
if (linkResetBtn) {
  linkResetBtn.addEventListener("click", function () {
    selectedSatA = null;
    selectedSatB = null;
    lastLinkInfoUpdateSeconds = 0;

    if (currentLinkEntity) {
      viewer.entities.remove(currentLinkEntity);
      currentLinkEntity = null;
    }

    if (linkInfoBody) {
      linkInfoBody.innerHTML = "Выберите два КА на глобусе, по очереди.";
    }

    // снимаем выделение в Cesium
    viewer.selectedEntity = undefined;
  });
}

// --- 6. Стартовый вид камеры ---
viewer.scene.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(0, 20, 20000000.0)
});

// --- 7. Экспорт базовых объектов в глобальный namespace для других модулей ---
// ВАЖНО: не перетираем window.spaceMesh целиком, чтобы не ломать утилиты/расширения (geo_utils.js, radio.js и т.д.)
window.spaceMesh = window.spaceMesh || {};
Object.assign(window.spaceMesh, {
  viewer,
  clock,
  orbitStore,
  EARTH_RADIUS,
  start
});

// --- 7a. ДИНАМИЧЕСКАЯ геопозиция КА в InfoBox (lat/lon/alt WGS-84) ---
// Важно:
// 1) сохраняем базовое описание один раз (без regex),
// 2) description становится CallbackProperty и обновляется каждый tick,
// 3) не ломаем исходные поля и не "съедаем" HTML.

(function attachDynamicGeoToSelectedEntity(viewer) {
  if (!viewer || !viewer.selectedEntityChanged) return;

  function computeGeo(pos) {
    // Используем общую утилиту, если подключена (geo_utils.js)
    if (window.spaceMesh && typeof window.spaceMesh.ecefToGeo === "function") {
      return window.spaceMesh.ecefToGeo(pos);
    }
    // fallback
    const c = Cesium.Cartographic.fromCartesian(pos);
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
      h_m: c.height
    };
  }

  viewer.selectedEntityChanged.addEventListener(function (entity) {
    if (!entity || !entity.position) return;

    // 1) Забираем текущее описание как базовое ОДИН раз.
    //    Важно: если это уже наш CallbackProperty — не перезатираем базу.
    if (!entity._spaceMeshBaseDescriptionHtml) {
      const t = viewer.clock.currentTime;

      let base = "";
      try {
        // Если description — Property (ConstantProperty и т.п.)
        if (entity.description && typeof entity.description.getValue === "function") {
          base = entity.description.getValue(t) || "";
        } else if (typeof entity.description === "string") {
          base = entity.description;
        }
      } catch (e) {
        base = "";
      }

      // На случай если там уже был наш старый блок — просто сохраняем как есть.
      entity._spaceMeshBaseDescriptionHtml = base;
    }

    // 2) Делаем динамическое description
    entity.description = new Cesium.CallbackProperty(function (time) {
      const pos = entity.position.getValue(time);
      if (!pos) return entity._spaceMeshBaseDescriptionHtml || "<i>Нет данных о позиции</i>";

      const geo = computeGeo(pos);

      const lat = (geo.lat ?? 0).toFixed(4);
      const lon = (geo.lon ?? 0).toFixed(4);
      const altKm = ((geo.h_m ?? 0) / 1000).toFixed(2);

      const extra =
        `<hr/>` +
        `<div style="font-size:12px;">` +
        `<b>Геопозиция (WGS-84):</b><br/>` +
        `Широта: <b>${lat}°</b><br/>` +
        `Долгота: <b>${lon}°</b><br/>` +
        `Высота: <b>${altKm} км</b>` +
        `</div>`;

      return (entity._spaceMeshBaseDescriptionHtml || "") + extra;
    }, false);
  });
})(viewer);


const bulkDeleteAllBtn = document.getElementById("bulk-delete-all");
if (bulkDeleteAllBtn) {
  bulkDeleteAllBtn.addEventListener("click", deleteAllOrbits);
}

// --- 8. Кнопка скрыть/показать панель "Орбиты и КА" ---
const orbitPanel = document.getElementById("orbit-panel");
const orbitToggle = document.getElementById("orbit-toggle");

if (orbitPanel && orbitToggle) {
  orbitToggle.addEventListener("click", () => {
    const hidden = orbitPanel.classList.toggle("hidden");
    orbitToggle.textContent = hidden ? "▼ Орбиты и КА" : "▲ Орбиты и КА";
  });
}
