// static/js/ground_stations.js
(function () {
  if (typeof Cesium === "undefined") return;
  if (!window.spaceMesh || !window.spaceMesh.viewer) return;

  const viewer = window.spaceMesh.viewer;

  // --- UI панель станций (уже в index.html) ---
  const ui = {
    panel: document.getElementById("ground-panel"),
    toggle: document.getElementById("ground-toggle"),
    clear: document.getElementById("ground-clear"),
    title: document.getElementById("ground-title"),
    details: document.getElementById("ground-station-details"),
    radar: document.getElementById("ground-radar"),
    minEl: document.getElementById("ground-minel"),
    count: document.getElementById("ground-count"),
    sats: document.getElementById("ground-sats"),
    passCurrent: document.getElementById("ground-pass-current"),
    passEndsin: document.getElementById("ground-pass-endsin"),
    passNext: document.getElementById("ground-pass-next"),

    fspl: document.getElementById("ground-fspl"),
    rx: document.getElementById("ground-rx"),
    snr: document.getElementById("ground-snr"),

  };

  function setPanelVisible(on) {
    if (!ui.panel) return;
    ui.panel.classList.toggle("hidden", !on);
  }

  // ---------- SVG треугольник ----------
  function makeTriangleDataUri(fill) {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
      `<path d="M32 6 L58 54 H6 Z" fill="${fill}" stroke="white" stroke-width="3"/>` +
      `</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  const TRIANGLE_URI = makeTriangleDataUri("#00f6ff");

  // ---------- az/el/range ----------
  function computeAzElRange(gsPos, satPos) {
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(gsPos);
    const inv = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());

    const rel = Cesium.Cartesian3.subtract(satPos, gsPos, new Cesium.Cartesian3());
    const rel4 = new Cesium.Cartesian4(rel.x, rel.y, rel.z, 0.0);
    const enu4 = Cesium.Matrix4.multiplyByVector(inv, rel4, new Cesium.Cartesian4());

    const e = enu4.x, n = enu4.y, u = enu4.z;
    const horiz = Math.sqrt(e * e + n * n);
    const range = Math.sqrt(horiz * horiz + u * u);

    let az = Math.atan2(e, n);
    if (az < 0) az += 2 * Math.PI;

    const el = Math.atan2(u, horiz);

    return {
      range_m: range,
      az_deg: Cesium.Math.toDegrees(az),
      el_deg: Cesium.Math.toDegrees(el)
    };
  }

  function isSatellite(ent, time) {
    const p = ent?.properties?.isSatellite;
    if (!p) return false;
    return typeof p.getValue === "function" ? !!p.getValue(time) : !!p;
  }

  function getSatMeta(ent, time) {
    const orbitName =
      ent.properties?.orbitName?.getValue?.(time) ?? ent.properties?.orbitName ?? "Shell";
    const incl =
      ent.properties?.inclinationDeg?.getValue?.(time) ?? ent.properties?.inclinationDeg;
    return { orbitName: String(orbitName || "Shell"), inclDeg: Number(incl ?? NaN) };
  }

  // ---------- подсветка ----------
  function ensureOrigStyle(ent) {
    if (ent._gsOrigStyle || !ent.point) return;
    const pt = ent.point;
    ent._gsOrigStyle = {
      pixelSize: pt.pixelSize,
      outlineWidth: pt.outlineWidth,
      outlineColor: pt.outlineColor
    };
  }

  function setHighlighted(ent, on) {
    if (!ent.point) return;
    ensureOrigStyle(ent);

    if (on) {
      ent.point.pixelSize = 12;
      ent.point.outlineWidth = 3;
      ent.point.outlineColor = Cesium.Color.RED;
    } else if (ent._gsOrigStyle) {
      ent.point.pixelSize = ent._gsOrigStyle.pixelSize ?? 8;
      ent.point.outlineWidth = ent._gsOrigStyle.outlineWidth ?? 1;
      ent.point.outlineColor = ent._gsOrigStyle.outlineColor ?? Cesium.Color.WHITE;
    }
  }

  // ---------- радар ----------
  function drawRadar(canvas, sats, minElDeg) {
    const ctx = canvas?.getContext?.("2d");
    if (!ctx) return;

    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.46;

    ctx.clearRect(0, 0, w, h);

    // сетка
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 1;
    for (let k = 1; k <= 4; k++) {
      ctx.beginPath();
      ctx.arc(cx, cy, (R * k) / 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    // N/E/S/W
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", cx, cy - R - 10);
    ctx.fillText("S", cx, cy + R + 10);
    ctx.fillText("E", cx + R + 10, cy);
    ctx.fillText("W", cx - R - 10, cy);

    // окружность порога minEl
    const clampMinEl = Math.max(0, Math.min(89.9, minElDeg));
    const rMin = (90 - clampMinEl) / 90;
    ctx.strokeStyle = "rgba(0,246,255,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R * rMin, 0, Math.PI * 2);
    ctx.stroke();

// точки КА + подписи
for (const s of sats) {
  const az = Cesium.Math.toRadians(s.az_deg);
  const rr = (90 - s.el_deg) / 90;
  const r = Math.min(R, Math.max(0, rr * R));

  const x = cx + r * Math.sin(az);
  const y = cy - r * Math.cos(az);

  // точка
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = "rgba(255,215,0,0.95)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(x, y, 5.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // подпись КА
  ctx.font = "10px monospace";
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  // Из имени "КА #5" берём "#5"
  const label = (s.name || "").replace(/^.*?(#\d+)/, "$1") || s.id;

  ctx.fillText(label, x + 8, y);
}

  }

  // ---------- состояние ----------
  const gsState = {
    entities: [],
    byId: new Map(),
    selectedStation: null,
    highlighted: new Set()
  };

  function clearHighlights() {
    for (const id of gsState.highlighted) {
      const ent = viewer.entities.getById(id);
      if (ent) setHighlighted(ent, false);
    }
    gsState.highlighted.clear();
  }

  function resetPanelUI() {
    if (ui.title) ui.title.textContent = "Не выбрана";
    if (ui.minEl) ui.minEl.textContent = "—";
    if (ui.count) ui.count.textContent = "0";

        if (ui.passCurrent) ui.passCurrent.textContent = "—";
    if (ui.passEndsin) ui.passEndsin.textContent = "—";
    if (ui.passNext) ui.passNext.textContent = "—";

    if (ui.fspl) ui.fspl.textContent = "—";
    if (ui.rx) ui.rx.textContent = "—";
    if (ui.snr) ui.snr.textContent = "—";


    if (ui.details) {
      ui.details.innerHTML = `<div style="opacity:.75;">Станция не выбрана.</div>`;
    }

    if (ui.sats) {
      ui.sats.innerHTML = `<div style="opacity:.75;">Выберите наземную станцию на карте…</div>`;
    }

    if (ui.radar) {
      // очистим радар (просто сетку без точек)
      drawRadar(ui.radar, [], 10);
    }
  }

    function fmtHMS(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hh = String(Math.floor(s / 3600)).padStart(2, "0");
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function fmtClock(time) {
    const d = Cesium.JulianDate.toDate(time);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function fsplDb(d_km, f_mhz) {
    // FSPL(dB) = 32.44 + 20log10(d_km) + 20log10(f_MHz)
    if (!(d_km > 0) || !(f_mhz > 0)) return NaN;
    return 32.44 + 20 * Math.log10(d_km) + 20 * Math.log10(f_mhz);
  }

  function noiseFloorDbm_kTB(T_k, B_hz) {
    // N(dBm) = -174 dBm/Hz + 10log10(B) + 10log10(T/290)
    if (!(T_k > 0) || !(B_hz > 0)) return NaN;
    return -174 + 10 * Math.log10(B_hz) + 10 * Math.log10(T_k / 290);
  }


  function updateSelectedStationUI(time) {
    const stEnt = gsState.selectedStation;

    if (!stEnt) {
      clearHighlights();
      resetPanelUI();
      return;
    }

    const gsPos = stEnt.position?.getValue(time);
    if (!gsPos) return;

    const carto = Cesium.Cartographic.fromCartesian(gsPos);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    const alt = carto.height || 0;

    const minElDeg = stEnt.properties?.minElevationDeg?.getValue?.(time) ?? 10;
    const azCovDeg = stEnt.properties?.azimuthCoverageDeg?.getValue?.(time) ?? 360;

    // Заголовок: Наземная станция: Москва (55.7558, 37.6173)
    if (ui.title) {
      ui.title.textContent = `${stEnt.name} (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
    }
    if (ui.minEl) ui.minEl.textContent = `${minElDeg.toFixed(0)}°`;

    if (ui.details) {
      // “подробная информация о станции”
      ui.details.innerHTML = `
        <div><b>ID:</b> ${String(stEnt.properties?.stationId?.getValue?.(time) ?? "—")}</div>
        <div><b>Координаты:</b> ${lat.toFixed(4)}°, ${lon.toFixed(4)}°</div>
        <div><b>Высота:</b> ${alt.toFixed(0)} м</div>
        <div><b>Порог El:</b> ${minElDeg.toFixed(0)}° (сеанс связи при El ≥ порога)</div>
        <div><b>Азимутальное покрытие:</b> ${azCovDeg.toFixed(0)}°</div>
      `;
    }

    const visible = [];
    const all = viewer.entities.values;

    for (let i = 0; i < all.length; i++) {
      const sat = all[i];

      // 1. Только спутники
      if (!isSatellite(sat, time)) continue;

      // 2. ЖЁСТКО исключаем MIS-КА
      const isMission =
        sat.properties?.isMissionSatellite?.getValue?.(time) ??
        sat.properties?.isMissionSatellite;

      if (isMission === true) continue;

      const satPos = sat.position?.getValue(time);
      if (!satPos) continue;

      const geom = computeAzElRange(gsPos, satPos); // <-- ВОТ ТУТ "ГЕОМЕТРИЯ ВИДИМОСТИ" относительно станции
      if (geom.el_deg < minElDeg) continue;  // <-- ВОТ ТУТ РЕШЕНИЕ "ВИДИТ / НЕ ВИДИТ"

      const meta = getSatMeta(sat, time);
      visible.push({
        id: sat.id,
        name: sat.name || "КА",
        range_km: geom.range_m / 1000,
        az_deg: geom.az_deg,
        el_deg: geom.el_deg,
        orbitName: meta.orbitName,
        inclText: Number.isFinite(meta.inclDeg) ? meta.inclDeg.toFixed(1) : "—"
      });
    }

    visible.sort((a, b) => b.el_deg - a.el_deg);

    if (ui.count) ui.count.textContent = String(visible.length);

    // подсветка на глобусе
    clearHighlights();
    for (const s of visible) {
      const ent = viewer.entities.getById(s.id);
      if (ent) {
        setHighlighted(ent, true);
        gsState.highlighted.add(s.id);
      }
    }

// --- Радио-метрики (из radio.js профиля) ---
const radioApi = window.spaceMesh?.radio;
let fsplMin = +Infinity, fsplMax = -Infinity;
let rxBest = -Infinity, rxWorst = +Infinity;
let snrBest = -Infinity, snrWorst = +Infinity;

if (radioApi?.computeBudgetForDistanceMeters) {
  for (const s of visible) {
    const res = radioApi.computeBudgetForDistanceMeters(s.range_km * 1000);
    if (!Number.isFinite(res?.fsplDb)) continue;

    fsplMin = Math.min(fsplMin, res.fsplDb);
    fsplMax = Math.max(fsplMax, res.fsplDb);

    rxBest  = Math.max(rxBest,  res.rxPowerDbm);
    rxWorst = Math.min(rxWorst, res.rxPowerDbm);

    snrBest  = Math.max(snrBest,  res.snrDb);
    snrWorst = Math.min(snrWorst, res.snrDb);
  }
} else {
  // fallback (если radio.js не загружен) — можно оставить старую логику или просто “—”
}

if (ui.fspl) ui.fspl.textContent =
  (visible.length && Number.isFinite(fsplMin)) ? `${fsplMin.toFixed(1)}…${fsplMax.toFixed(1)} dB` : "—";

if (ui.rx) ui.rx.textContent =
  (visible.length && Number.isFinite(rxBest)) ? `${rxBest.toFixed(1)}…${rxWorst.toFixed(1)} dBm` : "—";

if (ui.snr) ui.snr.textContent =
  (visible.length && Number.isFinite(snrBest)) ? `${snrBest.toFixed(1)}…${snrWorst.toFixed(1)} dB` : "—";


        // --- Временные окна связи (дорого: скан вперёд) ---
    // Чтобы не грузить каждый тик — считаем раз в 1 секунду
    if (!gsState._lastPassCalc || Cesium.JulianDate.secondsDifference(time, gsState._lastPassCalc) >= 10) {
      gsState._lastPassCalc = Cesium.JulianDate.clone(time);

      const res = scanPassWindows(stEnt, time);

      if (ui.passCurrent) {
        ui.passCurrent.textContent = res.inNow
          ? `${fmtClock(time)} → ${res.passEnd ? fmtClock(res.passEnd) : "—"}`
          : "нет";
      }

      if (ui.passEndsin) {
        ui.passEndsin.textContent = (res.inNow && res.passEnd)
          ? fmtHMS(Cesium.JulianDate.secondsDifference(res.passEnd, time))
          : "—";
      }

      if (ui.passNext) {
        ui.passNext.textContent = res.nextStart
          ? `${fmtClock(res.nextStart)} → ${res.nextEnd ? fmtClock(res.nextEnd) : "—"}`
          : "не найдено (горизонт 3ч)";
      }
    }

    // радар + список
    if (ui.radar) drawRadar(ui.radar, visible, minElDeg);

    if (ui.sats) {
      if (visible.length === 0) {
        ui.sats.innerHTML = `<div style="opacity:.75;">Нет КА в зоне (El &lt; ${minElDeg.toFixed(0)}°).</div>`;
      } else {
        ui.sats.innerHTML = visible.map((s) => {
          const shell = /i\s*=\s*[-\d.]+/i.test(s.orbitName)
          ? s.orbitName
          : `${s.orbitName} i=${s.inclText}°`;
          return `
            <div class="item">
              <b>${s.name}</b>
              ${s.range_km.toFixed(0)} км · ${shell} · Az ${s.az_deg.toFixed(0)}° · El ${s.el_deg.toFixed(0)}°
            </div>
          `;
        }).join("");
      }
    }
  }

    function hasAnyVisibleSatelliteAtTime(stEnt, t) {
    const gsPos = stEnt.position?.getValue(t);
    if (!gsPos) return false;

    const minElDeg = stEnt.properties?.minElevationDeg?.getValue?.(t) ?? 10;
    const all = viewer.entities.values;

    for (let i = 0; i < all.length; i++) {
      const sat = all[i];
      if (!isSatellite(sat, t)) continue;

      // исключаем MIS-КА
      const isMission =
        sat.properties?.isMissionSatellite?.getValue?.(t) ??
        sat.properties?.isMissionSatellite;

      if (isMission === true) continue;

      const satPos = sat.position?.getValue(t);
      if (!satPos) continue;

      const geom = computeAzElRange(gsPos, satPos);
      if (geom.el_deg >= minElDeg) return true;
    }
    return false;
  }

  function scanPassWindows(stEnt, timeNow) {
    const STEP = 30;            // секунд
    const HORIZON = 30 * 60;   // 30 минут вперёд

    const inNow = hasAnyVisibleSatelliteAtTime(stEnt, timeNow);

    let passEnd = null;
    if (inNow) {
      for (let dt = STEP; dt <= HORIZON; dt += STEP) {
        const t = Cesium.JulianDate.addSeconds(timeNow, dt, new Cesium.JulianDate());
        if (!hasAnyVisibleSatelliteAtTime(stEnt, t)) { passEnd = t; break; }
      }
    }

    let nextStart = null, nextEnd = null;
    const base = passEnd ? Cesium.JulianDate.clone(passEnd) : Cesium.JulianDate.clone(timeNow);

    for (let dt = STEP; dt <= HORIZON; dt += STEP) {
      const t = Cesium.JulianDate.addSeconds(base, dt, new Cesium.JulianDate());
      if (hasAnyVisibleSatelliteAtTime(stEnt, t)) { nextStart = t; break; }
    }
    if (nextStart) {
      for (let dt = STEP; dt <= HORIZON; dt += STEP) {
        const t = Cesium.JulianDate.addSeconds(nextStart, dt, new Cesium.JulianDate());
        if (!hasAnyVisibleSatelliteAtTime(stEnt, t)) { nextEnd = t; break; }
      }
    }

    return { inNow, passEnd, nextStart, nextEnd };
  }


  function makeDraggable(panelEl, handleEl, storageKey = "groundPanelPos") {
  if (!panelEl || !handleEl) return;

  // восстановить позицию
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
      panelEl.style.left = saved.left + "px";
      panelEl.style.top = saved.top + "px";
    }
  } catch {}

  let dragging = false;
  let startX = 0, startY = 0;
  let startLeft = 0, startTop = 0;

  handleEl.addEventListener("pointerdown", (e) => {
    // чтобы не конфликтовать с кнопкой "Сбросить"
    if (e.target && e.target.closest && e.target.closest("button")) return;

    dragging = true;
    handleEl.setPointerCapture(e.pointerId);

    const rect = panelEl.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;

    // фиксируем позиционирование через left/top
    panelEl.style.left = rect.left + "px";
    panelEl.style.top = rect.top + "px";
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
  });

  handleEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    // ограничение в пределах окна
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

  function stopDrag(e) {
    if (!dragging) return;
    dragging = false;

    // сохранить позицию
    const rect = panelEl.getBoundingClientRect();
    localStorage.setItem(storageKey, JSON.stringify({ left: rect.left, top: rect.top }));
  }

  handleEl.addEventListener("pointerup", stopDrag);
  handleEl.addEventListener("pointercancel", stopDrag);
}

// включаем перетаскивание: панель тащим за ground-header
const groundHeader = ui.panel?.querySelector?.(".ground-header");
makeDraggable(ui.panel, groundHeader, "groundPanelPos");


function addStationEntity(st) {
  // Позиция как CallbackProperty — пересчитывается каждый кадр/рендер,
  // и не “плывёт” после morphTo2D / morphTo3D.
  const position = new Cesium.CallbackProperty(function (time, result) {
    return Cesium.Cartesian3.fromDegrees(
      st.lon,
      st.lat,
      st.alt_m || 0,
      Cesium.Ellipsoid.WGS84,
      result
    );
  }, false);

  const ent = viewer.entities.add({
    id: `GS:${st.id}`,
    name: `Наземная станция: ${st.name}`,
    position,

    billboard: {
      image: TRIANGLE_URI,
      width: 18,
      height: 18,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,

      // ВАЖНО: убираем CLAMP_TO_GROUND
      heightReference: Cesium.HeightReference.NONE,

      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },

    label: {
      text: st.name,
      font: "12px sans-serif",
      showBackground: true,
      backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
      pixelOffset: new Cesium.Cartesian2(0, -22),
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,

      // ВАЖНО: убираем CLAMP_TO_GROUND
      heightReference: Cesium.HeightReference.NONE,

      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },

    properties: {
      kind: "ground_station",
      stationId: st.id,
      minElevationDeg: st.min_elevation_deg ?? 10,
      azimuthCoverageDeg: st.azimuth_coverage_deg ?? 360,

      // полезно хранить исходные координаты
      lon: st.lon,
      lat: st.lat,
      alt_m: st.alt_m || 0
    }
  });

  gsState.entities.push(ent);
  gsState.byId.set(st.id, ent);
}


  async function loadStations() {
    const resp = await fetch("/static/data/ground_stations_ru.json", { cache: "no-store" });
    const data = await resp.json();
    const list = data?.stations ?? [];
    for (const st of list) addStationEntity(st);
    window.spaceMesh.groundStations = gsState;
  }

  // --- UI events ---
if (ui.toggle && ui.panel) {
  ui.toggle.addEventListener("click", () => {
    const hidden = ui.panel.classList.toggle("hidden");
    ui.toggle.textContent = hidden ? "▲ Станции" : "▼ Станции";
  });
}

  if (ui.clear) {
    ui.clear.addEventListener("click", () => {
      viewer.selectedEntity = undefined;   // сброс выбора
      gsState.selectedStation = null;      // обязательно сбросить состояние
      clearHighlights();
      resetPanelUI();
    });
  }

// выбор станции: "закрепляем" выбранную станцию и НЕ сбрасываем её,
// если пользователь выбирает КА или кликает в пустое место.
viewer.selectedEntityChanged.addEventListener((ent) => {
  const t = viewer.clock.currentTime;
  const kind = ent?.properties?.kind?.getValue?.(t);

  if (kind === "ground_station") {
    gsState.selectedStation = ent;
    setPanelVisible(true);
    updateSelectedStationUI(t);
    return;
  }

  // ВАЖНО:
  // - если выбрали КА -> selectedEntity станет КА, но панель станции НЕ очищаем
  // - если кликнули в пустое место -> ent будет undefined/null, тоже НЕ очищаем
  // Сброс станции делается только кнопкой "Сбросить" (ground-clear).
});


  // обновление каждый тик
  viewer.clock.onTick.addEventListener((clock) => {
    updateSelectedStationUI(clock.currentTime);
  });
  viewer.scene.morphComplete.addEventListener(function () {
  viewer.scene.requestRender();
});

  resetPanelUI();
  loadStations().catch(console.error);
})();
