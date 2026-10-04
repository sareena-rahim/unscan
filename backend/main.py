import io
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytesseract
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pdf2image import convert_from_bytes, pdfinfo_from_bytes
from pdf2image.exceptions import PDFInfoNotInstalledError
from PIL import Image
from pypdf import PdfReader, PdfWriter
from pytesseract import TesseractNotFoundError

MAX_MB = int(os.getenv("MAX_MB", "50"))
MAX_PAGES = int(os.getenv("MAX_PAGES", "60"))
MAX_PARALLEL_JOBS = int(os.getenv("MAX_PARALLEL_JOBS", "1"))  # extra jobs wait in the queue
JOB_TTL = 30 * 60  # seconds a finished job is kept before cleanup
DPI = 200
CHUNK = 4  # pages rasterized and OCR'd at a time, keeps memory low
ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:5173"
).split(",")

app = FastAPI(title="Unscan API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)

# In-memory job store. Fine for a single server process (run uvicorn with 1 worker).
jobs: dict[str, dict] = {}
job_runner = ThreadPoolExecutor(max_workers=MAX_PARALLEL_JOBS)

@app.get("/")
def health():
    return {"status": "ok"}


def ocr_page(img: Image.Image) -> bytes:
    """OCR one page image -> single-page PDF (image + invisible text layer)."""
    buf = io.BytesIO()
    img.convert("L").save(buf, format="JPEG", quality=60)  # keeps output small
    buf.seek(0)
    jpeg = Image.open(buf)  # format stays JPEG, so tesseract embeds the JPEG
    return pytesseract.image_to_pdf_or_hocr(
        jpeg, extension="pdf", lang="eng", config="--psm 4"
    )


def friendly_error(e: Exception) -> str:
    if isinstance(e, TesseractNotFoundError):
        return "Server setup problem: Tesseract is not installed or not on PATH."
    if isinstance(e, PDFInfoNotInstalledError):
        return "Server setup problem: Poppler is not installed or not on PATH."
    return f"Conversion failed: {e}"


def run_job(job_id: str, data: bytes) -> None:
    job = jobs[job_id]
    job["status"] = "processing"
    try:
        writer = PdfWriter()
        total = job["total"]
        with ThreadPoolExecutor(max_workers=CHUNK) as pool:  # tesseract runs as a subprocess
            for start in range(1, total + 1, CHUNK):
                end = min(start + CHUNK - 1, total)
                images = convert_from_bytes(data, dpi=DPI, first_page=start, last_page=end)
                for page_pdf in pool.map(ocr_page, images):
                    writer.add_page(PdfReader(io.BytesIO(page_pdf)).pages[0])
                    job["page"] += 1
                del images
        out = io.BytesIO()
        writer.write(out)
        job["result"] = out.getvalue()
        job["status"] = "done"
    except Exception as e:  # report any failure to the client instead of hanging
        job["status"] = "error"
        job["error"] = friendly_error(e)
    finally:
        job["finished_at"] = time.time()


def cleanup_jobs() -> None:
    now = time.time()
    for jid in [j for j, v in jobs.items() if v.get("finished_at") and now - v["finished_at"] > JOB_TTL]:
        jobs.pop(jid, None)


@app.post("/api/jobs")
def create_job(file: UploadFile = File(...)):
    if file.content_type != "application/pdf":
        raise HTTPException(400, "Please upload a PDF file.")
    data = file.file.read()
    if len(data) > MAX_MB * 1024 * 1024:
        raise HTTPException(413, f"File too large (max {MAX_MB} MB).")

    try:
        total = pdfinfo_from_bytes(data)["Pages"]
    except PDFInfoNotInstalledError:
        raise HTTPException(500, friendly_error(PDFInfoNotInstalledError()))
    except Exception:
        raise HTTPException(400, "Could not read this PDF.")
    if total > MAX_PAGES:
        raise HTTPException(413, f"Too many pages (max {MAX_PAGES}).")

    cleanup_jobs()
    job_id = uuid.uuid4().hex
    name = (file.filename or "document.pdf").rsplit(".", 1)[0] + "_searchable.pdf"
    jobs[job_id] = {
        "status": "queued",
        "page": 0,
        "total": total,
        "error": None,
        "result": None,
        "name": name,
        "finished_at": None,
    }
    job_runner.submit(run_job, job_id, data)
    return {"job_id": job_id, "total": total}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found. It may have expired or the server restarted.")
    return {k: job[k] for k in ("status", "page", "total", "error")}


@app.get("/api/jobs/{job_id}/result")
def job_result(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found. It may have expired or the server restarted.")
    if job["status"] != "done":
        raise HTTPException(409, "Result is not ready yet.")
    return Response(
        job["result"],
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{job["name"]}"'},
    )