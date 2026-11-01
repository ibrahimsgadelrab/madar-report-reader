import http from 'node:http';
import {spawn} from 'node:child_process';
import path from 'node:path';
import sharp from 'sharp';
import {createWorker,PSM} from 'tesseract.js';
import {z} from 'zod';
import {readRetailGrid,type GridRecognizer} from '../src/grid-reader';
import {readReportProfile} from '../src/report-profiles';
import {parseOcrWords,tsvWords,type OcrWord} from '../src/local-ocr';
const token=process.env.OCR_SERVICE_TOKEN;
if(!token)throw Error('OCR_SERVICE_TOKEN must be configured');
const python=spawn('python',['-m','uvicorn','local_ocr.server:app','--host','127.0.0.1','--port','8931'],{stdio:'inherit'});
let busy=false;
const schema=z.object({name:z.string().max(300),image:z.string().max(28_000_000).regex(/^data:image\/(jpeg|png|webp);base64,/)});
http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 if(req.url==='/health'){res.end(JSON.stringify({ready:true,engine:'RapidOCR + Tesseract templates',cloud:true}));return}
 if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end('{"error":"Unauthorized"}');return}
 if(req.url!=='/extract'||req.method!=='POST'){res.writeHead(404);res.end('{}');return}
 if(busy){res.writeHead(429);res.end('{"error":"OCR busy; retry later"}');return}
 busy=true;
 let worker:Awaited<ReturnType<typeof createWorker>>|null=null;
 try{
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>30_000_000)throw Error('Image too large')}
  const input=schema.parse(JSON.parse(raw));const bytes=Buffer.from(input.image.split(',')[1],'base64');
  const {data,info}=await sharp(bytes,{limitInputPixels:24000000}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const image={data,width:info.width,height:info.height};
  const second=await fetch('http://127.0.0.1:8931/recognize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:input.image}),signal:AbortSignal.timeout(80000)});
  if(!second.ok)throw Error('OCR engine unavailable');const words=(await second.json() as {words:OcrWord[]}).words;
  const employee=parseOcrWords(words,input.name);
  if(employee.records.some(r=>r.metric==='package_detail')){res.end(JSON.stringify({...employee,records:employee.records.map(r=>({...r,reviewRequired:true})),warnings:['قراءة على السيرفر بمحرك RapidOCR؛ أدخل فترة التقرير وراجع الأرقام.',...employee.warnings]}));return}
  worker=await createWorker('eng+ara',1,{langPath:path.resolve('models')});
  const recognize:GridRecognizer=async(im,rect,numeric)=>{
   if(rect&&numeric&&im.data===data)return words.filter(w=>w.x+w.width/2>=rect.left&&w.x+w.width/2<rect.left+rect.width&&w.y+w.height/2>=rect.top&&w.y+w.height/2<rect.top+rect.height);
   let render=sharp(Buffer.from(im.data),{raw:{width:im.width,height:im.height,channels:4}});if(rect)render=render.extract(rect);
   const region=rect??{left:0,top:0,width:im.width,height:im.height};const png=await render.resize({width:region.width*4}).extend({top:20,bottom:20,left:20,right:20,background:'white'}).png().toBuffer();
   await worker!.setParameters({tessedit_pageseg_mode:rect?PSM.SINGLE_LINE:PSM.SPARSE_TEXT,tessedit_char_whitelist:numeric?'0123456789,().-':'',user_defined_dpi:'300'});
   const result=await worker!.recognize(png,{}, {text:true,tsv:true});return tsvWords(result.data.tsv??'').map(w=>({...w,x:(w.x-20)/4+region.left,y:(w.y-20)/4+region.top,width:w.width/4,height:w.height/4}));
  };
  const result=await readReportProfile(image,input.name,recognize,()=>{})??await readRetailGrid(image,input.name,recognize,()=>{});
  if(!result)throw Error('لم يتعرف محرك السيرفر على تصميم التقرير. الأصل محفوظ؛ لا توجد أرقام معتمدة.');
  res.end(JSON.stringify({...result,records:result.records.map(r=>({...r,reviewRequired:true})),warnings:['تمت القراءة على السيرفر؛ راجع الخانات قبل الاعتماد.',...result.warnings]}));
 }catch(error){res.writeHead(400);res.end(JSON.stringify({error:error instanceof Error?error.message:'OCR failed'}))}
 finally{if(worker)await worker.terminate();busy=false}
}).listen(Number(process.env.PORT??8080),'0.0.0.0');
process.on('SIGTERM',()=>{python.kill();process.exit(0)});
