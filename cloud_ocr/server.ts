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
const rapidUrl=process.env.RAPID_SERVICE_URL??'http://127.0.0.1:8931';
const python=process.env.RAPID_SERVICE_URL?null:spawn('python',['-m','uvicorn','local_ocr.server:app','--host','127.0.0.1','--port','8931'],{stdio:'inherit'});
let busy=false;
type Job={id:string;status:'running'|'done'|'error';message:string;createdAt:number;result?:unknown;error?:string};
const jobs=new Map<string,Job>();
const schema=z.object({jobId:z.uuid().optional(),name:z.string().max(300),image:z.string().max(28_000_000).regex(/^data:image\/(jpeg|png|webp);base64,/)});
async function extract(input:z.infer<typeof schema>,progress:(s:string)=>void){
 let worker:Awaited<ReturnType<typeof createWorker>>|null=null;
 try{
  const bytes=Buffer.from(input.image.split(',')[1],'base64');progress('تجهيز الصورة على السيرفر');
  const {data,info}=await sharp(bytes,{limitInputPixels:24000000}).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const image={data,width:info.width,height:info.height};
  let words:OcrWord[]=[];if(info.width/info.height>2){progress('قراءة النص والأرقام بمحرك RapidOCR على السيرفر');const second=await fetch(rapidUrl+'/recognize',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({image:input.image}),signal:AbortSignal.timeout(240000)});
  if(!second.ok)throw Error('OCR engine unavailable');words=(await second.json() as {words:OcrWord[]}).words;}
  const employee=parseOcrWords(words,input.name);
  if(employee.records.some(r=>r.metric==='package_detail')){return {...employee,records:employee.records.map(r=>({...r,reviewRequired:true})),warnings:['قراءة على السيرفر بمحرك RapidOCR؛ أدخل فترة التقرير وراجع الأرقام.',...employee.warnings]}}
  progress('فحص تصميم التقرير وتشغيل القارئ المساعد');worker=await createWorker('eng+ara',1,{langPath:path.resolve('models')});
  const recognize:GridRecognizer=async(im,rect,numeric)=>{
   if(rect&&numeric&&im.data===data)return words.filter(w=>w.x+w.width/2>=rect.left&&w.x+w.width/2<rect.left+rect.width&&w.y+w.height/2>=rect.top&&w.y+w.height/2<rect.top+rect.height);
   let render=sharp(Buffer.from(im.data),{raw:{width:im.width,height:im.height,channels:4}});if(rect)render=render.extract(rect);
   const region=rect??{left:0,top:0,width:im.width,height:im.height};const scale=rect?4:Math.min(4,2600/Math.max(im.width,im.height));const png=await render.resize({width:Math.round(region.width*scale)}).extend({top:20,bottom:20,left:20,right:20,background:'white'}).png().toBuffer();
   await worker!.setParameters({tessedit_pageseg_mode:rect?PSM.SINGLE_LINE:PSM.SPARSE_TEXT,tessedit_char_whitelist:numeric?'0123456789,().-':'',user_defined_dpi:'300'});
   const result=await worker!.recognize(png,{}, {text:true,tsv:true});return tsvWords(result.data.tsv??'').map(w=>({...w,x:(w.x-20)/scale+region.left,y:(w.y-20)/scale+region.top,width:w.width/scale,height:w.height/scale}));
  };
  const result=await readReportProfile(image,input.name,recognize,progress)??await readRetailGrid(image,input.name,recognize,progress);
  if(!result){progress('حفظ النص المقروء؛ القالب يحتاج تحديدًا ومراجعة');const readable=words.length?words:await recognize(image,null,false);return {records:[],text:readable.map(w=>w.text).join(' '),warnings:['تمت قراءة محتوى الصورة، لكن تصميمها لا يطابق القوالب المدعومة. لا توجد أرقام جاهزة للاعتماد. قد تكون قصاصة تحتاج الصورة الكاملة أو تحديد نوع التقرير والفترة.']}}
  return {...result,records:result.records.map(r=>({...r,reviewRequired:true})),warnings:['تمت القراءة على السيرفر؛ راجع الخانات قبل الاعتماد.',...result.warnings]};

 }finally{if(worker)await worker.terminate()}
}
async function readInput(req:http.IncomingMessage){let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>30000000)throw Error('Image too large');chunks.push(Buffer.from(chunk))}return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))}
http.createServer(async(req,res)=>{
 res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
 const send=(data:unknown,status=200)=>{res.writeHead(status);res.end(JSON.stringify(data))};
 if(req.url==='/health'){send({ready:true,engine:'RapidOCR + Tesseract templates',cloud:true,architecture:process.env.RAPID_SERVICE_URL?'split':'combined',version:4,idempotentJobs:true});return}
 if(req.headers.authorization!==`Bearer ${token}`){send({error:'Unauthorized'},401);return}
 try{
  if(req.method==='GET'&&req.url?.startsWith('/jobs/')){const job=jobs.get(req.url.slice(6));send(job??{error:'أعيد تشغيل خدمة القراءة أو انتهت صلاحية المهمة؛ الأصل محفوظ ويمكن إعادة المحاولة'},job?200:404);return}
  if(!['/extract','/jobs'].includes(req.url??'')||req.method!=='POST'){send({error:'Not found'},404);return}
  const input=await readInput(req);
  if(req.url==='/jobs'&&input.jobId&&jobs.has(input.jobId)){send(jobs.get(input.jobId));return}
  if(busy){send({error:'السيرفر يعالج صورة أخرى؛ حاول بعد قليل'},429);return}
  busy=true;
  if(req.url==='/jobs'){
   for(const [id,job]of jobs)if(Date.now()-job.createdAt>900000&&job.status!=='running')jobs.delete(id);
   const job:Job={id:input.jobId??crypto.randomUUID(),status:'running',message:'بدء قراءة الصورة على السيرفر',createdAt:Date.now()};jobs.set(job.id,job);send(job,202);
   void extract(input,message=>{job.message=message}).then(result=>{job.status='done';job.result=result;job.message='اكتملت القراءة — النتيجة جاهزة للمراجعة'}).catch(error=>{job.status='error';job.error=error instanceof Error?error.message:'تعذرت القراءة';job.message='فشلت القراءة؛ الأصل محفوظ'}).finally(()=>{busy=false});return;
  }
  try{send(await extract(input,()=>{}))}finally{busy=false}
 }catch(error){send({error:error instanceof Error?error.message:'OCR failed'},400)}
}).listen(Number(process.env.PORT??8080),'0.0.0.0');
process.on('SIGTERM',()=>{python?.kill();process.exit(0)});
