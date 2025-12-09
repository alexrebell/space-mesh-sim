from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import os

app = FastAPI(
    title="Space Mesh Simulator API",
    version="0.1.0"
)

# Путь к статическим файлам
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "..", "frontend", "static")
STATIC_DIR = os.path.abspath(STATIC_DIR)

# Раздача статических файлов (CSS, JS)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# Главная страница
@app.get("/")
def root():
    index_path = os.path.join(STATIC_DIR, "index.html")
    return FileResponse(index_path)


@app.get("/health")
def health_check():
    return {"status": "ok"}
