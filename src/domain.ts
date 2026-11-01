import {z} from 'zod';
export const recordSchema=z.object({
  entityId:z.string(),entityName:z.string(),branchCode:z.string().nullable(),
  metric:z.enum(['package_detail','package_summary','income','adjusted_income','target','transaction_summary','supervisor_tier','daily_income','channel_income','income_adjustment','branch_performance','branch_package_summary']),
  periodStart:z.iso.date().nullable(),periodEnd:z.iso.date().nullable(),
  quantity:z.number().finite().nullable(),amount:z.number().finite().nullable(),
  suggestedAmount:z.number().optional(),reviewRequired:z.boolean().optional(),rawValue:z.string().optional(),asOf:z.string().nullable().optional(),reward:z.number().optional(),
  description:z.string(),category:z.string().nullable(),sourceRef:z.string(),
  issues:z.array(z.string()),
});
export type DataRecord=z.infer<typeof recordSchema>;
export type Document={id:string;name:string;hash:string;createdAt:string;updatedAt?:string;ocrText?:string;aiClassification?:string;ocrReviewed?:boolean;processingProvider?:'local'|'google';kind:string;status:'review'|'approved'|'rejected'|'needs_ai';records:DataRecord[];warnings:string[];source?:Blob;revision:number};
export function money(v:number|null|undefined){return v==null?'—':new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(v)}
export function num(v:unknown):number|null{
 if(typeof v==='number')return Number.isFinite(v)?v:null;
 if(v==null)return null;
 const t=String(v).trim().replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[,٬\s]/g,'').replace(/٫/g,'.');
 if(!t||t==='-'||t.startsWith('#'))return null;
 const n=Number(t.replace(/^\((.*)\)$/,'-$1'));return Number.isFinite(n)?n:null;
}
export function average(amount:number|null,quantity:number|null){return amount==null||quantity==null||quantity<=0?null:amount/quantity}
export function tierReward(income:number,tiers:{threshold:number;reward:number}[]){return [...tiers].sort((a,b)=>a.threshold-b.threshold).filter(t=>income>=t.threshold).at(-1)?.reward??0}
export function forecast(amount:number,days:number,monthDays:number){return days>0?amount/days*monthDays:null}
export function recordKey(r:DataRecord){return [r.entityId,r.branchCode??'',r.metric,r.periodStart??'',r.periodEnd??'',r.category??'',r.description.trim().toUpperCase()].join('|')}
export function periodLabel(r:DataRecord){return r.periodStart&&r.periodEnd?`${r.periodStart} — ${r.periodEnd}`:'الفترة غير محددة'}
export type EmployeeSummary={id:string;name:string;branch:string|null;quantity:number;amount:number;average:number|null;highest:number|null;highestExact:boolean;source:string;period:string};
export function summarize(records:DataRecord[]):EmployeeSummary[]{
 const groups=new Map<string,DataRecord[]>();
 for(const r of records.filter(r=>['package_detail','package_summary'].includes(r.metric))){const k=[r.entityId,r.branchCode,r.periodStart,r.periodEnd].join('|');groups.set(k,[...(groups.get(k)??[]),r])}
 return [...groups.values()].map(g=>{const details=g.filter(r=>r.metric==='package_detail');const use=details.length?details:g.filter(r=>r.metric==='package_summary');const quantity=use.reduce((s,r)=>s+(r.quantity??0),0);const amount=use.reduce((s,r)=>s+Math.round((r.amount??0)*100),0)/100;const units=details.map(r=>({v:average(r.amount,r.quantity),exact:r.quantity===1})).filter(x=>x.v!=null).sort((a,b)=>b.v!-a.v!);return {id:g[0].entityId,name:g[0].entityName,branch:g[0].branchCode,quantity,amount,average:average(amount,quantity),highest:units[0]?.v??null,highestExact:units[0]?.exact??false,source:use.map(r=>r.sourceRef).join('، '),period:periodLabel(g[0])}}).sort((a,b)=>b.amount-a.amount)
}
export function validateRecords(records:DataRecord[]):string[]{
 const issues:string[]=[];const seen=new Set<string>();
 for(const r of records){if(!r.periodStart||!r.periodEnd)issues.push(`${r.entityName}: الفترة غير محددة`);else if(r.periodStart>r.periodEnd)issues.push(`${r.entityName}: نهاية الفترة قبل بدايتها`);if((r.metric.startsWith('package')||r.metric==='branch_package_summary')&&(r.quantity==null||r.amount==null))issues.push(`${r.entityName}: عدد أو قيمة الباقات غير متاح`);if(r.quantity!=null&&r.quantity<0)issues.push(`${r.entityName}: كمية سالبة تحتاج مراجعة`);if(r.metric==='package_summary'&&seen.has(recordKey(r)))issues.push(`${r.entityName}: ملخص مكرر في نفس الفترة`);seen.add(recordKey(r));issues.push(...r.issues)}
 return [...new Set(issues)];
}
export function conflicts(incoming:DataRecord[],approved:DataRecord[]){return incoming.flatMap(r=>{const other=approved.filter(a=>recordKey(a)===recordKey(r));return other.filter(a=>a.amount!==r.amount||a.quantity!==r.quantity).map(a=>`${r.entityName}: ${r.description} تغيّرت من ${money(a.amount)} إلى ${money(r.amount)} (${r.sourceRef})`)})}
export function effectiveRecords(documents:Pick<Document,'records'|'createdAt'|'status'>[]):DataRecord[]{
 const owners=new Map<string,DataRecord[]>();
 for(const doc of [...documents].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).filter(d=>d.status==='approved')){
  const local=new Map<string,DataRecord[]>();
  for(const r of doc.records){const k=recordKey(r);local.set(k,[...(local.get(k)??[]),r])}
  for(const [k,v] of local)owners.set(k,v);
 }
 const values=[...owners.values()].flat();return values.map(r=>{if(r.branchCode||r.metric!=='package_detail')return r;const candidates=values.filter(x=>x.metric==='package_summary'&&x.entityId===r.entityId&&x.periodStart===r.periodStart&&x.periodEnd===r.periodEnd&&x.branchCode);const codes=[...new Set(candidates.map(x=>x.branchCode))];return codes.length===1?{...r,branchCode:codes[0]}:r});
}
export function reconciliationIssues(records:DataRecord[]):string[]{
 const issues:string[]=[];
 for(const s of records.filter(r=>r.metric==='package_summary')){
  const summaries=records.filter(r=>r.metric==='package_summary'&&r.entityId===s.entityId&&r.periodStart===s.periodStart&&r.periodEnd===s.periodEnd);
  if(new Set(summaries.map(r=>r.branchCode)).size>1){issues.push(`${s.entityName}: أكثر من فرع لنفس الفترة؛ راجع توزيع التفاصيل قبل الجمع`);continue}
  const details=records.filter(r=>r.metric==='package_detail'&&r.entityId===s.entityId&&r.periodStart===s.periodStart&&r.periodEnd===s.periodEnd&&(!r.branchCode||!s.branchCode||r.branchCode===s.branchCode));
  if(!details.length)continue;
  const amount=details.reduce((v,r)=>v+(r.amount??0),0),quantity=details.reduce((v,r)=>v+(r.quantity??0),0);
  if(Math.abs(amount-(s.amount??0))>.02||quantity!==s.quantity)issues.push(`${s.entityName}: اختلاف بين التفاصيل (${money(amount)} / ${quantity} باقة) والملخص (${money(s.amount)} / ${s.quantity} باقة)`);
 }
 return [...new Set(issues)];
}
