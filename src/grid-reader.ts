import type {DataRecord} from './domain';
import {num} from './domain';
import {detectGrid,cleanTable,type PixelImage} from './table-image';
import type {OcrWord} from './local-ocr';
export type Rect={left:number;top:number;width:number;height:number};
export type GridRecognizer=(image:PixelImage,rect:Rect|null,numeric:boolean)=>Promise<OcrWord[]>;
function cellWords(words:OcrWord[],rect:Rect){return words.filter(w=>w.x+w.width/2>=rect.left&&w.x+w.width/2<rect.left+rect.width&&w.y+w.height/2>=rect.top&&w.y+w.height/2<rect.top+rect.height).sort((a,b)=>a.x-b.x).map(w=>w.text).join(' ').trim()}
export async function readRetailGrid(image:PixelImage,name:string,recognize:GridRecognizer,progress:(message:string)=>void){
 const grid=detectGrid(image);if(!grid||grid.xs.length!==8)return null;
 const cleaned={...image,data:cleanTable(image,grid)};
 const rect=(row:number,col:number):Rect=>({left:grid.xs[col]+3,top:grid.ys[row]+3,width:grid.xs[col+1]-grid.xs[col]-6,height:grid.ys[row+1]-grid.ys[row]-6});
 progress('قراءة الجدول بعد إزالة الألوان والخطوط');
 const words=await recognize(cleaned,null,false);
 const rows=grid.ys.slice(0,-1).map((_,r)=>grid.xs.slice(0,-1).map((_,c)=>cellWords(words,rect(r,c))));
 const canonical=(s:string)=>s.replace(/[\s|.]/g,'').toUpperCase();
 const target=rows.findIndex(r=>canonical(r[0]).includes('TARGET'));
 const dates=rows.map(r=>r[0].match(/(\d{2})\/(\d{2})\/(\d{4})/));
 // Recognize this report family structurally, never by filename or hardcoded amounts.
 if(target<0||dates.filter(Boolean).length<10)return null;
 const noCodes=!!dates[1];const headerRow=noCodes?0:1;
 const branches:string[]=[];
 for(let c=1;c<7;c++){progress(`قراءة كود الفرع ${c} من 6`);const codeWords=await recognize(cleaned,rect(0,c),false);const raw=codeWords.map(w=>w.text).join('').replace(/[^a-zA-Z0-9$]/g,'').toUpperCase();const normalized=raw.replace(/^[5$]/,'S').replace(/O/g,'0');const label=canonical(rows[headerRow][c]);const known=[['CCAJMAN','S0090'],['ALHUMAIDIYAH','S0184'],['SHIEKHAMMAR','S0154'],['LULUUAQ','S0103'],['UAQCOOP','S0163'],['HAMRA','S0064']].find(([alias])=>label.includes(alias));branches.push(/^S\d{4}$/.test(normalized)?normalized:noCodes&&known?known[1]:`UNKNOWN-COL-${c}`)}
 const numericValue=(s:string)=>{const raw=s.replace(/\s/g,'').replace(/[|]/g,'');if(/^[-—–.]*$/.test(raw))return null;return num(raw.replace(/^(\d{1,3})\.(\d{3})$/,'$1,$2'))};
 const isBlue=(r:number)=>{const box=rect(r,1);const x=Math.round(box.left+5),y=Math.round(box.top+box.height/2),p=(y*image.width+x)*4;return image.data[p+2]>image.data[p]+35&&image.data[p+2]>image.data[p+1]+20&&image.data[p]<80};
 const bands:number[][]=[];for(let r=2;r<target;r++)if(isBlue(r)){const group=bands.at(-1);if(group&&group.at(-1)===r-1)group.push(r);else bands.push([r])}
 const totals=bands.filter(b=>b.length>=3&&b.length<=4).map(b=>b.slice(-3));
 if(totals.length!==2)return null;
 // Re-read numeric rows separately so a number cannot slide into the next column.
 const targetRows=Array.from({length:5},(_,i)=>target+2+i).filter(r=>r<rows.length);
 const secondTargetStart=targetRows.at(-1)!+2;const secondTargetRows=Array.from({length:5},(_,i)=>secondTargetStart+i).filter(r=>r<rows.length&&rows[r].slice(1).filter(s=>numericValue(s)!=null).length>=4);const secondTiers=secondTargetRows.length===5?secondTargetRows:[];
 const important=[...totals.flat(),...targetRows,...secondTiers];
 const originalRows=rows.map(r=>[...r]);
 const disputed=new Map<string,string>();
 for(let i=0;i<important.length;i++){const r=important[i];for(let c=1;c<7;c++){progress(`تدقيق الخانة ${i*6+c} من ${important.length*6}`);const found=await recognize(cleaned,rect(r,c),true);rows[r][c]=found.sort((a,b)=>a.x-b.x).map(w=>w.text).join('')}}
 const month=dates.find(Boolean)!;const monthPrefix=`${month[3]}-${month[2]}`;const monthEnd=new Date(Number(month[3]),Number(month[2]),0).getDate();
 const asOf=dates.flatMap((d,r)=>d&&rows[r].slice(1).some(s=>numericValue(s)!=null)?[`${d[3]}-${d[2]}-${d[1]}`]:[]).sort().at(-1)??null;
 // A duplicate total is corroborating evidence only before stage two has started.
 // Never assume an unavailable second-stage amount is zero.
 for(const r of important)for(let c=1;c<7;c++){
  const whole=numericValue(originalRows[r][c]),isolated=numericValue(rows[r][c]);
  if(whole===isolated)continue;
  disputed.set(`${r}:${c}`,`اختلاف قراءتين: الصف الكامل «${originalRows[r][c]}» والخانة المنفصلة «${rows[r][c]}». راجع الأصل.`);
  const band=totals.find(b=>b.includes(r));
  if(band&&asOf&&Number(asOf.slice(-2))<=15&&r!==band[1]){
   const other=r===band[0]?band[2]:band[0];const corroborating=numericValue(rows[other][c]);
   if(whole!=null&&whole===corroborating)rows[r][c]=originalRows[r][c];
  }
 }
 const records:DataRecord[]=[];
 function add(row:number,col:number,metric:DataRecord['metric'],description:string,stage:'first'|'second'|'month'|'day',extra:Partial<DataRecord>={}){
  const daily=dates[row];const start=stage==='day'&&daily?`${daily[3]}-${daily[2]}-${daily[1]}`:`${monthPrefix}-${stage==='second'?'16':'01'}`;
  const end=stage==='day'?start:`${monthPrefix}-${stage==='first'?'15':String(monthEnd).padStart(2,'0')}`;
  const raw=rows[row][col];const value=numericValue(raw);const issues:string[]=[];
  if(branches[col-1].startsWith('UNKNOWN'))issues.push('كود الفرع غير واضح؛ لا تعتمد قبل تصحيحه');
  if(value==null&&!/^\s*[-—–.]*\s*$/.test(raw))issues.push(`قيمة غير مقروءة: ${raw}`);
  if(disputed.has(`${row}:${col}`))issues.push(disputed.get(`${row}:${col}`)!);
  let suggestedAmount:number|undefined;
  const band=totals.find(b=>b[0]===row);
  if(band&&value==null&&asOf&&Number(asOf.slice(-2))<=15){
   const grand=numericValue(rows[band[2]][col]);
   if(grand!=null){suggestedAmount=grand;issues.push(`الخانة لم تُقرأ. الإجمالي ${grand} قد يساعد في مراجعتها، لكنه ليس قراءة مؤكدة للخانة.`)}
  }
  if(!important.includes(row))issues.push('قراءة أولية للتفاصيل؛ لم تُدقق الخانة منفردة');
  const box=rect(row,col);records.push({entityId:branches[col-1],entityName:rows[headerRow][col]||branches[col-1],branchCode:branches[col-1],metric,periodStart:start,periodEnd:end,quantity:null,amount:value,description,category:stage,sourceRef:`${name} / صف ${row+1} عمود ${col+1} [${box.left},${box.top},${box.width},${box.height}]`,issues,reviewRequired:issues.length>0,suggestedAmount,rawValue:raw,asOf,...extra});
 }
 for(let r=2;r<target;r++){
  const group=totals.findIndex(b=>b.includes(r));
  if(group>=0){const slot=totals[group].indexOf(r);const stage=slot===0?'first':slot===1?'second':'month';const description=slot===0?'TOTAL 1 TO 15':slot===1?'TOTAL 16 TO END':'GRAND TOTAL';for(let c=1;c<7;c++)add(r,c,group===0?'income':'adjusted_income',description,stage);continue}
  if(isBlue(r)||!rows[r][0])continue;
  const label=rows[r][0];const metric:DataRecord['metric']=dates[r]?'daily_income':r<totals[0][0]?'channel_income':'income_adjustment';const stage=dates[r]?'day':/16\s*(TO|10)/i.test(label)?'second':'first';
  for(let c=1;c<7;c++)add(r,c,metric,label,stage);
 }
 for(let tier=0;tier<targetRows.length;tier++)for(let c=1;c<7;c++){const r=targetRows[tier],value=numericValue(rows[r][c]);add(r,c,'target',`شريحة الفرع ${tier+1}`,'first',{amount:value==null?null:value*1000,reward:(tier+1)*250,category:`branch_tier_${tier+1}`})}
 for(let tier=0;tier<secondTiers.length;tier++)for(let c=1;c<7;c++){const r=secondTiers[tier],value=numericValue(rows[r][c]);add(r,c,'target',`شريحة الفرع ${tier+1} — المرحلة الثانية`,'second',{amount:value==null?null:value*1000,reward:(tier+1)*250,category:`branch_tier_${tier+1}`})}
 const warnings=['قُرئ الجدول محليًا مع فصل الخانات وتدقيق صفوف الإجماليات والشرائح. المراجعة البشرية مطلوبة قبل الاعتماد.','حدود الشرائح في هذا القالب بالآلاف؛ المكافآت 250 إلى 1250 حسب القواعد المحددة.','الفراغ والشرطة يحتفظان بقيمة غير متاحة، ولا يتحولان إلى صفر.'];
 const text=rows.map(row=>row.join(' | ')).join('\n');
 return {records,text,warnings:[...warnings,...[...disputed.values()].map(v=>`مراجعة إلزامية: ${v}`)],grid};
}
