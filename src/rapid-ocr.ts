import type {OcrWord} from './local-ocr';
export async function rapidWords(blob:Blob,onProgress:(s:string)=>void):Promise<OcrWord[]|null>{
 try{
  const health=await fetch('/local-ocr/health',{signal:AbortSignal.timeout(2000)});if(!health.ok)return null;
  onProgress('تشغيل المحرك المحلي الثاني RapidOCR — الصورة تظل على جهازك');
  const image=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('تعذر تجهيز الصورة'));reader.readAsDataURL(blob)});
  const response=await fetch('/local-ocr/recognize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image}),signal:AbortSignal.timeout(90000)});
  if(!response.ok)throw Error('local OCR error');const result=await response.json() as {words:OcrWord[]};return result.words;
 }catch{return null}
}
