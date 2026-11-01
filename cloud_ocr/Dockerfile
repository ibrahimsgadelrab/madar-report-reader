FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libglib2.0-0 libgl1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY cloud_ocr/package.json ./package.json
RUN npm install --omit=dev
RUN python3 -m venv /opt/ocr
ENV PATH="/opt/ocr/bin:$PATH"
COPY local_ocr/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
COPY src ./src
COPY local_ocr ./local_ocr
COPY cloud_ocr ./cloud_ocr
RUN node --input-type=module -e "import{mkdir,writeFile}from'node:fs/promises';import{gzipSync}from'node:zlib';await mkdir('models',{recursive:true});for(const lang of ['eng','ara']){const r=await fetch('https://github.com/tesseract-ocr/tessdata_fast/raw/main/'+lang+'.traineddata');if(!r.ok)throw Error('model download failed');await writeFile('models/'+lang+'.traineddata.gz',gzipSync(Buffer.from(await r.arrayBuffer())))}"
ENV PORT=8080
EXPOSE 8080
CMD ["node","--import","tsx","cloud_ocr/server.ts"]
