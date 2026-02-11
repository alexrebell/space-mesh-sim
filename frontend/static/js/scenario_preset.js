// scenario_preset.js
// Добавляет кнопку "Задать сценарий" в тулбар Cesium.
// По нажатию автоматически:
// 1) создаёт массив орбит (900 км, 20 орбит × 20 КА, равномерно, skip polar),
// 2) добавляет MIS-орбиту (450 км, i=61°, 20 КА),
// 3) включает радиосеть с выбранными опциями и профилем ФАР B (throughput),
// 4) жмёт "Применить параметры" для радиосети.

(function () {
  const BUTTON_ID = "spaceMeshScenarioButton";

  function setValue(id, val) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function setChecked(id, on = true) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.checked = !!on;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function setSelect(id, value) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function submitForm(id) {
    const form = document.getElementById(id);
    if (!form) return false;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return true;
  }

  function applyScenario() {
    // 1) Орбиты и КА (массовое создание)
    setValue("bulk-altitude", 900);
    setValue("bulk-num-sats", 30);
    setChecked("bulk-even-spacing", true);
    setValue("bulk-phase-step", 0);
    setValue("bulk-num-orbits", 20);
    setChecked("bulk-skip-polar", true);
    submitForm("bulk-orbits-form");

    // 2) КА заданий (MIS)
    setValue("mission-orbit-name", "MIS-LEO-450");
    setValue("mission-altitude", 450);
    setValue("mission-inclination", 61);
    setValue("mission-num-sats", 30);
    submitForm("mission-form");

    // 3) Радиосеть КА
    setChecked("radio-enabled", true);
    setChecked("radio-draw-links", true);
    setChecked("radio-limit-min-distance", true);
    setSelect("radio-antenna-type", "phased");
    setSelect("radio-phased-profile", "B"); // профиль B — throughput
    submitForm("radio-form");
  }

  function addButtonWhenReady() {
    const toolbar = document.querySelector(".cesium-viewer-toolbar");
    const homeBtn = document.querySelector(".cesium-home-button");
    if (!toolbar || !homeBtn || !window.spaceMesh?.viewer) {
      requestAnimationFrame(addButtonWhenReady);
      return;
    }

    if (document.getElementById(BUTTON_ID)) return; // уже добавлена

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.className = "cesium-button cesium-toolbar-button";
    btn.type = "button";
    btn.title = "Задать сценарий";
    btn.textContent = "🚀 Задать сценарий";

    toolbar.insertBefore(btn, homeBtn); // слева от «Домой»

    btn.addEventListener("click", () => {
      try {
        applyScenario();
      } catch (e) {
        console.error("Scenario preset failed:", e);
      }
    });
  }

  // Запуск после загрузки
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addButtonWhenReady);
  } else {
    addButtonWhenReady();
  }
})();
