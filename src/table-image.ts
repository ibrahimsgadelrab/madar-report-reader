export type PixelImage={data:Uint8Array|Uint8ClampedArray;width:number;height:number};
export type TableGrid={xs:number[];ys:number[]};
function peaks(counts:number[],threshold:number){const result:number[]=[];let start=-1;for(let i=0;i<=counts.length;i++){if(i<counts.length&&counts[i]>=threshold){if(start<0)start=i}else if(start>=0){result.push(Math.round((start+i-1)/2));start=-1}}return result}
export function detectGrid(image:PixelImage,minRows=20):TableGrid|null{
 const {data,width,height}=image;const vx=new Array(width).fill(0),hy=new Array(height).fill(0);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=(y*width+x)*4;const r=data[p],g=data[p+1],b=data[p+2];if(Math.max(r,g,b)<210&&Math.max(r,g,b)-Math.min(r,g,b)<55){vx[x]++;hy[y]++}}
 const xs=peaks(vx,height*.70),ys=peaks(hy,width*.64);
 if(xs.length<5||ys.length<minRows)return null;
 if(xs[0]>3)xs.unshift(0);if(xs.at(-1)!<width-3)xs.push(width-1);
 if(ys[0]>3)ys.unshift(0);if(ys.at(-1)!<height-3)ys.push(height-1);
 return {xs,ys};
}
// Remove grid/background interference without changing the original image.
export function cleanTable(image:PixelImage,grid:TableGrid):Uint8ClampedArray{
 const {data,width,height}=image;const out=new Uint8ClampedArray(data.length);out.fill(255);
 for(let row=0;row<grid.ys.length-1;row++)for(let col=0;col<grid.xs.length-1;col++){
  const left=grid.xs[col]+3,right=grid.xs[col+1]-2,top=grid.ys[row]+3,bottom=grid.ys[row+1]-2;
  let dark=0,count=0;for(let y=top;y<bottom;y+=3)for(let x=left;x<right;x+=3){const p=(y*width+x)*4;if(data[p]*.299+data[p+1]*.587+data[p+2]*.114<110)dark++;count++}
  const invert=count>0&&dark/count>.55;
  for(let y=top;y<bottom;y++)for(let x=left;x<right;x++){const p=(y*width+x)*4;const luma=data[p]*.299+data[p+1]*.587+data[p+2]*.114;const value=invert?Math.max(0,Math.min(255,255-(luma-60)*255/195)):Math.min(255,luma*255/150);out[p]=out[p+1]=out[p+2]=value;out[p+3]=255}
 }
 return out;
}
