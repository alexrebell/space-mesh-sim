# Space Mesh Simulator

## Настройка окружения

### Установка Cesium

Для работы проекта необходим CesiumJS. Так как файлы Cesium слишком большие для Git, их нужно скачать отдельно:

1. **Скачайте Cesium** с официального репозитория:
   - Перейдите по ссылке: [https://github.com/CesiumGS/cesium/releases/download/1.136/Cesium-1.136.zip](https://github.com/CesiumGS/cesium/releases/download/1.136/Cesium-1.136.zip)

2. **Распакуйте архив**:
   - Распакуйте скачанный `Cesium-1.136.zip`
   - Переименуйте полученную папку `Cesium-1.136` в `Cesium`

3. **Разместите в проекте**:
   - Поместите папку `Cesium` в директорию: `frontend/static/`
   - Итоговый путь должен быть: `frontend/static/Cesium/`

4. **Проверьте структуру**:
   - В папке `frontend/static/Cesium/` должны находиться:
     - `Build/` - скомпилированные файлы Cesium
     - `Source/` - исходный код (если есть)
     - `ThirdParty/` - сторонние зависимости
     - `package.json` и другие конфигурационные файлы

### Альтернативный способ (через CDN)

Если не хотите скачивать Cesium локально, можно использовать CDN. Обновите ссылки в HTML-файлах:

```html
<!-- Вместо локальных ссылок на /static/Cesium/ -->
<script src="https://cesium.com/downloads/cesiumjs/releases/1.136/Build/Cesium/Cesium.js"></script>
<link rel="stylesheet" href="https://cesium.com/downloads/cesiumjs/releases/1.136/Build/Cesium/Widgets/widgets.css">