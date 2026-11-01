import {createWorker,PSM} from 'tesseract.js';
import {num,validateRecords,type DataRecord} from './domain';
import {readRetailGrid} from './grid-reader';
import {readReportProfile} from './report-profiles';
import {rapidWords} from './rapid-ocr';
export type OcrWord={text:string;x:number;y:number;width:number;height:number;confidence:number};
export function tsvWords(tsv:string):OcrWord[]{return tsv.trim().split('\n').slice(1).flatMap(line=>{const c=line.split('\t');return c[0]==='5'&&c.slice(11).join('\t').trim()?[{text:c.slice(11).join('\t').trim(),x:Number(c[6]),y:Number(c[7]),width:Number(c[8]),height:Number(c[9]),confidence:Number(c[10])}]:[]})}
export function wordRows(words:OcrWord[]){const rows:OcrWord[][]=[];for(const word of [...words].sort((a,b)=>a.y-b.y||a.x-b.x)){const center=word.y+word.height/2;const row=rows.find(r=>Math.abs(r[0].y+r[0].height/2-center)<Math.max(5,Math.min(r[0].height,word.height)*.55));if(row)row.push(word);else rows.push([word])}return rows.map(r=>r.sort((a,b)=>a.x-b.x))}
export function parseOcrWords(words:OcrWord[],name:string){
 const rows=wordRows(words);const records:DataRecord[]=[];const text=rows.map(r=>r.map(w=>w.text).join(' ')).join('\n');
 const dates=[...text.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map(m=>`${m[3]}-${m[2]}-${m[1]}`).sort();
 const codes=words.filter(w=>/^[sS$][oO0-9]{4}$/.test(w.text)).map(w=>({...w,code:w.text.toUpperCase().replace(/^\$/,'S').replace(/O/g,'0')})).sort((a,b)=>a.x-b.x);
 const uniqueCodes=codes.filter((w,i)=>!codes.slice(0,i).some(v=>v.code===w.code));
 if(uniqueCodes.length>=2){
  let adjusted=false;for(const row of rows){const labelWords=row.filter(w=>w.x<uniqueCodes[0].x-20);const label=labelWords.map(w=>w.text).join(' ');if(!/TOTAL/i.test(label))continue;
   if(/NET/i.test(label))adjusted=true;const metric=adjusted?'adjusted_income':'income';let start:string|null=null,end:string|null=null;const month=dates[0]?.slice(0,7);if(month){if(/GRAND/i.test(label)){start=month+'-01';end=dates.at(-1)!}else if(/16/.test(label)){start=month+'-16';end=month+'-'+new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate()}else{start=month+'-01';end=month+'-15'}}
   uniqueCodes.forEach((branch,i)=>{const left=i===0?uniqueCodes[0].x-30:(uniqueCodes[i-1].x+branch.x)/2;const right=i===uniqueCodes.length-1?Infinity:(branch.x+uniqueCodes[i+1].x)/2;const cells=row.filter(w=>w.x>=left&&w.x<right);const number=cells.map(w=>num(w.text)).find(v=>v!=null);if(number==null)return;records.push({entityId:branch.code,entityName:branch.code,branchCode:branch.code,metric,periodStart:start,periodEnd:end,quantity:null,amount:number,description:label,category:null,sourceRef:`${name} / صف عند y=${Math.round(row[0].y)}`,issues:['قراءة OCR محلية تحتاج مراجعة الأرقام والفترة قبل الاعتماد']})});
  }
 }
 // Employee snippets carry the employee ID/name once, followed by package rows.
 if(!uniqueCodes.length){let id='',employee='';for(const row of rows){const line=row.map(w=>w.text).join(' ');const first=row[0];if(first&&/^\d{2,5}$/.test(first.text)&&row.some(w=>/BRONZE|SILVER|VIP|GOLD|PLATINUM|DIAMOND/i.test(w.text))){id=first.text;const cat=row.findIndex(w=>/^(BRONZE|SILVER|VIP|GOLD|PLATINUM|DIAMOND)$/i.test(w.text));employee=row.slice(1,cat).map(w=>w.text).join(' ')}if(!id||/Sub\s*Total|Grand\s*Total/i.test(line))continue;const amount=num(row.at(-1)?.text),quantity=num(row.at(-2)?.text);if(amount==null||quantity==null||!Number.isInteger(quantity)||quantity<=0)continue;const category=row.find(w=>/^(BRONZE|SILVER|VIP|GOLD|PLATINUM|DIAMOND)$/i.test(w.text))?.text??null;const description=row.filter(w=>w!==first||w.text!==id).slice(0,-2).map(w=>w.text).join(' ');records.push({entityId:id,entityName:employee||id,branchCode:null,metric:'package_detail',periodStart:null,periodEnd:null,quantity,amount,description,category,sourceRef:`${name} / y=${Math.round(row[0].y)}`,issues:['فترة صورة الموظف غير محددة؛ أدخل الفترة من التقرير الأصلي']})}}
 return {records,text,warnings:[`استخراج محلي OCR — ${words.length} كلمة. راجع الأرقام؛ ليست قراءة نموذج لغوي.`,...(!records.length?['تم استخراج النص، لكن قالب الجدول لم يُفهم تلقائيًا. النص والأصل محفوظان للمراجعة.']:[]),...validateRecords(records)]};
}
export async function readImageLocally(blob:Blob,name:string,onProgress:(text:string)=>void){
 const worker=await createWorker('eng',1,{workerPath:'/ocr/worker.min.js',corePath:'/ocr/core',langPath:'/ocr/lang',logger:m=>{if(m.status==='recognizing text')return;onProgress(`تحميل محرك القراءة المحلي ${Math.round((m.progress??0)*100)}%`)}});
 try{
  const image=await createImageBitmap(blob);const base=document.createElement('canvas');base.width=image.width;base.height=image.height;const ctx=base.getContext('2d')!;ctx.fillStyle='white';ctx.fillRect(0,0,base.width,base.height);ctx.drawImage(image,0,0);image.close();
  const pixels=ctx.getImageData(0,0,base.width,base.height);
  let profileMode=false;let language='eng';let secondEngine:OcrWord[]|null=null;
  const recognize:import('./grid-reader').GridRecognizer=async(cleaned,rect,numeric)=>{
   if(profileMode&&numeric&&rect&&cleaned.data===pixels.data&&secondEngine){return secondEngine.filter(w=>w.x+w.width/2>=rect.left&&w.x+w.width/2<rect.left+rect.width&&w.y+w.height/2>=rect.top&&w.y+w.height/2<rect.top+rect.height)}
   if(profileMode){const desired='eng+ara';if(desired!==language){await worker.reinitialize(desired);language=desired}}
   const source=document.createElement('canvas');source.width=cleaned.width;source.height=cleaned.height;source.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(cleaned.data),cleaned.width,cleaned.height),0,0);
   const region=rect??{left:0,top:0,width:cleaned.width,height:cleaned.height};const scale=profileMode?4:3;const canvas=document.createElement('canvas');const padding=rect?20:0;canvas.width=Math.round(region.width*scale)+padding*2;canvas.height=Math.round(region.height*scale)+padding*2;const context=canvas.getContext('2d')!;context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(source,region.left,region.top,region.width,region.height,padding,padding,region.width*scale,region.height*scale);
   await worker.setParameters({tessedit_pageseg_mode:rect?PSM.SINGLE_LINE:profileMode?PSM.SPARSE_TEXT:PSM.SINGLE_BLOCK,tessedit_char_whitelist:numeric?'0123456789,().-':'',user_defined_dpi:'300'});
   let result=await worker.recognize(canvas,{}, {text:true,tsv:true});if(rect&&numeric&&!tsvWords(result.data.tsv??'').length){await worker.setParameters({tessedit_pageseg_mode:PSM.SINGLE_WORD,tessedit_char_whitelist:''});result=await worker.recognize(canvas,{}, {text:true,tsv:true})}return tsvWords(result.data.tsv??'').map(w=>({...w,x:(w.x-padding)/scale+region.left,y:(w.y-padding)/scale+region.top,width:w.width/scale,height:w.height/scale}));
  };
  const pixelImage={data:pixels.data,width:base.width,height:base.height};
  const gridResult=await readRetailGrid(pixelImage,name,recognize,onProgress);
  if(gridResult)return gridResult;
  profileMode=true;secondEngine=await rapidWords(blob,onProgress);const profile=await readReportProfile(pixelImage,name,recognize,onProgress);if(profile)return {...profile,warnings:[...profile.warnings,secondEngine?'تمت مقارنة قراءة Tesseract بمحرك RapidOCR محلي مستقل.':'محرك RapidOCR غير متصل؛ استُخدم Tesseract فقط.']};
  if(secondEngine){const employee=parseOcrWords(secondEngine,name);if(employee.records.some(r=>r.metric==='package_detail'))return {...employee,records:employee.records.map(r=>({...r,reviewRequired:true})),warnings:['قُرئت تفاصيل الموظف بمحرك RapidOCR المحلي؛ إجماليات الأقسام مستبعدة من الجمع.',...employee.warnings]}}
  onProgress('قراءة النص العام؛ لم يُتعرف على قالب دخل الفروع');await worker.reinitialize('eng+ara');const scale=Math.min(3,Math.max(1,2400/base.width));const canvas=document.createElement('canvas');canvas.width=Math.round(base.width*scale);canvas.height=Math.round(base.height*scale);canvas.getContext('2d')!.drawImage(base,0,0,canvas.width,canvas.height);const result=await worker.recognize(canvas,{}, {text:true,tsv:true});const parsed=parseOcrWords(tsvWords(result.data.tsv??''),name);return {...parsed,text:result.data.text||parsed.text};
 }finally{await worker.terminate()}
}
