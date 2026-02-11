// static/js/radio.js

(function () {
  if (typeof Cesium === "undefined") {
    console.warn("radio.js: Cesium не найден, радиомоделирование отключено.");
    return;
  }

  // --- 1. Достаём viewer / clock / orbitStore из глобала или window.spaceMesh ---
  let viewer = null;
  let clock = null;
  let orbitStoreRef = null;
  let EARTH_RADIUS = null;
  let startTime = null;

  if (window.spaceMesh) {
    viewer = window.spaceMesh.viewer;
    clock = window.spaceMesh.clock;
    orbitStoreRef = window.spaceMesh.orbitStore;
    EARTH_RADIUS = window.spaceMesh.EARTH_RADIUS;
    startTime = window.spaceMesh.start;
  } else if (
    typeof viewer !== "undefined" &&
    typeof orbitStore !== "undefined" &&
    typeof EARTH_RADIUS !== "undefined" &&
    typeof start !== "undefined"
  ) {
    viewer = window.viewer;
    clock = viewer.clock;
    orbitStoreRef = window.orbitStore;
    EARTH_RADIUS = window.EARTH_RADIUS;
    startTime = window.start;
  }

  if (!viewer || !clock || !orbitStoreRef || !EARTH_RADIUS || !startTime) {
    console.warn("radio.js: нет доступа к viewer/clock/orbitStore/EARTH_RADIUS/start.");
    return;
  }

  // --- 2. Состояние радиосети и конфиг канала ---
  const radioState = {
    enabled: false,
    drawLinks: true,
    lastUpdateSeconds: 0,
    updatePeriodSec: 1.0,

    lastAvgLinkDistKm: 0,

    config: {
      // Базовый линк-бюджет
      freqMHz: 2200,
      txPowerDbm: 30,
      gainTxDb: 10,
      gainRxDb: 10,
      rxSensDbm: -100,
      noiseFloorDbm: -110, // fallback
      minSnrDb: 5,
      maxRangeKm: 0, // 0 = без ограничения

      // 1.1. Модуляция и кодирование (MCS)
      modulation: "QPSK",
      codingRate: 2 / 3,
      dataRateMbps: 50,
      bandwidthMHz: 20,

      // 1.2. Антенны / направленность и потери
      antennaType: "directional", // directional|sector|phased|omni|custom

      beamWidthDeg: 20,
      pointingLossDb: 1.0,
      polLossDb: 0.5,

      // Параметры ФАР
      phasedMaxScanDeg: 45,
      phasedScanLossDb: 1.5,

      // Параметры всенаправленной антенны
      omniGainDb: 2.0,

      // Параметры кастомной диаграммы
      customGainDb: 12.0,
      customBeamwidthDeg: 25,
      customSidelobeLossDb: 10.0,
      customAngleLossDbPerDeg: 0.4,

      // Потери тракта
      txFeederLossDb: 1.0,
      rxFeederLossDb: 1.0,
      implLossDb: 1.0,

      // 1.4. Параметры шума / приёмника
      sysTempK: 500,
      noiseBandwidthMHz: 20,

      // 1.5. Mesh-специфика
    maxNeighborsPerSat: 0, // 0 = без ограничения
    limitOrbitHop: false,
      routingMetric: "snr",

      // 1.6. Энергетика КА
      txElecPowerW: 60,
      dutyCycle: 0.2,
      refDistanceKm: 1000,

      // --- NEW: unified mesh behavior ---
      allowMisToMis: false,  //  MIS не может связываться с MIS (как полноценный mesh-участник)
      stickyBonus: 750,      // бонус к score для ребра, которое было активно на прошлом тике (уменьшает "флаппинг")
      misMaxLinks: 3 // каждого MIS вводим лимит: макс. 3 активных линка, выбираем самые оптимальные (по score = SNR*1000 − dist + sticky).
    },

    linksByKey: new Map(),

    // key -> { key,aId,bId,distanceKm,rxPowerDbm,snrDb,noiseFloorDbm,capacityMbps,isMisEdge,score }
    activeEdgesByKey: new Map(),
    prevActiveEdgesByKey: new Map()
  };

  // --- expose minimal public API for other modules ---
  window.spaceMesh = window.spaceMesh || {};
  window.spaceMesh.radio = window.spaceMesh.radio || {};

  window.spaceMesh.radio.getConfig = () => radioState.config;

  window.spaceMesh.radio.computeBudgetForDistanceMeters = (distanceMeters) => {
    const cfg = radioState.config;

    const fsplDb = computeFsplDb(distanceMeters, cfg.freqMHz);
    const { effGainTxDb, effGainRxDb, extraLossDb } = getEffectiveAntennaGains(cfg);

    const totalTxGainDb = effGainTxDb - cfg.txFeederLossDb - cfg.pointingLossDb;
    const totalRxGainDb = effGainRxDb - cfg.rxFeederLossDb - cfg.pointingLossDb - cfg.polLossDb;

    const noiseFloorDbm = computeNoiseFloorFromTemp(cfg);

    const rxPowerDbm =
      cfg.txPowerDbm +
      totalTxGainDb +
      totalRxGainDb -
      fsplDb -
      cfg.implLossDb -
      extraLossDb;

    const snrDb = rxPowerDbm - noiseFloorDbm;

    return { fsplDb, rxPowerDbm, snrDb, noiseFloorDbm };
  };

  window.spaceMesh.radio.computeCapacityMbps = (snrDb) => {
    return computeCapacityMbps(radioState.config, snrDb);
  };

  window.spaceMesh.radio.getActiveEdgesSnapshot = () => {
    return Array.from(radioState.activeEdgesByKey.values());
  };

  window.spaceMesh.radio.onTopologyChanged = onTopologyChanged;

  // --- 3. Вспомогательные функции по спутникам ---

  function isMissionSat(ent, time) {
    const v =
      ent?.properties?.isMissionSatellite?.getValue?.(time) ??
      ent?.properties?.isMissionSatellite;
    return v === true;
  }

  function participatesInMesh(ent, time) {
    const v =
      ent?.properties?.participatesInMesh?.getValue?.(time) ??
      ent?.properties?.participatesInMesh;
    return v === undefined ? true : (v === true);
  }

  function getMissionState(ent, time) {
    const st =
      ent?.properties?.state?.getValue?.(time) ??
      ent?.properties?.state?.getValue?.() ??
      ent?.properties?.state;
    return String(st || "IDLE").toUpperCase();
  }

  // Собрать все сущности спутников:
  // - КА связи: все из orbitStore
  // - MIS-КА: из missionStore, но только если state=IDLE и participatesInMesh=true
  function collectAllSatellites(time) {
    const sats = [];
    const satKindById = new Map(); // id -> "mesh" | "mis"

    // --- КА связи ---
    orbitStoreRef.forEach((group) => {
      if (!group || !Array.isArray(group.satellites)) return;

      for (const sat of group.satellites) {
        if (!sat) continue;

        const ent =
          sat.position?.getValue ? sat :
          sat.entity?.position?.getValue ? sat.entity :
          null;

        if (!ent || !ent.position?.getValue) continue;

        sats.push(ent);
        satKindById.set(ent.id, "mesh");
      }
    });

    // --- MIS-КА ---
    const ms = window.spaceMesh?.missionStore;
    if (Array.isArray(ms)) {
      ms.forEach((group) => {
        if (!group || !Array.isArray(group.satellites)) return;

        for (const sat of group.satellites) {
          const ent = sat.entity || sat;
          if (!ent || !ent.position?.getValue) continue;

          // участвует ли в сети
          if (!participatesInMesh(ent, time)) continue;

          // занятые MIS не участвуют в mesh (как у тебя было)
          const state = getMissionState(ent, time);
          if (state !== "IDLE") continue;

          sats.push(ent);
          satKindById.set(ent.id, "mis");
        }
      });
    }

    return { sats, satKindById };
  }

  function getOrbitId(ent, time) {
    try {
      const v =
        ent?.properties?.orbitId?.getValue?.(time) ??
        ent?.properties?.orbitId;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  function computeAverageOrbitPeriodSec() {
    let sum = 0;
    let count = 0;

    orbitStoreRef.forEach((group) => {
      if (group && group.orbit && typeof group.orbit.period === "number") {
        sum += group.orbit.period;
        count++;
      }
    });

    if (count === 0) return 95 * 60;
    return sum / count;
  }

  // --- 4. Радиофизика: FSPL и LoS ---

  function computeFsplDb(distanceMeters, freqMHz) {
    const dKm = distanceMeters / 1000.0;
    if (dKm <= 0) return 0;
    return 32.44 + 20 * Math.log10(dKm) + 20 * Math.log10(freqMHz);
  }

  function hasLineOfSightRadio(posA, posB) {
    const R = EARTH_RADIUS;

    const d = Cesium.Cartesian3.subtract(posB, posA, new Cesium.Cartesian3());
    const dLen2 = Cesium.Cartesian3.dot(d, d);
    if (dLen2 === 0) return true;

    const t = -Cesium.Cartesian3.dot(posA, d) / dLen2;
    const tClamped = Math.min(1, Math.max(0, t));

    const closestPoint = Cesium.Cartesian3.add(
      posA,
      Cesium.Cartesian3.multiplyByScalar(d, tClamped, new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );

    const distToCenter = Cesium.Cartesian3.magnitude(closestPoint);
    return distToCenter >= R;
  }

  function computeNoiseFloorFromTemp(cfg) {
    const T = cfg.sysTempK;
    const B_Hz = cfg.noiseBandwidthMHz * 1e6;
    if (T <= 0 || B_Hz <= 0) return cfg.noiseFloorDbm;

    const k = 1.38064852e-23;
    const N_watt = k * T * B_Hz;
    const N_dbm = 10 * Math.log10(N_watt / 1e-3);
    return N_dbm;
  }

  // --- 5. MCS: требуемый Eb/N0 ---

  function getRequiredEbNoDb(modulation, codingRate) {
    const r = codingRate || 0.5;
    const m = (modulation || "QPSK").toUpperCase();

    if (m === "BPSK") {
      if (r <= 0.5) return 3.0;
      if (r <= 0.66) return 4.0;
      return 5.0;
    }
    if (m === "QPSK") {
      if (r <= 0.5) return 4.5;
      if (r <= 0.66) return 6.0;
      return 7.5;
    }
    if (m === "8PSK") {
      if (r <= 0.5) return 7.0;
      if (r <= 0.66) return 8.5;
      return 10.0;
    }
    if (m === "16QAM") {
      if (r <= 0.5) return 9.0;
      if (r <= 0.66) return 11.0;
      return 13.0;
    }
    if (m === "64QAM") {
      if (r <= 0.5) return 12.0;
      if (r <= 0.66) return 14.0;
      return 16.0;
    }
    return 5.0;
  }

  // --- 6. Учёт типа антенны ---

  function getEffectiveAntennaGains(cfg) {
    let effGainTxDb = cfg.gainTxDb;
    let effGainRxDb = cfg.gainRxDb;
    let extraLossDb = 0.0;

    const type = cfg.antennaType || "directional";

    switch (type) {
      case "omni":
        effGainTxDb = cfg.omniGainDb;
        effGainRxDb = cfg.omniGainDb;
        break;

      case "phased":
        extraLossDb += cfg.phasedScanLossDb;
        break;

      case "custom":
        effGainTxDb = cfg.customGainDb;
        effGainRxDb = cfg.customGainDb;
        break;

      case "sector":
      case "directional":
      default:
        break;
    }

    return { effGainTxDb, effGainRxDb, extraLossDb };
  }

  // --- 7. Оценка линка между двумя КА ---

  function evaluateLink(posA, posB) {
    const cfg = radioState.config;

    const distanceMeters = Cesium.Cartesian3.distance(posA, posB);
    const distanceKm = distanceMeters / 1000.0;

    if (cfg.minLinkDistanceEnabled && cfg.minLinkDistanceKm > 0 && distanceKm < cfg.minLinkDistanceKm) {
      return { linkUp: false, distanceKm, tooClose: true };
    }

    if (cfg.maxRangeKm > 0 && distanceKm > cfg.maxRangeKm) {
      return { linkUp: false, distanceKm };
    }

    const los = hasLineOfSightRadio(posA, posB);
    if (!los) {
      return { linkUp: false, distanceKm, los: false };
    }

    const fsplDb = computeFsplDb(distanceMeters, cfg.freqMHz);

    const { effGainTxDb, effGainRxDb, extraLossDb } = getEffectiveAntennaGains(cfg);

    const totalTxGainDb =
      effGainTxDb - cfg.txFeederLossDb - cfg.pointingLossDb;
    const totalRxGainDb =
      effGainRxDb - cfg.rxFeederLossDb - cfg.pointingLossDb - cfg.polLossDb;

    const noiseFloorDbm = computeNoiseFloorFromTemp(cfg);

    const rxPowerDbm =
      cfg.txPowerDbm +
      totalTxGainDb +
      totalRxGainDb -
      fsplDb -
      cfg.implLossDb -
      extraLossDb;

    const snrDb = rxPowerDbm - noiseFloorDbm;

    const linkUp =
      rxPowerDbm >= cfg.rxSensDbm &&
      snrDb >= cfg.minSnrDb;

    return {
      linkUp,
      distanceKm,
      los: true,
      fsplDb,
      rxPowerDbm,
      snrDb,
      noiseFloorDbm
    };
  }

  // --- 8. Визуализация линков ---

  function clearRadioLinks() {
    for (const ent of radioState.linksByKey.values()) {
      viewer.entities.remove(ent);
    }
    radioState.linksByKey.clear();
  }

  function makeLinkMaterial(snrDb) {
    let color;

    if (!isFinite(snrDb)) {
      color = Cesium.Color.GRAY.withAlpha(0.6);
    } else if (snrDb >= 20) {
      color = Cesium.Color.LIME.withAlpha(0.9);
    } else if (snrDb >= 15) {
      color = Cesium.Color.CHARTREUSE.withAlpha(0.85);
    } else if (snrDb >= 10) {
      color = Cesium.Color.ORANGE.withAlpha(0.8);
    } else {
      color = Cesium.Color.RED.withAlpha(0.75);
    }

    return new Cesium.PolylineGlowMaterialProperty({
      glowPower: 0.25,
      taperPower: 0.3,
      color
    });
  }

  function onTopologyChanged() {
    clearRadioLinks();
    radioState.lastUpdateSeconds = 0;
    updateRadioMeshInfo("Топология изменилась — радиосеть сброшена, пересчёт на следующем тике.");
  }

  function createRadioLinkEntity(satA, satB, snrDb) {
    const material = makeLinkMaterial(snrDb);

    const positionsCallback = new Cesium.CallbackProperty(function (time) {
      const posA = satA.position.getValue(time);
      const posB = satB.position.getValue(time);
      if (!posA || !posB) return [];
      return [posA, posB];
    }, false);

    return viewer.entities.add({
      polyline: {
        positions: positionsCallback,
        width: 1.6,
        material,
        arcType: Cesium.ArcType.NONE // рисуем прямую хорду, без геодезической дуги
      }
    });
  }

  function updateRadioLinkVisual(entity, snrDb) {
    if (!entity || !entity.polyline) return;
    entity.polyline.material = makeLinkMaterial(snrDb);
  }

  function makeLinkKey(idA, idB) {
    return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
  }

  // --- 9. DOM: элементы правой панели ---

  const radioEnabledCheckbox     = document.getElementById("radio-enabled");
  const radioDrawLinksCheckbox   = document.getElementById("radio-draw-links");
  const radioLimitMinDistanceCheckbox = document.getElementById("radio-limit-min-distance");
  const radioMinDistanceRow = document.getElementById("radio-min-distance-row");
  const radioMinLinkDistanceInput = document.getElementById("radio-min-link-distance-km");
  const radioForm                = document.getElementById("radio-form");
  const radioMeshInfoEl          = document.getElementById("radio-mesh-info");
  const radioLinkSummaryEl       = document.getElementById("radio-link-summary");
  const radioEnergySummaryEl     = document.getElementById("radio-energy-summary");
  const radioLimitOrbitHopCheckbox = document.getElementById("radio-limit-orbit-hop");

  if (radioLimitMinDistanceCheckbox) {
    radioState.config.minLinkDistanceEnabled = !!radioLimitMinDistanceCheckbox.checked;
  }
  if (radioMinLinkDistanceInput) {
    const v = parseFloat(radioMinLinkDistanceInput.value);
    radioState.config.minLinkDistanceKm = isFinite(v) && v >= 0 ? v : (radioState.config.minLinkDistanceKm || 0);
  }

  // Антенна – блоки
  const antennaTypeSelect   = document.getElementById("radio-antenna-type");
  const phasedProfilesRow   = document.getElementById("phased-profiles-row");
  const phasedProfileSelect = document.getElementById("radio-phased-profile");
  const antennaCommonBlock  = document.getElementById("antenna-common-block");
  const antennaPhasedBlock  = document.getElementById("antenna-phased-block");
  const antennaOmniBlock    = document.getElementById("antenna-omni-block");
  const antennaCustomBlock  = document.getElementById("antenna-custom-block");

  const PHASED_PROFILE_TIPS = {
    A: "Баланс (лабораторный): до ~2000 км, скорость ~100 Мбит/с. Потребует уточнения под реальное изделие.",
    B: "Скорость (лабораторный): до ~1600 км, скорость ~180 Мбит/с. Потребует уточнения под реальное изделие.",
    C: "Надёжность: до ~1800 км, скорость ~35 Мбит/с. Резерв/устойчивость при разрежении."
  };

  function applyProfileTooltips() {
    if (!phasedProfileSelect) return;
    for (const opt of phasedProfileSelect.options || []) {
      const tip = PHASED_PROFILE_TIPS[opt.value];
      if (tip) opt.title = tip;
    }
  }

  function updateRadioMeshInfo(textHtml) {
    if (!radioMeshInfoEl) return;
    radioMeshInfoEl.innerHTML = textHtml;
  }

  function updateAntennaBlocksVisibility(type) {
    if (!type && antennaTypeSelect) type = antennaTypeSelect.value;
    if (!type) type = radioState.config.antennaType;

    const t = (type || "directional");

    if (antennaCommonBlock) {
      antennaCommonBlock.style.display =
        (t === "directional" || t === "sector" || t === "phased" || t === "custom")
          ? "block"
          : "none";
    }
    if (antennaPhasedBlock) {
      antennaPhasedBlock.style.display = (t === "phased") ? "block" : "none";
    }
    if (antennaOmniBlock) {
      antennaOmniBlock.style.display = (t === "omni") ? "block" : "none";
    }
    if (antennaCustomBlock) {
      antennaCustomBlock.style.display = (t === "custom") ? "block" : "none";
    }
    if (phasedProfilesRow) {
      phasedProfilesRow.style.display = (t === "phased") ? "block" : "none";
    }
  }

  // --- 10. Обработчики чекбоксов и формы ---

  if (radioEnabledCheckbox) {
    radioEnabledCheckbox.addEventListener("change", function () {
      radioState.enabled = !!radioEnabledCheckbox.checked;

      if (!radioState.enabled) {
        clearRadioLinks();
        updateRadioMeshInfo("Радиомоделирование выключено.");
      } else {
        updateRadioMeshInfo(`
          <b>Активных линков:</b> 0<br/>
          <b>КА в сети (mesh):</b> 0<br/>
          <b>КА в сети (задания/MIS):</b> 0<br/>
          <b>SNR, dB:</b> -<br/>
          <small>Ожидание расчёта mesh-сети.</small>
        `);
      }
    });
  }

  if (radioDrawLinksCheckbox) {
    radioDrawLinksCheckbox.checked = radioState.drawLinks;
    radioDrawLinksCheckbox.addEventListener("change", function () {
      radioState.drawLinks = !!radioDrawLinksCheckbox.checked;
      if (!radioState.drawLinks) clearRadioLinks();
    });
  }

  function syncMinDistanceUI() {
    if (!radioLimitMinDistanceCheckbox || !radioMinDistanceRow) return;
    const on = !!radioLimitMinDistanceCheckbox.checked;
    radioMinDistanceRow.style.display = on ? "block" : "none";
  }
  syncMinDistanceUI();

  if (radioLimitMinDistanceCheckbox) {
    radioLimitMinDistanceCheckbox.addEventListener("change", function () {
      const on = !!radioLimitMinDistanceCheckbox.checked;
      radioState.config.minLinkDistanceEnabled = on;
      syncMinDistanceUI();
      radioState.lastUpdateSeconds = 0;
    });
  }

  if (radioMinLinkDistanceInput) {
    const applyMinDist = () => {
      const v = parseFloat(radioMinLinkDistanceInput.value);
      radioState.config.minLinkDistanceKm = isFinite(v) && v >= 0 ? v : 0;
      radioState.lastUpdateSeconds = 0;
    };
    radioMinLinkDistanceInput.addEventListener("input", applyMinDist);
    radioMinLinkDistanceInput.addEventListener("change", applyMinDist);
    applyMinDist();
  }

  if (radioLimitOrbitHopCheckbox) {
    radioState.config.limitOrbitHop = !!radioLimitOrbitHopCheckbox.checked;
    radioLimitOrbitHopCheckbox.addEventListener("change", function () {
      radioState.config.limitOrbitHop = !!radioLimitOrbitHopCheckbox.checked;
      radioState.lastUpdateSeconds = 0;
    });
  }

  if (antennaTypeSelect) {
    antennaTypeSelect.addEventListener("change", function () {
      const cfg = radioState.config;
      cfg.antennaType = antennaTypeSelect.value || cfg.antennaType;
      updateAntennaBlocksVisibility(cfg.antennaType);
    });
    updateAntennaBlocksVisibility(antennaTypeSelect.value);
  } else {
    updateAntennaBlocksVisibility(radioState.config.antennaType);
  }
  applyProfileTooltips();

  // -------------------------------
  // Phased Array (ФАР) profiles (25 GHz)
  // -------------------------------

  const PHASED_PROFILES = {
    A: {
      // Баланс (лабораторный): дальность ~2000 км, скорость ~100 Мбит/с
      name: "A — Баланс (лабораторный, до ~2000 км)",
      freqMHz: 25000,
      txPowerDbm: 33,
      rxSensDbm: -96,
      minSnrDb: 6,
      maxRangeKm: 2000,
      noiseFloorDbm: -110,

      antennaType: "phased",
      gainTxDb: 34,
      gainRxDb: 34,
      beamWidthDeg: 4,
      pointingLossDb: 1.0,
      polLossDb: 0.3,
      phasedMaxScanDeg: 30,
      phasedScanLossDb: 1.8,

      txFeederLossDb: 1.0,
      rxFeederLossDb: 1.0,
      implLossDb: 1.0,

      modulation: "QPSK",
      codingRate: 0.5,
      dataRateMbps: 100,
      bandwidthMHz: 20,

      sysTempK: 650,
      noiseBandwidthMHz: 20,

      maxNeighborsPerSat: 4,
      routingMetric: "snr_distance",

      txElecPowerW: 90,
      dutyCycle: 0.2,
      refDistanceKm: 1700
    },

    B: {
      // Скорость (лабораторный): ближние/средние соседи ~1500–1600 км, высокая пропускная
      name: "B — Скорость (лабораторный, до ~1600 км)",
      freqMHz: 25000,
      txPowerDbm: 35,
      rxSensDbm: -92,
      minSnrDb: 7,
      maxRangeKm: 1600,
      noiseFloorDbm: -110,

      antennaType: "phased",
      gainTxDb: 35,
      gainRxDb: 35,
      beamWidthDeg: 4,
      pointingLossDb: 1.0,
      polLossDb: 0.3,
      phasedMaxScanDeg: 30,
      phasedScanLossDb: 2.0,

      txFeederLossDb: 1.0,
      rxFeederLossDb: 1.0,
      implLossDb: 1.0,

      modulation: "QPSK",
      codingRate: 0.5,
      dataRateMbps: 180,
      bandwidthMHz: 25,

      sysTempK: 650,
      noiseBandwidthMHz: 25,

      maxNeighborsPerSat: 4,
      routingMetric: "snr_distance",

      txElecPowerW: 120,
      dutyCycle: 0.2,
      refDistanceKm: 1500
    },

    C: {
      // Надёжность: fallback, минимизировать обрывы, дальность ~1700–1900 км
      name: "C — Надёжность (до ~1800 км)",
      freqMHz: 25000,
      txPowerDbm: 32,
      rxSensDbm: -99,
      minSnrDb: 4,
      maxRangeKm: 1850,
      noiseFloorDbm: -110,

      antennaType: "phased",
      gainTxDb: 33,
      gainRxDb: 33,
      beamWidthDeg: 4,
      pointingLossDb: 1.0,
      polLossDb: 0.3,
      phasedMaxScanDeg: 25,
      phasedScanLossDb: 1.6,

      txFeederLossDb: 1.0,
      rxFeederLossDb: 1.0,
      implLossDb: 1.0,

      modulation: "QPSK",
      codingRate: 0.5,
      dataRateMbps: 35,
      bandwidthMHz: 12,

      sysTempK: 600,
      noiseBandwidthMHz: 12,

      maxNeighborsPerSat: 6,
      routingMetric: "snr_distance",

      txElecPowerW: 70,
      dutyCycle: 0.2,
      refDistanceKm: 1500
    }
  };

  function setElValue(id, value) {
    const el = document.getElementById(id);
    if (!el || value === undefined || value === null) return;
    el.value = String(value);
  }

  function setSelectValue(id, value) {
    const el = document.getElementById(id);
    if (!el || value === undefined || value === null) return;
    el.value = String(value);
  }

  function applyPhasedProfileToUI(profileKey) {
    const p = PHASED_PROFILES[profileKey];
    if (!p) return false;

    setSelectValue("radio-antenna-type", "phased");
    radioState.config.antennaType = "phased";
    updateAntennaBlocksVisibility("phased");

    setElValue("radio-freq-mhz", p.freqMHz);
    setElValue("radio-tx-power", p.txPowerDbm);
    setElValue("radio-rx-sens", p.rxSensDbm);
    setElValue("radio-min-snr", p.minSnrDb);
    setElValue("radio-max-range-km", p.maxRangeKm);
    setElValue("radio-noise-floor", p.noiseFloorDbm);

    setElValue("radio-gain-tx", p.gainTxDb);
    setElValue("radio-gain-rx", p.gainRxDb);
    setElValue("radio-beam-width", p.beamWidthDeg);
    setElValue("radio-pointing-loss", p.pointingLossDb);
    setElValue("radio-pol-loss", p.polLossDb);

    setElValue("radio-phased-max-scan", p.phasedMaxScanDeg);
    setElValue("radio-phased-scan-loss", p.phasedScanLossDb);

    setElValue("radio-tx-feeder-loss", p.txFeederLossDb);
    setElValue("radio-rx-feeder-loss", p.rxFeederLossDb);
    setElValue("radio-impl-loss", p.implLossDb);

    setSelectValue("radio-modulation", p.modulation);
    setSelectValue("radio-coding-rate", p.codingRate);
    setElValue("radio-data-rate-mbps", p.dataRateMbps);
    setElValue("radio-bandwidth-mhz", p.bandwidthMHz);

    setElValue("radio-sys-temp-k", p.sysTempK);
    setElValue("radio-noise-bandwidth-mhz", p.noiseBandwidthMHz);

    setElValue("radio-mesh-max-neighbors", p.maxNeighborsPerSat);
    setSelectValue("radio-mesh-metric", p.routingMetric);

    setElValue("radio-tx-elec-power", p.txElecPowerW);
    setElValue("radio-duty-cycle", p.dutyCycle * 100.0);
    setElValue("radio-ref-distance-km", p.refDistanceKm);

    return true;
  }

  function applyPhasedProfileToConfig(profileKey) {
    const p = PHASED_PROFILES[profileKey];
    if (!p) return false;

    const cfg = radioState.config;

    Object.assign(cfg, {
      freqMHz: p.freqMHz,
      txPowerDbm: p.txPowerDbm,
      rxSensDbm: p.rxSensDbm,
      minSnrDb: p.minSnrDb,
      maxRangeKm: p.maxRangeKm,
      noiseFloorDbm: p.noiseFloorDbm,

      antennaType: "phased",
      gainTxDb: p.gainTxDb,
      gainRxDb: p.gainRxDb,
      beamWidthDeg: p.beamWidthDeg,
      pointingLossDb: p.pointingLossDb,
      polLossDb: p.polLossDb,
      phasedMaxScanDeg: p.phasedMaxScanDeg,
      phasedScanLossDb: p.phasedScanLossDb,

      txFeederLossDb: p.txFeederLossDb,
      rxFeederLossDb: p.rxFeederLossDb,
      implLossDb: p.implLossDb,

      modulation: p.modulation,
      codingRate: p.codingRate,
      dataRateMbps: p.dataRateMbps,
      bandwidthMHz: p.bandwidthMHz,

      sysTempK: p.sysTempK,
      noiseBandwidthMHz: p.noiseBandwidthMHz,

      maxNeighborsPerSat: p.maxNeighborsPerSat,
      routingMetric: p.routingMetric,

      txElecPowerW: p.txElecPowerW,
      dutyCycle: p.dutyCycle,
      refDistanceKm: p.refDistanceKm
    });

    return true;
  }

  if (radioForm) {
    radioForm.addEventListener("submit", function (e) {
      e.preventDefault();

      if (phasedProfileSelect) {
        const key = phasedProfileSelect.value;
        if (key && key !== "manual") {
          applyPhasedProfileToUI(key);
          applyPhasedProfileToConfig(key);
        }
      }

      const cfg = radioState.config;

      const freqInput         = document.getElementById("radio-freq-mhz");
      const txInput           = document.getElementById("radio-tx-power");
      const gTxInput          = document.getElementById("radio-gain-tx");
      const gRxInput          = document.getElementById("radio-gain-rx");
      const sensInput         = document.getElementById("radio-rx-sens");
      const noiseInput        = document.getElementById("radio-noise-floor");
      const snrInput          = document.getElementById("radio-min-snr");
      const maxRangeInput     = document.getElementById("radio-max-range-km");

      const minDistEnabledInput = document.getElementById("radio-limit-min-distance");
      const minDistKmInput = document.getElementById("radio-min-link-distance-km");

      const modInput          = document.getElementById("radio-modulation");
      const codingInput       = document.getElementById("radio-coding-rate");
      const dataRateInput     = document.getElementById("radio-data-rate-mbps");
      const bwInput           = document.getElementById("radio-bandwidth-mhz");

      const antTypeInput      = document.getElementById("radio-antenna-type");
      const beamWidthInput    = document.getElementById("radio-beam-width");
      const pointingLossInput = document.getElementById("radio-pointing-loss");
      const polLossInput      = document.getElementById("radio-pol-loss");

      const phasedMaxScanInput  = document.getElementById("radio-phased-max-scan");
      const phasedScanLossInput = document.getElementById("radio-phased-scan-loss");

      const omniGainInput     = document.getElementById("radio-omni-gain");

      const customGainInput       = document.getElementById("radio-custom-gain");
      const customBeamwidthInput  = document.getElementById("radio-custom-beamwidth");
      const customSidelobeInput   = document.getElementById("radio-custom-sidelobe");
      const customAngleLossInput  = document.getElementById("radio-custom-angle-loss");

      const txFeedLossInput   = document.getElementById("radio-tx-feeder-loss");
      const rxFeedLossInput   = document.getElementById("radio-rx-feeder-loss");
      const implLossInput     = document.getElementById("radio-impl-loss");

      const sysTempInput      = document.getElementById("radio-sys-temp-k");
      const noiseBwInput      = document.getElementById("radio-noise-bandwidth-mhz");

      const maxNeighInput     = document.getElementById("radio-mesh-max-neighbors");
      const meshMetricInput   = document.getElementById("radio-mesh-metric");

      const txElecPowerInput  = document.getElementById("radio-tx-elec-power");
      const dutyCycleInput    = document.getElementById("radio-duty-cycle");
      const refDistInput      = document.getElementById("radio-ref-distance-km");

      if (freqInput)      cfg.freqMHz        = parseFloat(freqInput.value)      || cfg.freqMHz;
      if (txInput)        cfg.txPowerDbm     = parseFloat(txInput.value)        || cfg.txPowerDbm;
      if (gTxInput)       cfg.gainTxDb       = parseFloat(gTxInput.value)       || cfg.gainTxDb;
      if (gRxInput)       cfg.gainRxDb       = parseFloat(gRxInput.value)       || cfg.gainRxDb;
      if (sensInput)      cfg.rxSensDbm      = parseFloat(sensInput.value)      || cfg.rxSensDbm;
      if (noiseInput)     cfg.noiseFloorDbm  = parseFloat(noiseInput.value)     || cfg.noiseFloorDbm;
      if (snrInput)       cfg.minSnrDb       = parseFloat(snrInput.value)       || cfg.minSnrDb;
      if (maxRangeInput) {
        const v = parseFloat(maxRangeInput.value);
        cfg.maxRangeKm = isNaN(v) ? 0 : v;
      }

      if (minDistEnabledInput) cfg.minLinkDistanceEnabled = !!minDistEnabledInput.checked;
      if (minDistKmInput) {
        const v = parseFloat(minDistKmInput.value);
        cfg.minLinkDistanceKm = isFinite(v) && v >= 0 ? v : 0;
      }

      if (modInput)       cfg.modulation     = modInput.value || cfg.modulation;
      if (codingInput) {
        const v = parseFloat(codingInput.value);
        cfg.codingRate = !isNaN(v) && v > 0 ? v : cfg.codingRate;
      }
      if (dataRateInput) {
        const v = parseFloat(dataRateInput.value);
        cfg.dataRateMbps = !isNaN(v) && v > 0 ? v : cfg.dataRateMbps;
      }
      if (bwInput) {
        const v = parseFloat(bwInput.value);
        cfg.bandwidthMHz = !isNaN(v) && v > 0 ? v : cfg.bandwidthMHz;
      }

      if (antTypeInput)   cfg.antennaType    = antTypeInput.value || cfg.antennaType;
      if (beamWidthInput) {
        const v = parseFloat(beamWidthInput.value);
        cfg.beamWidthDeg = !isNaN(v) && v > 0 ? v : cfg.beamWidthDeg;
      }
      if (pointingLossInput) {
        const v = parseFloat(pointingLossInput.value);
        cfg.pointingLossDb = !isNaN(v) ? v : cfg.pointingLossDb;
      }
      if (polLossInput) {
        const v = parseFloat(polLossInput.value);
        cfg.polLossDb = !isNaN(v) ? v : cfg.polLossDb;
      }

      if (phasedMaxScanInput) {
        const v = parseFloat(phasedMaxScanInput.value);
        cfg.phasedMaxScanDeg = !isNaN(v) && v > 0 ? v : cfg.phasedMaxScanDeg;
      }
      if (phasedScanLossInput) {
        const v = parseFloat(phasedScanLossInput.value);
        cfg.phasedScanLossDb = !isNaN(v) ? v : cfg.phasedScanLossDb;
      }

      if (omniGainInput) {
        const v = parseFloat(omniGainInput.value);
        cfg.omniGainDb = !isNaN(v) ? v : cfg.omniGainDb;
      }

      if (customGainInput) {
        const v = parseFloat(customGainInput.value);
        cfg.customGainDb = !isNaN(v) ? v : cfg.customGainDb;
      }
      if (customBeamwidthInput) {
        const v = parseFloat(customBeamwidthInput.value);
        cfg.customBeamwidthDeg = !isNaN(v) && v > 0 ? v : cfg.customBeamwidthDeg;
      }
      if (customSidelobeInput) {
        const v = parseFloat(customSidelobeInput.value);
        cfg.customSidelobeLossDb = !isNaN(v) ? v : cfg.customSidelobeLossDb;
      }
      if (customAngleLossInput) {
        const v = parseFloat(customAngleLossInput.value);
        cfg.customAngleLossDbPerDeg = !isNaN(v) ? v : cfg.customAngleLossDbPerDeg;
      }

      if (txFeedLossInput) {
        const v = parseFloat(txFeedLossInput.value);
        cfg.txFeederLossDb = !isNaN(v) ? v : cfg.txFeederLossDb;
      }
      if (rxFeedLossInput) {
        const v = parseFloat(rxFeedLossInput.value);
        cfg.rxFeederLossDb = !isNaN(v) ? v : cfg.rxFeederLossDb;
      }
      if (implLossInput) {
        const v = parseFloat(implLossInput.value);
        cfg.implLossDb = !isNaN(v) ? v : cfg.implLossDb;
      }

      if (sysTempInput) {
        const v = parseFloat(sysTempInput.value);
        cfg.sysTempK = !isNaN(v) && v > 0 ? v : cfg.sysTempK;
      }
      if (noiseBwInput) {
        const v = parseFloat(noiseBwInput.value);
        cfg.noiseBandwidthMHz = !isNaN(v) && v > 0 ? v : cfg.noiseBandwidthMHz;
      }

      if (maxNeighInput) {
        const v = parseInt(maxNeighInput.value, 10);
        cfg.maxNeighborsPerSat = !isNaN(v) && v >= 0 ? v : cfg.maxNeighborsPerSat;
      }
      if (meshMetricInput) {
        cfg.routingMetric = meshMetricInput.value || cfg.routingMetric;
      }

      if (txElecPowerInput) {
        const v = parseFloat(txElecPowerInput.value);
        cfg.txElecPowerW = !isNaN(v) && v >= 0 ? v : cfg.txElecPowerW;
      }
      if (dutyCycleInput) {
        const v = parseFloat(dutyCycleInput.value);
        cfg.dutyCycle = !isNaN(v) ? Math.min(Math.max(v / 100.0, 0), 1) : cfg.dutyCycle;
      }
      if (refDistInput) {
        const v = parseFloat(refDistInput.value);
        cfg.refDistanceKm = !isNaN(v) && v > 0 ? v : cfg.refDistanceKm;
      }

      updateAntennaBlocksVisibility(cfg.antennaType);

      const noiseFromTemp = computeNoiseFloorFromTemp(cfg).toFixed(1);
      updateRadioMeshInfo(
        `<b>Параметры обновлены.</b><br/>
         f = ${cfg.freqMHz} МГц, Tx = ${cfg.txPowerDbm} dBm, Gt = ${cfg.gainTxDb} dBi, Gr = ${cfg.gainRxDb} dBi<br/>
         RxSens = ${cfg.rxSensDbm} dBm, Noise ≈ ${noiseFromTemp} dBm (из T_sys и B), SNRmin = ${cfg.minSnrDb} dB<br/>
         MaxRange = ${cfg.maxRangeKm > 0 ? cfg.maxRangeKm + " км" : "не ограничена (по радиофизике)"}`
      );

      radioState.lastUpdateSeconds = 0;
      updateSingleLinkAndEnergySummary();
    });
  }

  // --- 11. Single-link summary и энергетика КА ---

  function computeCapacityMbps(cfg, snrDb) {
    const B_Hz = cfg.bandwidthMHz * 1e6;
    if (B_Hz <= 0 || !isFinite(snrDb)) return NaN;

    const snrLin = Math.pow(10, snrDb / 10);
    const C_bps = B_Hz * Math.log2(1 + snrLin);
    const capShannonMbps = C_bps / 1e6;
    const capMcsMbps = cfg.dataRateMbps;
    return Math.min(capShannonMbps, capMcsMbps);
  }

  function updateSingleLinkAndEnergySummary() {
    const cfg = radioState.config;
    if (!radioLinkSummaryEl && !radioEnergySummaryEl) return;

    function antennaTypeHuman(t) {
      switch ((t || "").toLowerCase()) {
        case "phased": return "Фазированная решётка (ФАР)";
        case "omni": return "Всена­правленная антенна (омни)";
        case "sector": return "Секторная антенна";
        case "directional": return "Направленная антенна";
        case "custom": return "Пользовательская антенна";
        default: return t || "Антенна";
      }
    }

    let dRefKm = cfg.refDistanceKm;
    if ((!dRefKm || dRefKm <= 0) && radioState.lastAvgLinkDistKm > 0) dRefKm = radioState.lastAvgLinkDistKm;
    if (!dRefKm || dRefKm <= 0) dRefKm = 1000;

    const dRefMeters = dRefKm * 1000;
    const fsplRefDb = computeFsplDb(dRefMeters, cfg.freqMHz);

    const { effGainTxDb, effGainRxDb, extraLossDb } = getEffectiveAntennaGains(cfg);

    const totalTxGainDb =
      effGainTxDb - cfg.txFeederLossDb - cfg.pointingLossDb;
    const totalRxGainDb =
      effGainRxDb - cfg.rxFeederLossDb - cfg.pointingLossDb - cfg.polLossDb;

    const noiseFromTemp = computeNoiseFloorFromTemp(cfg);

    const rxRefDbm =
      cfg.txPowerDbm +
      totalTxGainDb +
      totalRxGainDb -
      fsplRefDb -
      cfg.implLossDb -
      extraLossDb;

    const snrRefDb = rxRefDbm - noiseFromTemp;

    const Rb = cfg.dataRateMbps * 1e6;
    const B_Hz = cfg.bandwidthMHz * 1e6;
    let ebnoRefDb = NaN;
    if (Rb > 0 && B_Hz > 0 && isFinite(snrRefDb)) {
      const ratio = Rb / B_Hz;
      ebnoRefDb = snrRefDb - 10 * Math.log10(ratio);
    }
    const ebnoReqDb = getRequiredEbNoDb(cfg.modulation, cfg.codingRate);
    const ebnoMarginDb = isFinite(ebnoRefDb) ? ebnoRefDb - ebnoReqDb : NaN;

    const capRefMbps = computeCapacityMbps(cfg, snrRefDb);

    const gainsDb =
      cfg.txPowerDbm + totalTxGainDb + totalRxGainDb - cfg.implLossDb - extraLossDb;

    let rMaxRxKm = NaN;
    if (gainsDb > cfg.rxSensDbm) {
      const fsplLimitRx = gainsDb - cfg.rxSensDbm;
      const dKmRx = Math.pow(
        10,
        (fsplLimitRx - 32.44 - 20 * Math.log10(cfg.freqMHz)) / 20
      );
      rMaxRxKm = dKmRx;
    }

    let rMaxSnrKm = NaN;
    if (isFinite(noiseFromTemp)) {
      const rxAtSnr = noiseFromTemp + cfg.minSnrDb;
      if (gainsDb > rxAtSnr) {
        const fsplLimitSnr = gainsDb - rxAtSnr;
        const dKmSnr = Math.pow(
          10,
          (fsplLimitSnr - 32.44 - 20 * Math.log10(cfg.freqMHz)) / 20
        );
        rMaxSnrKm = dKmSnr;
      }
    }

    let rMaxKm = NaN;
    if (isFinite(rMaxRxKm) && isFinite(rMaxSnrKm)) rMaxKm = Math.min(rMaxRxKm, rMaxSnrKm);
    else if (isFinite(rMaxRxKm)) rMaxKm = rMaxRxKm;
    else if (isFinite(rMaxSnrKm)) rMaxKm = rMaxSnrKm;

    if (radioLinkSummaryEl) {
      radioLinkSummaryEl.innerHTML =
        `<div style="margin-bottom:4px;"><b>Канал (эталонный линк)</b></div>
         <div style="line-height:1.35;">
           <div><b class="radio-label">Тип антенны:</b> <b>${antennaTypeHuman(cfg.antennaType)}</b></div>
           <div><b class="radio-label">Опорная дальность (d<sub>ref</sub>):</b> <b>${dRefKm.toFixed(0)} км</b></div>
           <div><b class="radio-label">Свободные потери (FSPL):</b> <b>${fsplRefDb.toFixed(1)} dB</b></div>
           <div><b class="radio-label">Мощность на приёмнике (Rx):</b> <b>${rxRefDbm.toFixed(1)} dBm</b></div>
           <div><b class="radio-label">Шум приёмника (T<sub>sys</sub>, B):</b> <b>${noiseFromTemp.toFixed(1)} dBm</b></div>
           <div><b class="radio-label">Отношение сигнал/шум (SNR):</b> <b>${isFinite(snrRefDb) ? snrRefDb.toFixed(1) : "-"} dB</b></div>
           <div><b class="radio-label">Eb/N0:</b> <b>${isFinite(ebnoRefDb) ? ebnoRefDb.toFixed(1) : "-"} dB</b>,
             <b class="radio-label">требуется:</b> <b>${ebnoReqDb.toFixed(1)} dB</b>,
             <b class="radio-label">запас:</b> <b>${isFinite(ebnoMarginDb) ? ebnoMarginDb.toFixed(1) : "-"} dB</b>
           </div>
           <div><b class="radio-label">Целевая скорость (MCS):</b> <b>${cfg.dataRateMbps} Мбит/с</b> при <b>${cfg.bandwidthMHz} МГц</b></div>
           <div><b class="radio-label">Оценка Шеннона:</b> <b>${isFinite(capRefMbps) ? capRefMbps.toFixed(1) : "-"} Мбит/с</b> (ограничено SNR и полосой)</div>
           <div><b class="radio-label">Доступная скорость (мин из MCS/Шеннона):</b> <b>${isFinite(capRefMbps) ? Math.min(capRefMbps, cfg.dataRateMbps).toFixed(1) : "-"} Мбит/с</b></div>
           <div><b class="radio-label">Дальность R<sub>max</sub> (по Rx / по SNR / итог):</b>
             <b>${isFinite(rMaxRxKm) ? rMaxRxKm.toFixed(0) : "-"} / ${isFinite(rMaxSnrKm) ? rMaxSnrKm.toFixed(0) : "-"} / ${isFinite(rMaxKm) ? rMaxKm.toFixed(0) : "-"} км</b>
           </div>
         </div>`;
    }

    if (radioEnergySummaryEl) {
      const Ptx = cfg.txElecPowerW;
      const duty = cfg.dutyCycle;
      let Ebit_J = NaN;
      if (Ptx > 0 && Rb > 0) Ebit_J = Ptx / Rb;

      const Pavg = Ptx * duty;
      const Torbit = computeAverageOrbitPeriodSec();
      const Eorbit_J = Pavg * Torbit;
      const Eorbit_Wh = Eorbit_J / 3600.0;

      radioEnergySummaryEl.innerHTML =
        `<div style="margin-bottom:4px;"><b>Энергетика КА</b></div>
         <div style="line-height:1.35;">
           <div><b class="radio-label">Пиковая электрическая мощность передатчика:</b> <b>${Ptx.toFixed(1)} W</b></div>
           <div><b class="radio-label">Доля времени в передаче (duty cycle):</b> <b>${(duty * 100).toFixed(1)} %</b></div>
           <div><b class="radio-label">Энергия на бит (E<sub>b</sub>):</b> <b>${isFinite(Ebit_J) ? (Ebit_J * 1e9).toFixed(2) : "-"} нДж/бит</b></div>
           <div><b class="radio-label">Средняя потребляемая мощность:</b> <b>${Pavg.toFixed(2)} W</b></div>
           <div><b class="radio-label">Период орбиты:</b> <b>${(Torbit / 60).toFixed(1)} мин</b></div>
           <div><b class="radio-label">Энергозатраты за один виток:</b> <b>${isFinite(Eorbit_Wh) ? Eorbit_Wh.toFixed(3) : "-"} Wh</b></div>
         </div>`;
    }
  }

  // --- 12. Основной цикл: пересчёт mesh-сети ---

  clock.onTick.addEventListener(function (clockEvent) {
    if (!radioState.enabled) return;

    const time = clockEvent.currentTime;
    const seconds = Cesium.JulianDate.secondsDifference(time, startTime);

    if (seconds - radioState.lastUpdateSeconds < radioState.updatePeriodSec) return;
    radioState.lastUpdateSeconds = seconds;

    const { sats, satKindById } = collectAllSatellites(time);
    const n = sats.length;

    if (n < 2) {
      clearRadioLinks();
      updateRadioMeshInfo("Нужно как минимум два КА для формирования радиосети.");
      radioState.lastAvgLinkDistKm = 0;
      updateSingleLinkAndEnergySummary();
      return;
    }

    const cfg = radioState.config;

    if (!radioState.drawLinks && radioState.linksByKey.size > 0) clearRadioLinks();

    let linksCount = 0;
    let snrMin = Number.POSITIVE_INFINITY;
    let snrMax = Number.NEGATIVE_INFINITY;
    let snrSum = 0;
    let snrSamples = 0;

    let distSumKm = 0;
    let distSamples = 0;
    let capacitySumMbps = 0;

    const maxNeigh = cfg.maxNeighborsPerSat || 0;

    // степень "для статистики" (все рёбра)
    const degrees = new Array(n).fill(0);

    // степень ТОЛЬКО по mesh↔mesh (ограничивается maxNeigh)
    const meshDegrees = new Array(n).fill(0);
    const activeKeys = new Set();

    const misMaxLinks = cfg.misMaxLinks || 3;
    const misDegrees = new Array(n).fill(0); // степень только по MIS↔mesh для MIS-узлов


    // Перестраиваем снимок текущих активных ребёр
    radioState.activeEdgesByKey.clear();

    // --- Генерация кандидатов (единая логика) ---
    const candidates = [];
    const candidateByKey = new Map();

    // Список ключей прошлого тика
    const prevKeySet = new Set(radioState.prevActiveEdgesByKey ? radioState.prevActiveEdgesByKey.keys() : []);

    for (let i = 0; i < n; i++) {
      const satA = sats[i];
      const posA = satA.position.getValue(time);
      if (!posA) continue;
      const orbitIdA = cfg.limitOrbitHop ? getOrbitId(satA, time) : null;

      for (let j = i + 1; j < n; j++) {
        const satB = sats[j];
        const posB = satB.position.getValue(time);
        if (!posB) continue;
        const orbitIdB = cfg.limitOrbitHop ? getOrbitId(satB, time) : null;

        const aIsMis = isMissionSat(satA, time);
        const bIsMis = isMissionSat(satB, time);

        // Ограничение "только соседние орбиты" применяем только к mesh↔mesh, а MIS ↔ любой не фильтруем
        if (cfg.limitOrbitHop && !aIsMis && !bIsMis && orbitIdA !== null && orbitIdB !== null) {
          if (Math.abs(orbitIdA - orbitIdB) > 1) continue;
        }

        // Если запрещены MIS↔MIS (можно переключать конфигом)
        if (!cfg.allowMisToMis && aIsMis && bIsMis) continue;

        // Оценка линка по радиофизике
        const evalRes = evaluateLink(posA, posB);
        if (!evalRes.linkUp) continue;

        const key = makeLinkKey(satA.id, satB.id);

        // базовый score: выше SNR и ближе — лучше
        const snr = isFinite(evalRes.snrDb) ? evalRes.snrDb : -9999;
        const dist = isFinite(evalRes.distanceKm) ? evalRes.distanceKm : 1e12;
        // MIS↔mesh — сильнее штрафуем расстояние
        const isMisEdge = aIsMis !== bIsMis;
        const baseScore = isMisEdge ? (snr * 1000 - dist * 2.0) : (snr * 1000 - dist);

        // sticky bonus, если ребро было активно на прошлом тике
        const wasPrev = prevKeySet.has(key);
        const score = baseScore + (wasPrev ? (cfg.stickyBonus || 0) : 0);

        const edge = { i, j, satA, satB, key, evalRes, score, aIsMis, bIsMis, baseScore, wasPrev };
        candidates.push(edge);
        candidateByKey.set(key, edge);
      }
    }

    // Сортируем: сначала наиболее “ценные” (включая sticky)
    candidates.sort((a, b) => b.score - a.score);

    function activateEdge(edge) {
      const { i, j, satA, satB, key, evalRes, aIsMis, bIsMis, baseScore } = edge;

      // --- лимит линков для MIS (только MIS↔mesh) ---
      if (edge.aIsMis !== edge.bIsMis) { // значит это MIS↔mesh
        if (edge.aIsMis) {
          if (misDegrees[edge.i] >= misMaxLinks) return;
        } else {
          if (misDegrees[edge.j] >= misMaxLinks) return;
        }
      }
      if (edge.aIsMis !== edge.bIsMis) {
        if (edge.aIsMis) misDegrees[edge.i]++; else misDegrees[edge.j]++;
      }


      if (activeKeys.has(key)) return;
      activeKeys.add(key);

      linksCount++;
      degrees[i]++;
      degrees[j]++;

      // ограничение maxNeighbors применяется только к mesh↔mesh,
      // поэтому считаем отдельную степень для mesh↔mesh
      const isMeshMesh = !(aIsMis || bIsMis); // т.к. isMisEdge = (aIsMis || bIsMis)
      if (isMeshMesh) {
        meshDegrees[i]++;
        meshDegrees[j]++;
      }

      let capMbps = NaN;
      if (isFinite(evalRes.snrDb)) {
        snrMin = Math.min(snrMin, evalRes.snrDb);
        snrMax = Math.max(snrMax, evalRes.snrDb);
        snrSum += evalRes.snrDb;
        snrSamples++;

        capMbps = computeCapacityMbps(cfg, evalRes.snrDb);
        if (isFinite(capMbps)) capacitySumMbps += capMbps;
      }

      radioState.activeEdgesByKey.set(key, {
        key,
        aId: satA.id,
        bId: satB.id,
        distanceKm: evalRes.distanceKm,
        rxPowerDbm: evalRes.rxPowerDbm,
        snrDb: evalRes.snrDb,
        noiseFloorDbm: evalRes.noiseFloorDbm,
        capacityMbps: capMbps,
        isMisEdge: !!(aIsMis || bIsMis),
        score: baseScore
      });

      if (isFinite(evalRes.distanceKm)) {
        distSumKm += evalRes.distanceKm;
        distSamples++;
      }

      if (radioState.drawLinks) {
        let ent = radioState.linksByKey.get(key);
        if (!ent) {
          ent = createRadioLinkEntity(satA, satB, evalRes.snrDb);
          radioState.linksByKey.set(key, ent);
        } else {
          updateRadioLinkVisual(ent, evalRes.snrDb);
        }
      }
    }

    // --- Шаг 1: попробуем сохранить прошлые рёбра (если они всё ещё возможны) ---
    // Это делает make-before-break на уровне всей сети.
    if (radioState.prevActiveEdgesByKey && radioState.prevActiveEdgesByKey.size > 0) {
      for (const prev of radioState.prevActiveEdgesByKey.values()) {
        const edge = candidateByKey.get(prev.key);
        if (!edge) continue;

        if (maxNeigh > 0) {
          const isMeshMesh = !(edge.aIsMis || edge.bIsMis);
          if (isMeshMesh) {
            if (meshDegrees[edge.i] >= maxNeigh || meshDegrees[edge.j] >= maxNeigh) continue;
          }
        }
        activateEdge(edge);
      }
    }

    // --- Шаг 2: добираем рёбра по общему greedy (как для КА связи) ---
    for (const edge of candidates) {
      if (activeKeys.has(edge.key)) continue;

      if (maxNeigh > 0) {
        const isMeshMesh = !(edge.aIsMis || edge.bIsMis);
        if (isMeshMesh) {
          if (meshDegrees[edge.i] >= maxNeigh || meshDegrees[edge.j] >= maxNeigh) continue;
        }
      }
      activateEdge(edge);
    }

    // --- Чистим "мертвые" линии визуализации ---
    if (radioState.drawLinks) {
      for (const [key, ent] of radioState.linksByKey.entries()) {
        if (!activeKeys.has(key)) {
          viewer.entities.remove(ent);
          radioState.linksByKey.delete(key);
        }
      }
    }

    const snrAvg = snrSamples > 0 ? snrSum / snrSamples : NaN;
    const avgDistKm = distSamples > 0 ? distSumKm / distSamples : NaN;
    radioState.lastAvgLinkDistKm = isFinite(avgDistKm) ? avgDistKm : 0;

    // Статистика участия
    let activeSatCount = 0;
    for (let i = 0; i < n; i++) if (degrees[i] > 0) activeSatCount++;

    let totalMeshSatCount = 0;
    let totalMisSatCount = 0;
    let activeMeshSatCount = 0;
    let activeMisSatCount = 0;

    for (let i = 0; i < n; i++) {
      const ent = sats[i];
      const isMis = isMissionSat(ent, time) === true;

      if (isMis) totalMisSatCount++;
      else totalMeshSatCount++;

      if (degrees[i] > 0) {
        if (isMis) activeMisSatCount++;
        else activeMeshSatCount++;
      }
    }

    const avgDegree = activeSatCount > 0 ? (2 * linksCount) / activeSatCount : 0;

    if (linksCount === 0) {
      updateRadioMeshInfo(
        "Активных радиолинков нет (нет пар КА, удовлетворяющих LoS / RxSens / SNR)."
      );
      updateSingleLinkAndEnergySummary();
      // обновим prev снимок (пустой)
      radioState.prevActiveEdgesByKey = new Map(radioState.activeEdgesByKey);
      return;
    }

    updateRadioMeshInfo(
      `<b>Активных линков:</b> ${linksCount}<br/>
       <b>КА в сети (mesh):</b> ${activeMeshSatCount} из ${totalMeshSatCount}<br/>
       <b>КА в сети (задания/MIS):</b> ${activeMisSatCount} из ${totalMisSatCount}<br/>
       <b>Среднее число линков на один КА:</b> ≈ ${avgDegree.toFixed(2)}<br/>
       <b>Средняя дальность линка между КА:</b> ≈ ${isFinite(avgDistKm) ? avgDistKm.toFixed(1) : "-"} км<br/>
       <b>Оценочная суммарная пропускная способность сети:</b> ≈ ${isFinite(capacitySumMbps) ? capacitySumMbps.toFixed(1) : "-"} Мбит/с<br/>
       <b>Качество линков (SNR, dB):</b> минимум=${isFinite(snrMin) ? snrMin.toFixed(1) : "-"}, 
       среднее=${isFinite(snrAvg) ? snrAvg.toFixed(1) : "-"}, 
       максимум=${isFinite(snrMax) ? snrMax.toFixed(1) : "-"}<br/>
       <small>Обновление топологии каждые ${radioState.updatePeriodSec.toFixed(1)} с. StickyBonus=${cfg.stickyBonus || 0}.</small>`
    );

    updateSingleLinkAndEnergySummary();

    // Сохраняем снимок на следующий тик
    radioState.prevActiveEdgesByKey = new Map(radioState.activeEdgesByKey);

    // Событие для внешних модулей
    try {
      window.dispatchEvent(new CustomEvent("spaceMesh:radioTick", {
        detail: {
          time,
          links: linksCount,
          activeEdges: radioState.activeEdgesByKey.size
        }
      }));
    } catch {}
  });

  // --- 13. Реакция на изменение топологии ---
  window.addEventListener("spaceMesh:topologyChanged", onTopologyChanged);
})();

// --- Кнопка показать / скрыть панель "Радиосеть КА" ---
const radioPanel = document.getElementById("radio-panel");
const radioToggle = document.getElementById("radio-toggle");

if (radioPanel && radioToggle) {
  radioToggle.addEventListener("click", () => {
    const hidden = radioPanel.classList.toggle("hidden");
    radioToggle.textContent = hidden ? "▲ Радио" : "▼ Радио";
  });
}
