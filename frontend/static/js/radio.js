// static/js/radio.js
// Расширенная модель радиосети: MCS, антенны, потери, шум, энергетика КА, метрики mesh.

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
    enabled: false,        // включено ли моделирование
    drawLinks: true,       // рисовать ли линии
    lastUpdateSeconds: 0,
    updatePeriodSec: 1.0,  // период пересчёта сети, с

    // Запоминаем последнюю среднюю дальность линка (для single-link summary)
    lastAvgLinkDistKm: 0,

    config: {
      // Линк-бюджет
      freqMHz: 2200,
      txPowerDbm: 30,
      gainTxDb: 10,
      gainRxDb: 10,
      rxSensDbm: -100,
      noiseFloorDbm: -110, // fallback, если не считаем из T_sys
      minSnrDb: 5,
      maxRangeKm: 0, // 0 = без ограничения по дальности

      // MCS
      modulation: "QPSK",
      codingRate: 2 / 3,
      dataRateMbps: 50,
      bandwidthMHz: 20,

      // Антенны / потери
      antennaType: "directional", // directional|sector|phased|omni|custom

      beamWidthDeg: 20,
      pointingLossDb: 1.0,
      polLossDb: 0.5,

      // ФАР
      phasedMaxScanDeg: 45,
      phasedScanLossDb: 1.5,

      // Omni
      omniGainDb: 2.0,

      // Custom
      customGainDb: 12.0,
      customBeamwidthDeg: 25,
      customSidelobeLossDb: 10.0,
      customAngleLossDbPerDeg: 0.4,

      // Потери тракта
      txFeederLossDb: 1.0,
      rxFeederLossDb: 1.0,
      implLossDb: 1.0,

      // Шум / приёмник
      sysTempK: 500,
      noiseBandwidthMHz: 20,

      // Mesh
      maxNeighborsPerSat: 0,      // 0 = без ограничения
      routingMetric: "snr",

      // Энергетика КА
      txElecPowerW: 60,
      dutyCycle: 0.2,             // 0…1
      refDistanceKm: 1000
    },

    // key "satIdA|satIdB" -> Cesium.Entity полилинии
    linksByKey: new Map()
  };

  // --- 3. Вспомогательные функции по орбитам и спутникам ---

  function collectAllSatellites() {
    const sats = [];

    orbitStoreRef.forEach((group) => {
      if (!group || !Array.isArray(group.satellites)) return;

      for (const sat of group.satellites) {
        if (!sat) continue;

        if (sat.position && sat.position.getValue) {
          sats.push(sat);
        } else if (sat.entity && sat.entity.position && sat.entity.position.getValue) {
          sats.push(sat.entity);
        }
      }
    });

    return sats;
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

    if (count === 0) {
      return 95 * 60;
    }
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

  // --- 6. Антенна: эффективные усиления + флаги применения потерь ---

  /**
   * Возвращает:
   *  {
   *    effGainTxDb,
   *    effGainRxDb,
   *    extraLossDb,
   *    applyPointingLoss: boolean
   *  }
   */
  function getAntennaModel(cfg) {
    let effGainTxDb = cfg.gainTxDb;
    let effGainRxDb = cfg.gainRxDb;
    let extraLossDb = 0.0;

    // Важно: "pointingLoss" логично применять только там, где реально требуется наведение.
    // Omni и (в твоём новом UI) Custom считаем как "профиль без отдельного pointing loss".
    let applyPointingLoss = true;

    const type = cfg.antennaType || "directional";

    switch (type) {
      case "omni":
        effGainTxDb = cfg.omniGainDb;
        effGainRxDb = cfg.omniGainDb;
        applyPointingLoss = false;
        break;

      case "phased":
        extraLossDb += cfg.phasedScanLossDb;
        applyPointingLoss = true;
        break;

      case "custom":
        effGainTxDb = cfg.customGainDb;
        effGainRxDb = cfg.customGainDb;
        applyPointingLoss = false;
        break;

      case "sector":
      case "directional":
      default:
        applyPointingLoss = true;
        break;
    }

    return {
      effGainTxDb,
      effGainRxDb,
      extraLossDb,
      applyPointingLoss
    };
  }

  // --- 7. Оценка линка между двумя КА ---

  function evaluateLink(posA, posB) {
    const cfg = radioState.config;

    const distanceMeters = Cesium.Cartesian3.distance(posA, posB);
    const distanceKm = distanceMeters / 1000.0;

    if (cfg.maxRangeKm > 0 && distanceKm > cfg.maxRangeKm) {
      return { linkUp: false, distanceKm };
    }

    const los = hasLineOfSightRadio(posA, posB);
    if (!los) {
      return { linkUp: false, distanceKm, los: false };
    }

    const fsplDb = computeFsplDb(distanceMeters, cfg.freqMHz);

    const ant = getAntennaModel(cfg);
    const pointingLossDb = ant.applyPointingLoss ? cfg.pointingLossDb : 0.0;

    const totalTxGainDb =
      ant.effGainTxDb - cfg.txFeederLossDb - pointingLossDb;

    const totalRxGainDb =
      ant.effGainRxDb - cfg.rxFeederLossDb - pointingLossDb - cfg.polLossDb;

    const noiseFloorDbm = computeNoiseFloorFromTemp(cfg);

    const rxPowerDbm =
      cfg.txPowerDbm +
      totalTxGainDb +
      totalRxGainDb -
      fsplDb -
      cfg.implLossDb -
      ant.extraLossDb;

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
        material
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
  const radioForm                = document.getElementById("radio-form");
  const radioMeshInfoEl          = document.getElementById("radio-mesh-info");
  const radioLinkSummaryEl       = document.getElementById("radio-link-summary");
  const radioEnergySummaryEl     = document.getElementById("radio-energy-summary");

  // Антенна – блоки
  const antennaTypeSelect   = document.getElementById("radio-antenna-type");
  const antennaCommonBlock  = document.getElementById("antenna-common-block");
  const antennaPhasedBlock  = document.getElementById("antenna-phased-block");
  const antennaOmniBlock    = document.getElementById("antenna-omni-block");
  const antennaCustomBlock  = document.getElementById("antenna-custom-block");

  function updateRadioMeshInfo(textHtml) {
    if (!radioMeshInfoEl) return;
    radioMeshInfoEl.innerHTML = textHtml;
  }

  // --- 9.1. Переключение видимости блоков антенны (согласно новой HTML-логике) ---

  function updateAntennaBlocksVisibility(type) {
    if (!type && antennaTypeSelect) {
      type = antennaTypeSelect.value;
    }
    if (!type) type = radioState.config.antennaType;

    const t = type || "directional";

    // ВАЖНО:
    // - common блок: только directional/sector/phased
    // - omni: только omni блок
    // - custom: только custom блок
    if (antennaCommonBlock) {
      antennaCommonBlock.style.display =
        (t === "directional" || t === "sector" || t === "phased")
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
  }

  // --- 10. Обработчики чекбоксов и формы ---

  if (radioEnabledCheckbox) {
    radioEnabledCheckbox.addEventListener("change", function () {
      radioState.enabled = !!radioEnabledCheckbox.checked;

      if (!radioState.enabled) {
        clearRadioLinks();
        updateRadioMeshInfo("Радиомоделирование выключено.");
      } else {
        updateRadioMeshInfo(
          "<b>Активных линков:</b> 0<br/>" +
          "<b>КА в сети:</b> 0<br/>" +
          "<b>SNR, dB:</b> -<br/>" +
          "<small>Ожидание расчёта mesh-сети.</small>"
        );
      }
    });
  }

  if (radioDrawLinksCheckbox) {
    radioDrawLinksCheckbox.checked = radioState.drawLinks;
    radioDrawLinksCheckbox.addEventListener("change", function () {
      radioState.drawLinks = !!radioDrawLinksCheckbox.checked;
      if (!radioState.drawLinks) {
        clearRadioLinks();
      }
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

  if (radioForm) {
    radioForm.addEventListener("submit", function (e) {
      e.preventDefault();

      const cfg = radioState.config;

      // Линк-бюджет
      const freqInput         = document.getElementById("radio-freq-mhz");
      const txInput           = document.getElementById("radio-tx-power");
      const gTxInput          = document.getElementById("radio-gain-tx");
      const gRxInput          = document.getElementById("radio-gain-rx");
      const sensInput         = document.getElementById("radio-rx-sens");
      const noiseInput        = document.getElementById("radio-noise-floor");
      const snrInput          = document.getElementById("radio-min-snr");
      const maxRangeInput     = document.getElementById("radio-max-range-km");

      // MCS
      const modInput          = document.getElementById("radio-modulation");
      const codingInput       = document.getElementById("radio-coding-rate");
      const dataRateInput     = document.getElementById("radio-data-rate-mbps");
      const bwInput           = document.getElementById("radio-bandwidth-mhz");

      // Антенна: тип, общие параметры
      const antTypeInput      = document.getElementById("radio-antenna-type");
      const beamWidthInput    = document.getElementById("radio-beam-width");
      const pointingLossInput = document.getElementById("radio-pointing-loss");
      const polLossInput      = document.getElementById("radio-pol-loss");

      // ФАР
      const phasedMaxScanInput  = document.getElementById("radio-phased-max-scan");
      const phasedScanLossInput = document.getElementById("radio-phased-scan-loss");

      // Omni
      const omniGainInput     = document.getElementById("radio-omni-gain");

      // Custom
      const customGainInput       = document.getElementById("radio-custom-gain");
      const customBeamwidthInput  = document.getElementById("radio-custom-beamwidth");
      const customSidelobeInput   = document.getElementById("radio-custom-sidelobe");
      const customAngleLossInput  = document.getElementById("radio-custom-angle-loss");

      // Потери тракта
      const txFeedLossInput   = document.getElementById("radio-tx-feeder-loss");
      const rxFeedLossInput   = document.getElementById("radio-rx-feeder-loss");
      const implLossInput     = document.getElementById("radio-impl-loss");

      // Шум
      const sysTempInput      = document.getElementById("radio-sys-temp-k");
      const noiseBwInput      = document.getElementById("radio-noise-bandwidth-mhz");

      // Mesh
      const maxNeighInput     = document.getElementById("radio-mesh-max-neighbors");
      const meshMetricInput   = document.getElementById("radio-mesh-metric");

      // Энергетика
      const txElecPowerInput  = document.getElementById("radio-tx-elec-power");
      const dutyCycleInput    = document.getElementById("radio-duty-cycle");
      const refDistInput      = document.getElementById("radio-ref-distance-km");

      // Применяем линк-бюджет
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

      // MCS
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

      // Антенна
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

      // Потери тракта
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

      // Шум
      if (sysTempInput) {
        const v = parseFloat(sysTempInput.value);
        cfg.sysTempK = !isNaN(v) && v > 0 ? v : cfg.sysTempK;
      }
      if (noiseBwInput) {
        const v = parseFloat(noiseBwInput.value);
        cfg.noiseBandwidthMHz = !isNaN(v) && v > 0 ? v : cfg.noiseBandwidthMHz;
      }

      // Mesh
      if (maxNeighInput) {
        const v = parseInt(maxNeighInput.value, 10);
        cfg.maxNeighborsPerSat = !isNaN(v) && v >= 0 ? v : cfg.maxNeighborsPerSat;
      }
      if (meshMetricInput) {
        cfg.routingMetric = meshMetricInput.value || cfg.routingMetric;
      }

      // Энергетика
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
         f = ${cfg.freqMHz} МГц, Tx = ${cfg.txPowerDbm} dBm<br/>
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
    return C_bps / 1e6;
  }

  function updateSingleLinkAndEnergySummary() {
    const cfg = radioState.config;
    if (!radioLinkSummaryEl && !radioEnergySummaryEl) return;

    let dRefKm = cfg.refDistanceKm;
    if ((!dRefKm || dRefKm <= 0) && radioState.lastAvgLinkDistKm > 0) {
      dRefKm = radioState.lastAvgLinkDistKm;
    }
    if (!dRefKm || dRefKm <= 0) dRefKm = 1000;

    const dRefMeters = dRefKm * 1000;
    const fsplRefDb = computeFsplDb(dRefMeters, cfg.freqMHz);

    const ant = getAntennaModel(cfg);
    const pointingLossDb = ant.applyPointingLoss ? cfg.pointingLossDb : 0.0;

    const totalTxGainDb =
      ant.effGainTxDb - cfg.txFeederLossDb - pointingLossDb;

    const totalRxGainDb =
      ant.effGainRxDb - cfg.rxFeederLossDb - pointingLossDb - cfg.polLossDb;

    const noiseFromTemp = computeNoiseFloorFromTemp(cfg);

    const rxRefDbm =
      cfg.txPowerDbm +
      totalTxGainDb +
      totalRxGainDb -
      fsplRefDb -
      cfg.implLossDb -
      ant.extraLossDb;

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
      cfg.txPowerDbm + totalTxGainDb + totalRxGainDb - cfg.implLossDb - ant.extraLossDb;

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
    if (isFinite(rMaxRxKm) && isFinite(rMaxSnrKm)) {
      rMaxKm = Math.min(rMaxRxKm, rMaxSnrKm);
    } else if (isFinite(rMaxRxKm)) {
      rMaxKm = rMaxRxKm;
    } else if (isFinite(rMaxSnrKm)) {
      rMaxKm = rMaxSnrKm;
    }

    if (radioLinkSummaryEl) {
      radioLinkSummaryEl.innerHTML =
        `<b>Расчётные показатели канала (эталонный линк):</b><br/>
         Тип антенны: <b>${cfg.antennaType}</b><br/>
         Дальность d<sub>ref</sub> ≈ <b>${dRefKm.toFixed(0)}</b> км<br/>
         FSPL(d<sub>ref</sub>) ≈ <b>${fsplRefDb.toFixed(1)}</b> dB<br/>
         Rx(d<sub>ref</sub>) ≈ <b>${rxRefDbm.toFixed(1)}</b> dBm<br/>
         N<sub>floor</sub> ≈ <b>${noiseFromTemp.toFixed(1)}</b> dBm<br/>
         SNR(d<sub>ref</sub>) ≈ <b>${isFinite(snrRefDb) ? snrRefDb.toFixed(1) : "-"}</b> dB<br/>
         Eb/N0(d<sub>ref</sub>) ≈ <b>${isFinite(ebnoRefDb) ? ebnoRefDb.toFixed(1) : "-"}</b> dB,
         треб. ≈ <b>${ebnoReqDb.toFixed(1)}</b> dB,
         запас ≈ <b>${isFinite(ebnoMarginDb) ? ebnoMarginDb.toFixed(1) : "-"}</b> dB<br/>
         Оценочная пропускная способность C(d<sub>ref</sub>) ≈ <b>${isFinite(capRefMbps) ? capRefMbps.toFixed(1) : "-"}</b> Мбит/с<br/>
         R<sub>max</sub> по Rx ≈ <b>${isFinite(rMaxRxKm) ? rMaxRxKm.toFixed(0) : "-"}</b> км,
         по SNR ≈ <b>${isFinite(rMaxSnrKm) ? rMaxSnrKm.toFixed(0) : "-"}</b> км,
         итог ≈ <b>${isFinite(rMaxKm) ? rMaxKm.toFixed(0) : "-"}</b> км`;
    }

    if (radioEnergySummaryEl) {
      const Ptx = cfg.txElecPowerW;
      const duty = cfg.dutyCycle;

      let Ebit_J = NaN;
      if (Ptx > 0 && Rb > 0) {
        Ebit_J = Ptx / Rb;
      }

      const Pavg = Ptx * duty;
      const Torbit = computeAverageOrbitPeriodSec();
      const Eorbit_J = Pavg * Torbit;
      const Eorbit_Wh = Eorbit_J / 3600.0;

      radioEnergySummaryEl.innerHTML =
        `<b>Энергетика КА:</b><br/>
         Электрическая мощность Tx: <b>${Ptx.toFixed(1)}</b> W<br/>
         Duty cycle: <b>${(duty * 100).toFixed(1)}</b> %<br/>
         Энергия на бит E<sub>b</sub> ≈ <b>${isFinite(Ebit_J) ? (Ebit_J * 1e9).toFixed(2) : "-"}</b> нДж/бит<br/>
         Средняя мощность по времени P<sub>avg</sub> ≈ <b>${Pavg.toFixed(2)}</b> W<br/>
         Период орбиты ≈ <b>${(Torbit / 60).toFixed(1)}</b> мин<br/>
         Расход энергии за виток ≈ <b>${isFinite(Eorbit_Wh) ? Eorbit_Wh.toFixed(3) : "-"}</b> Wh`;
    }
  }

  // --- 12. Основной цикл: пересчёт mesh-сети ---

  clock.onTick.addEventListener(function (clockEvent) {
    if (!radioState.enabled) return;

    const time = clockEvent.currentTime;
    const seconds = Cesium.JulianDate.secondsDifference(time, startTime);

    if (seconds - radioState.lastUpdateSeconds < radioState.updatePeriodSec) return;
    radioState.lastUpdateSeconds = seconds;

    const sats = collectAllSatellites();
    const n = sats.length;

    if (n < 2) {
      clearRadioLinks();
      updateRadioMeshInfo("Нужно как минимум два КА для формирования радиосети.");
      radioState.lastAvgLinkDistKm = 0;
      updateSingleLinkAndEnergySummary();
      return;
    }

    const cfg = radioState.config;

    if (!radioState.drawLinks && radioState.linksByKey.size > 0) {
      clearRadioLinks();
    }

    let linksCount = 0;
    let snrMin = Number.POSITIVE_INFINITY;
    let snrMax = Number.NEGATIVE_INFINITY;
    let snrSum = 0;
    let snrSamples = 0;

    let distSumKm = 0;
    let distSamples = 0;
    let capacitySumMbps = 0;

    const maxNeigh = cfg.maxNeighborsPerSat || 0;
    const degrees = new Array(n).fill(0);
    const activeKeys = new Set();

    for (let i = 0; i < n; i++) {
      const satA = sats[i];
      const posA = satA.position.getValue(time);
      if (!posA) continue;

      for (let j = i + 1; j < n; j++) {
        const satB = sats[j];
        const posB = satB.position.getValue(time);
        if (!posB) continue;

        const evalRes = evaluateLink(posA, posB);
        if (!evalRes.linkUp) continue;

        if (maxNeigh > 0) {
          if (degrees[i] >= maxNeigh || degrees[j] >= maxNeigh) continue;
        }

        const key = makeLinkKey(satA.id, satB.id);
        activeKeys.add(key);

        linksCount++;
        degrees[i]++;
        degrees[j]++;

        if (isFinite(evalRes.snrDb)) {
          snrMin = Math.min(snrMin, evalRes.snrDb);
          snrMax = Math.max(snrMax, evalRes.snrDb);
          snrSum += evalRes.snrDb;
          snrSamples++;

          const capMbps = computeCapacityMbps(cfg, evalRes.snrDb);
          if (isFinite(capMbps)) capacitySumMbps += capMbps;
        }

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
    }

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

    let activeSatCount = 0;
    for (let i = 0; i < n; i++) {
      if (degrees[i] > 0) activeSatCount++;
    }

    const avgDegree =
      activeSatCount > 0 ? (2 * linksCount) / activeSatCount : 0;

    if (linksCount === 0) {
      updateRadioMeshInfo(
        "Активных радиолинков нет (нет пар КА, удовлетворяющих LoS / RxSens / SNR)."
      );
      updateSingleLinkAndEnergySummary();
      return;
    }

    updateRadioMeshInfo(
      `<b>Активных линков:</b> ${linksCount}<br/>
       <b>КА в сети:</b> ${activeSatCount} из ${n}<br/>
       <b>Средняя степень узла k:</b> ≈ ${avgDegree.toFixed(2)}<br/>
       <b>Средняя дальность линка:</b> ≈ ${isFinite(avgDistKm) ? avgDistKm.toFixed(1) : "-"} км<br/>
       <b>Оценочная суммарная пропускная способность сети:</b> ≈ ${isFinite(capacitySumMbps) ? capacitySumMbps.toFixed(1) : "-"} Мбит/с<br/>
       <b>SNR, dB:</b> min=${isFinite(snrMin) ? snrMin.toFixed(1) : "-"},
       avg=${isFinite(snrAvg) ? snrAvg.toFixed(1) : "-"},
       max=${isFinite(snrMax) ? snrMax.toFixed(1) : "-"}<br/>
       <small>Обновление топологии каждые ${radioState.updatePeriodSec.toFixed(1)} с.</small>`
    );

    updateSingleLinkAndEnergySummary();
  });
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
