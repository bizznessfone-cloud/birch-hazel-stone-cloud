// Offline QR encoder derived from Kazuhiko Arase's qrcode-generator lineage.
// Zero runtime dependencies. Model 2, byte mode, error correction level M.
// The caller paints the returned boolean module matrix.
const EXP = new Array(256);
const LOG = new Array(256);
for (let i = 0; i < 8; i++) EXP[i] = 1 << i;
for (let i = 8; i < 256; i++) EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8];
for (let i = 0; i < 255; i++) LOG[EXP[i]] = i;
function gexp(n:number){while(n<0)n+=255;while(n>=256)n-=255;return EXP[n]}
function glog(n:number){if(n<1)throw new Error("glog("+n+")");return LOG[n]}
function poly(n:number[],shift:number){let o=0;while(o<n.length&&n[o]===0)o++;const r=new Array(n.length-o+shift);for(let i=0;i<n.length-o;i++)r[i]=n[i+o];return r}
function mul(a:number[],b:number[]){const r=new Array(a.length+b.length-1).fill(0);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)r[i+j]^=gexp(glog(a[i])+glog(b[j]));return poly(r,0)}
function mod(a:number[],e:number[]):number[]{if(a.length<e.length)return a;const ratio=glog(a[0])-glog(e[0]),r=a.slice();for(let i=0;i<e.length;i++)r[i]^=gexp(glog(e[i])+ratio);return mod(poly(r,0),e)}
function rsPoly(n:number){let a=[1];for(let i=0;i<n;i++)a=mul(a,[1,gexp(i)]);return a}
type Bits={buffer:number[];length:number};
function bit(b:Bits,v:boolean){const i=Math.floor(b.length/8);if(b.buffer.length<=i)b.buffer.push(0);if(v)b.buffer[i]|=0x80>>(b.length%8);b.length++}
function put(b:Bits,n:number,len:number){for(let i=0;i<len;i++)bit(b,((n>>>(len-i-1))&1)===1)}
const RS=[
 [[1,26,16]],[[1,44,28]],[[1,70,44]],[[2,50,32]],[[2,67,43]],
 [[4,43,27]],[[4,49,31]],[[2,60,38],[2,61,39]],
 [[3,58,36],[2,59,37]],[[4,69,43],[1,70,44]]
] as const;
const ALIGN=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]] as const;
function blocks(t:number){const r:{totalCount:number;dataCount:number}[]=[];for(const [c,total,data] of RS[t-1])for(let i=0;i<c;i++)r.push({totalCount:total,dataCount:data});return r}
const G15=(1<<10)|(1<<8)|(1<<5)|(1<<4)|(1<<2)|(1<<1)|1;
const G15MASK=(1<<14)|(1<<12)|(1<<10)|(1<<4)|(1<<1);
const G18=(1<<12)|(1<<11)|(1<<10)|(1<<9)|(1<<8)|(1<<5)|(1<<2)|1;
function digit(n:number){let d=0;while(n){d++;n>>>=1}return d}
function typeInfo(n:number){let d=n<<10;while(digit(d)-digit(G15)>=0)d^=G15<<(digit(d)-digit(G15));return((n<<10)|d)^G15MASK}
function typeNumber(n:number){let d=n<<12;while(digit(d)-digit(G18)>=0)d^=G18<<(digit(d)-digit(G18));return(n<<12)|d}
function maskFn(mask:number,i:number,j:number){switch(mask){case 0:return(i+j)%2===0;case 1:return i%2===0;case 2:return j%3===0;case 3:return(i+j)%3===0;case 4:return(Math.floor(i/2)+Math.floor(j/3))%2===0;case 5:return((i*j)%2)+((i*j)%3)===0;case 6:return(((i*j)%2)+((i*j)%3))%2===0;case 7:return(((i*j)%3)+((i+j)%2))%2===0;default:throw new Error("bad mask")}}
function utf8(s:string){const r:number[]=[];for(let i=0;i<s.length;i++){let c=s.charCodeAt(i);if(c<0x80)r.push(c);else if(c<0x800)r.push(0xc0|(c>>6),0x80|(c&63));else if(c<0xd800||c>=0xe000)r.push(0xe0|(c>>12),0x80|((c>>6)&63),0x80|(c&63));else{i++;c=0x10000+(((c&1023)<<10)|(s.charCodeAt(i)&1023));r.push(0xf0|(c>>18),0x80|((c>>12)&63),0x80|((c>>6)&63),0x80|(c&63))}}return r}
function chooseType(len:number){for(let t=1;t<=10;t++){const cap=blocks(t).reduce((s,b)=>s+b.dataCount,0);if(4+(t<10?8:16)+len*8<=cap*8)return t}throw new Error("QR payload too large")}
function bytes(bits:Bits,bs:number[],bl:{totalCount:number;dataCount:number}[]){let off=0,maxD=0,maxE=0;const dc:number[][]=[],ec:number[][]=[];for(const b of bl){const d=b.dataCount,e=b.totalCount-d.dataCount;maxD=Math.max(maxD,d);maxE=Math.max(maxE,e);const x:number[]=[];for(let i=0;i<d;i++)x.push(255&bits.buffer[i+off]);off+=d;const m=mod(poly(x,e),rsPoly(e));const y:number[]=[];for(let i=0;i<e;i++){const k=i+m.length-e;y.push(k>=0?m[k]:0)}dc.push(x);ec.push(y)}const out:number[]=[];for(let i=0;i<maxD;i++)for(const d of dc)if(i<d.length)out.push(d[i]);for(let i=0;i<maxE;i++)for(const e of ec)if(i<e.length)out.push(e[i]);return out}
function createData(t:number,raw:number[]){const bl=blocks(t),b={buffer:[] as number[],length:0};put(b,4,4);put(b,raw.length,t<10?8:16);for(const x of raw)put(b,x,8);const cap=bl.reduce((s,x)=>s+x.dataCount,0)*8;if(b.length>cap)throw new Error("QR data overflow");if(b.length+4<=cap)put(b,0,4);while(b.length%8)bit(b,false);while(b.buffer.length<cap/8)b.buffer.push(b.buffer.length%2===0?0xec:0x11);return bytes(b,raw.length?b.buffer.map((x)=>x):[],bl)}
function modules(t:number,data:number[],mask:number){const n=t*4+17,m:(boolean|null)[][]=Array.from({length:n},()=>Array(n).fill(null));const finder=(rr:number,cc:number)=>{for(let r=-1;r<=7;r++)for(let c=-1;c<=7;c++){if(rr+r<0||n<=rr+r||cc+c<0||n<=cc+c)continue;m[rr+r][cc+c]=(r>=0&&r<=6&&(c===0||c===6))||(c>=0&&c<=6&&(r===0||r===6))||(r>=2&&r<=4&&c>=2&&c<=4)}};finder(0,0);finder(n-7,0);finder(0,n-7);for(const rr of ALIGN[t-1])for(const cc of ALIGN[t-1])if(m[rr][cc]===null)for(let r=-2;r<=2;r++)for(let c=-2;c<=2;c++)m[rr+r][cc+c]=r===-2||r===2||c===-2||c===2||(r===0&&c===0);for(let r=8;r<n-8;r++)if(m[r][6]===null)m[r][6]=r%2===0;for(let c=8;c<n-8;c++)if(m[6][c]===null)m[6][c]=c%2===0;if(t>=7){const v=typeNumber(t);for(let i=0;i<18;i++){const z=((v>>i)&1)===1;m[Math.floor(i/3)][i%3+n-11]=z;m[i%3+n-11][Math.floor(i/3)]=z}}const f=typeInfo(mask);for(let i=0;i<15;i++){const z=((f>>i)&1)===1;if(i<6)m[i][8]=z;else if(i<8)m[i+1][8]=z;else m[n-15+i][8]=z}for(let i=0;i<15;i++){const z=((f>>i)&1)===1;if(i<8)m[8][n-i-1]=z;else if(i<9)m[8][15-i-1+1]=z;else m[8][15-i-1]=z}m[n-8][8]=true;let inc=-1,row=n-1,bi=7,by=0;for(let col=n-1;col>0;col-=2){if(col===6)col--;while(true){for(let c=0;c<2;c++)if(m[row][col-c]===null){let d=by<data.length&&(((data[by]>>>bi)&1)===1);if(maskFn(mask,row,col-c))d=!d;m[row][col-c]=d;bi--;if(bi===-1){by++;bi=7}}row+=inc;if(row<0||n<=row){row-=inc;inc=-inc;break}}}return m.map(r=>r.map(v=>v===true))}
function penalty(m:boolean[][]){const n=m.length;let p=0;for(let r=0;r<n;r++)for(let c=0;c<n;c++){let s=0;for(let rr=-1;rr<=1;rr++)for(let cc=-1;cc<=1;cc++)if(!(rr===0&&cc===0)&&r+rr>=0&&r+rr<n&&c+cc>=0&&c+cc<n&&m[r][c]===m[r+rr][c+cc])s++;if(s>5)p+=3+s-5}for(let r=0;r<n-1;r++)for(let c=0;c<n-1;c++){const s=Number(m[r][c])+Number(m[r+1][c])+Number(m[r][c+1])+Number(m[r+1][c+1]);if(s===0||s===4)p+=3}for(let r=0;r<n;r++)for(let c=0;c<n-6;c++)if(m[r][c]&&!m[r][c+1]&&m[r][c+2]&&m[r][c+3]&&m[r][c+4]&&!m[r][c+5]&&m[r][c+6])p+=40;for(let c=0;c<n;c++)for(let r=0;r<n-6;r++)if(m[r][c]&&!m[r+1][c]&&m[r+2][c]&&m[r+3][c]&&m[r+4][c]&&!m[r+5][c]&&m[r+6][c])p+=40;let dark=0;for(const r of m)for(const x of r)if(x)dark++;return p+Math.abs((100*dark)/(n*n)-50)/5*10}
export function qrMatrix(text:string){const raw=utf8(String(text)),t=chooseType(raw.length),d=createData(t,raw);let best=modules(t,d,0),score=penalty(best);for(let mask=1;mask<8;mask++){const x=modules(t,d,mask),s=penalty(x);if(s<score){best=x;score=s}}return best}
