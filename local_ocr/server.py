"""Local CPU OCR. Binds to loopback; no files or text are sent to an external service."""
import base64
import os
import secrets
import threading
import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from rapidocr_onnxruntime import RapidOCR
from pydantic import BaseModel, Field

app = FastAPI(docs_url=None, redoc_url=None)
engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=2, det_limit_side_len=768, det_limit_type='max', rec_batch_num=4)
lock = threading.Lock()

class ImageInput(BaseModel):
    image: str = Field(max_length=28_000_000)

@app.get('/health')
def health():
    return {'ready': True, 'engine': 'RapidOCR / PP-OCR ONNX CPU', 'local': True}

@app.post('/recognize')
async def recognize(payload: ImageInput, request: Request):
    token = os.environ.get('OCR_SERVICE_TOKEN')
    if token and not secrets.compare_digest(request.headers.get('authorization', ''), 'Bearer '+token):
        raise HTTPException(401, 'Unauthorized')
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
        words = []
        with lock:
            # Bound detection tensors on small free instances, and preserve tiny table text.
            height, width = image.shape[:2]
            for top in range(0, height, 500):
                for left in range(0, width, 416):
                    tile = image[top:min(top+580, height), left:min(left+500, width)]
                    if tile.shape[0] < 8 or tile.shape[1] < 8:
                        continue
                    scaled = cv2.resize(tile, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
                    result, _ = engine(scaled, use_cls=False)
                    for points, text, score in result or []:
                        x = min(p[0] for p in points)/2+left
                        y = min(p[1] for p in points)/2+top
                        w = (max(p[0] for p in points)-min(p[0] for p in points))/2
                        h = (max(p[1] for p in points)-min(p[1] for p in points))/2
                        words.append(dict(text=text, x=x, y=y, width=w, height=h, confidence=float(score)*100))
        kept = []
        for word in sorted(words, key=lambda w: (len(w['text']), w['confidence']), reverse=True):
            duplicate = False
            for other in kept:
                ix = max(0, min(word['x']+word['width'], other['x']+other['width'])-max(word['x'], other['x']))
                iy = max(0, min(word['y']+word['height'], other['y']+other['height'])-max(word['y'], other['y']))
                area = min(word['width']*word['height'], other['width']*other['height'])
                if area > 0 and ix*iy/area > .65:
                    duplicate = True
                    break
            if not duplicate:
                kept.append(word)
        words = sorted(kept, key=lambda w: (w['y'], w['x']))
        return {'words': words, 'engine': 'RapidOCR / PP-OCR ONNX CPU'}
    return await asyncio.to_thread(run)
