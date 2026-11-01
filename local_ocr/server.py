"""Local CPU OCR. Binds to loopback; no files or text are sent to an external service."""
import base64
import threading
import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from rapidocr_onnxruntime import RapidOCR
from pydantic import BaseModel, Field

app = FastAPI(docs_url=None, redoc_url=None)
engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=2)
lock = threading.Lock()

class ImageInput(BaseModel):
    image: str = Field(max_length=28_000_000)

@app.get('/health')
def health():
    return {'ready': True, 'engine': 'RapidOCR / PP-OCR ONNX CPU', 'local': True}

@app.post('/recognize')
async def recognize(payload: ImageInput, request: Request):
    if request.headers.get('origin') not in (None, 'http://127.0.0.1:5173', 'http://localhost:5173'):
        raise HTTPException(403, 'Origin not allowed')
    try:
        encoded = payload.image.split(',', 1)[1]
        image = cv2.imdecode(np.frombuffer(base64.b64decode(encoded, validate=True), np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.shape[0]*image.shape[1] > 24_000_000:
            raise ValueError('Invalid image dimensions')
    except Exception:
        raise HTTPException(400, 'Invalid image')
    # Run CPU work off the ASGI event loop. Requests serialize to limit RAM use.
    import asyncio
    def run():
        with lock:
            scale = min(3.0, max(1.0, 2400 / image.shape[1]))
            scaled = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            result, _ = engine(scaled, use_cls=False)
        words = []
        for points, text, score in result or []:
            x = min(p[0] for p in points)/scale
            y = min(p[1] for p in points)/scale
            width = (max(p[0] for p in points)-min(p[0] for p in points))/scale
            height = (max(p[1] for p in points)-min(p[1] for p in points))/scale
            words.append(dict(text=text, x=x, y=y, width=width, height=height, confidence=float(score)*100))
        return {'words': words, 'engine': 'RapidOCR / PP-OCR ONNX CPU'}
    return await asyncio.to_thread(run)
