// radio.js — модель радиосети между КА (mesh) на основе орбитального положения

// Предполагаем, что в app.js уже объявлены глобальные:
// const viewer, const clock = viewer.clock, const EARTH_RADIUS, const start, let orbitStore = [];

(function () {
  if (typeof viewer === "undefined" || typeof clock === "undefined") {
    console.error("radio.js: viewer/clock не найдены. Проверь порядок подключения скриптов.");
    return;
  }
  if (typeof orbitStore === "undefined" || typeof EARTH_RADIUS === "undefined" || typeof start === "undefined") {
    console.error("radio.js: orbitStore/EARTH_RADIUS/start не найдены.");
    return;
  }

  // --- Глобальное состояние радиосети ---
  const radioState = {
    enabled: false,
    config: {
      freqMHz: 2200,
      txPowerDbm: 30,
      gainTxDb: 5,
      gainRxDb: 5,
      rxSensDbm: -100,
      noiseFloorDbm: -110,
      minSnrDb: 5,
      maxRangeKm: 0 // 0 => не ограничиваем сверху, только радиофизика
    },
    lastUpdateSeconds: 0,
    updatePeriodSec: 3.0, // обновление mesh-сети раз в 3 секунды
    linksByKey: new Map() // key "satA|satB" -> Cesium.Entity
  };

  // --- Вспомогательные функции радиофизики ---

  // FSPL в дБ (формула: 32.44 + 20 log10(d_km) + 20 log10(f_MHz))
  function computeFsplDb(distanceMeters, freqMHz) {
    const dKm = distanceMeters / 1000.0;
    if (dKm <= 0) return 0;
    return 32.44 + 20 * Math.log10(dKm) + 20 * Math.log10(freqMHz);
  }

  // Проверка прямой видимости (LoS) между двумя точками, учитывая Землю как сферу
  function hasLineOfSightRadio(posA, posB) {
    const R = EARTH_RADIUS;

    const d = Cesium.Cartesian3.subtract(posB, posA, new Cesium.Cartesian3());
    const dLen2 = Cesium.Cartesian3.dot(d, d);
    if (dLen2 === 0) {
      return true; // одна точка
    }

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

  // Оценка параметров линка между двумя КА
  function evaluateLink(posA, posB) {
    const cfg = radioState.config;

    const distanceMeters = Cesium.Cartesian3.distance(posA, posB);
    const distanceKm = distanceMeters / 1000.0;

    // Ограничение по максимальной дальности (если задано)
    if (cfg.maxRangeKm > 0 && distanceKm > cfg.maxRangeKm) {
      return { linkUp: false, distanceKm };
    }

    // Проверяем LoS
    const los = hasLineOfSightRadio(posA, posB);
    if (!los) {
      return { linkUp: false, distanceKm, los: false };
    }

    const fsplDb = computeFsplDb(distanceMeters, cfg.freqMHz);

    // Простейшая модель: Rx = Tx + Gt + Gr - FSPL
    const rxPowerDbm = cfg.txPowerDbm + cfg.gainTxDb + cfg.gainRxDb - fsplDb;

    const snrDb = rxPowerDbm - cfg.noiseFloorDbm;

    // Нормальный режим: линк есть, если проходим по чувствительности и SNR
    const linkUp =
      rxPowerDbm >= cfg.rxSensDbm &&
      snrDb >= cfg.minSnrDb;

    return {
      linkUp,
      distanceKm,
      los: true,
      fsplDb,
      rxPowerDbm,
      snrDb
    };
  }

  // --- Работа с DOM правой панели ---

  const radioEnabledCheckbox = document.getElementById("radio-enabled");
  const radioForm = document.getElementById("radio-form");
  const radioMeshInfoEl = document.getElementById("radio-mesh-info");

  function updateRadioMeshInfo(textHtml) {
    if (!radioMeshInfoEl) return;
    radioMeshInfoEl.innerHTML = textHtml;
  }

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
          "<small>Ожидание расчёта mesh-сети...</small>"
        );
      }
    });
  }

  if (radioForm) {
    radioForm.addEventListener("submit", function (e) {
      e.preventDefault();

      const cfg = radioState.config;

      const freqInput = document.getElementById("radio-freq-mhz");
      const txInput = document.getElementById("radio-tx-power");
      const gTxInput = document.getElementById("radio-gain-tx");
      const gRxInput = document.getElementById("radio-gain-rx");
      const sensInput = document.getElementById("radio-rx-sens");
      const noiseInput = document.getElementById("radio-noise-floor");
      const snrInput = document.getElementById("radio-min-snr");
      const maxRangeInput = document.getElementById("radio-max-range-km");

      if (freqInput) cfg.freqMHz = parseFloat(freqInput.value) || cfg.freqMHz;
      if (txInput) cfg.txPowerDbm = parseFloat(txInput.value) || cfg.txPowerDbm;
      if (gTxInput) cfg.gainTxDb = parseFloat(gTxInput.value) || cfg.gainTxDb;
      if (gRxInput) cfg.gainRxDb = parseFloat(gRxInput.value) || cfg.gainRxDb;
      if (sensInput) cfg.rxSensDbm = parseFloat(sensInput.value) || cfg.rxSensDbm;
      if (noiseInput) cfg.noiseFloorDbm = parseFloat(noiseInput.value) || cfg.noiseFloorDbm;
      if (snrInput) cfg.minSnrDb = parseFloat(snrInput.value) || cfg.minSnrDb;

      if (maxRangeInput) {
        const v = parseFloat(maxRangeInput.value);
        cfg.maxRangeKm = isNaN(v) ? 0 : v;
      }

      updateRadioMeshInfo(
        `<b>Параметры обновлены.</b><br/>
         f = ${cfg.freqMHz} МГц, Tx = ${cfg.txPowerDbm} dBm, Gt = ${cfg.gainTxDb} dBi, Gr = ${cfg.gainRxDb} dBi<br/>
         RxSens = ${cfg.rxSensDbm} dBm, Noise = ${cfg.noiseFloorDbm} dBm, SNRmin = ${cfg.minSnrDb} dB<br/>
         MaxRange = ${cfg.maxRangeKm > 0 ? cfg.maxRangeKm + " км" : "не ограничена (по радиофизике)"}`
      );

      // Форсим перерасчёт сети при ближайшем тике
      radioState.lastUpdateSeconds = 0;
    });
  }

  // --- Управление визуальными линками в Cesium ---

  function clearRadioLinks() {
    for (const ent of radioState.linksByKey.values()) {
      viewer.entities.remove(ent);
    }
    radioState.linksByKey.clear();
  }

  function makeLinkKey(idA, idB) {
    const a = String(idA);
    const b = String(idB);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  function makeLinkMaterial(snrDb) {
    let color = Cesium.Color.LIME;
    if (isFinite(snrDb)) {
      if (snrDb < 5) {
        color = Cesium.Color.RED;
      } else if (snrDb < 10) {
        color = Cesium.Color.ORANGE;
      } else {
        color = Cesium.Color.LIME;
      }
    }
    return new Cesium.PolylineGlowMaterialProperty({
      glowPower: 0.15,
      taperPower: 0.0,
      color: color.withAlpha(0.7)
    });
  }

  // создаём entity для линка; линия “привязана” к КА через CallbackProperty,
  // поэтому плавно тянется за спутниками между обновлениями mesh-сети
  function createRadioLinkEntity(satA, satB, snrDb) {
    const positionsCallback = new Cesium.CallbackProperty(function (time, result) {
      const posA = satA.position.getValue(time);
      const posB = satB.position.getValue(time);
      if (!posA || !posB) return result || [];
      if (!result) {
        result = [posA, posB];
      } else {
        result.length = 0;
        result.push(posA, posB);
      }
      return result;
    }, false);

    const ent = viewer.entities.add({
      polyline: {
        positions: positionsCallback,
        width: 2.0,
        material: makeLinkMaterial(snrDb),
        clampToGround: false
      },
      properties: {
        isRadioLink: true,
        snrDb: snrDb
      }
    });

    return ent;
  }

  function updateRadioLinkVisual(ent, snrDb) {
    if (!ent || !ent.polyline) return;
    ent.polyline.material = makeLinkMaterial(snrDb);
    if (!ent.properties) return;
    ent.properties.snrDb = snrDb;
  }

  // --- Сбор всех спутников из orbitStore ---

  function collectAllSatellites() {
    const sats = [];
    orbitStore.forEach((group) => {
      group.satellites.forEach((sat) => {
        sats.push(sat);
      });
    });
    return sats;
  }

  // --- Основной цикл обновления mesh-сети по времени ---

  clock.onTick.addEventListener(function (clk) {
    if (!radioState.enabled) return;

    const time = clk.currentTime;
    const seconds = Cesium.JulianDate.secondsDifference(time, start);

    if (seconds - radioState.lastUpdateSeconds < radioState.updatePeriodSec) {
      return;
    }
    radioState.lastUpdateSeconds = seconds;

    const sats = collectAllSatellites();
    const n = sats.length;

    if (n < 2) {
      clearRadioLinks();
      updateRadioMeshInfo(
        "<b>Активных линков:</b> 0<br/>" +
        `<b>КА в сети:</b> ${n}<br/>` +
        "<b>SNR, dB:</b> -<br/>" +
        `<small>Обновление топологии каждые ${radioState.updatePeriodSec.toFixed(1)} с.</small>`
      );
      return;
    }

    let linksCount = 0;
    let snrMin = Number.POSITIVE_INFINITY;
    let snrMax = Number.NEGATIVE_INFINITY;
    let snrSum = 0;
    let snrSamples = 0;

    const activeKeys = new Set();

    // Перебираем все пары (i < j)
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

        const key = makeLinkKey(satA.id, satB.id);
        activeKeys.add(key);

        linksCount++;

        if (isFinite(evalRes.snrDb)) {
          snrMin = Math.min(snrMin, evalRes.snrDb);
          snrMax = Math.max(snrMax, evalRes.snrDb);
          snrSum += evalRes.snrDb;
          snrSamples++;
        }

        let ent = radioState.linksByKey.get(key);
        if (!ent) {
          ent = createRadioLinkEntity(satA, satB, evalRes.snrDb);
          radioState.linksByKey.set(key, ent);
        } else {
          updateRadioLinkVisual(ent, evalRes.snrDb);
        }
      }
    }

    // Удаляем устаревшие линки (которые больше не активны)
    for (const [key, ent] of radioState.linksByKey.entries()) {
      if (!activeKeys.has(key)) {
        viewer.entities.remove(ent);
        radioState.linksByKey.delete(key);
      }
    }

    const snrAvg = snrSamples > 0 ? snrSum / snrSamples : NaN;

    updateRadioMeshInfo(
      `<b>Активных линков:</b> ${linksCount}<br/>
       <b>КА в сети:</b> ${n}<br/>
       <b>SNR, dB:</b> min=${linksCount > 0 && isFinite(snrMin) ? snrMin.toFixed(1) : "-"}, 
       avg=${linksCount > 0 && isFinite(snrAvg) ? snrAvg.toFixed(1) : "-"}, 
       max=${linksCount > 0 && isFinite(snrMax) ? snrMax.toFixed(1) : "-"}<br/>
       <small>Обновление топологии каждые ${radioState.updatePeriodSec.toFixed(1)} с.</small>`
    );
  });

})();

// --- КНОПКА ПОКАЗАТЬ / СКРЫТЬ ПАНЕЛЬ ---
const radioPanel = document.getElementById("radio-panel");
const radioToggle = document.getElementById("radio-toggle");

if (radioPanel && radioToggle) {
  radioToggle.addEventListener("click", () => {
    const hidden = radioPanel.classList.toggle("hidden");
    radioToggle.textContent = hidden ? "▲ Радио" : "▼ Радио";
  });
}
