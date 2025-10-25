// contentScript.js
// Full-page screenshot with:
// - Pre-scroll (lazy-load friendly)
// - Hard-coded zoom scale = 1 / 1.5
// - Safe stitched export (PNG → WebP → split ≤19 MB)

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  const MAX_BYTES = 19 * 1024 * 1024;   // 19 MB limit
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY = 0.92;
  const SAFE_CANVAS_HEIGHT = 30000;     // Chrome GPU limit

  let lastCaptureTs = 0;

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.action === "start-capture") {
      startCapture().catch(err => {
        console.error("Capture failed", err);
        alert("Capture failed: " + (err?.message || err));
      });
    }
  });

  function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

  async function safeCapture(){
    const now = Date.now();
    const since = now - lastCaptureTs;
    if(since < CAPTURE_DELAY_MS) await wait(CAPTURE_DELAY_MS - since);

    for(let attempt=1; attempt<=CAPTURE_MAX_RETRIES; attempt++){
      const res = await new Promise(r=>chrome.runtime.sendMessage({action:"capture-visible"},resp=>r(resp)));
      lastCaptureTs = Date.now();
      if(res?.success) return res.dataUrl;
      if(attempt === CAPTURE_MAX_RETRIES) throw new Error(res?.error || "Unknown capture error");
      await wait(CAPTURE_RETRY_BASE_DELAY * Math.pow(2, attempt-1));
    }
    throw new Error("capture failed unexpectedly");
  }

  function loadImage(dataUrl){
    return new Promise((resolve,reject)=>{
      const img=new Image();
      img.onload=()=>resolve(img);
      img.onerror=reject;
      img.src=dataUrl;
    });
  }

  function canvasToBlob(canvas,type="image/png",quality=0.92){
    return new Promise(r=>canvas.toBlob(b=>r(b),type,quality));
  }

  function downloadBlob(blob,filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href=url; a.download=filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
  }

  function detectScrollContainer(){
    let best = document.scrollingElement || document.documentElement;
    let maxScroll = best.scrollHeight || 0;
    const els = Array.from(document.querySelectorAll("body,html,div,main,section,article"));
    for(const el of els){
      try{
        if(el.scrollHeight > maxScroll){ maxScroll=el.scrollHeight; best=el; }
      }catch{}
    }
    return best;
  }

  async function preScrollAndStabilize(scrollEl,{stepPx=null,stabilizeRounds=2,waitPerStepMs=500}={}){
    const origTop = scrollEl.scrollTop;
    const origOverflow = scrollEl.style.overflow;
    scrollEl.style.overflow="hidden";

    const viewportH = window.innerHeight;
    if(!stepPx) stepPx = viewportH;

    try{scrollEl.scrollTo({top:0,left:0,behavior:"instant"});await wait(120);}catch{}
    let lastHeight=Math.max(scrollEl.scrollHeight,document.documentElement.scrollHeight);
    let stable=0,y=0;

    while(y<lastHeight-1){
      y=Math.min(y+stepPx,lastHeight-viewportH);
      scrollEl.scrollTo({top:y,left:0,behavior:"instant"});
      await wait(waitPerStepMs);
      const h=Math.max(scrollEl.scrollHeight,document.documentElement.scrollHeight);
      if(h!==lastHeight){ lastHeight=h; stable=0; }
      if(y>=lastHeight-viewportH-1){ stable++; if(stable>=stabilizeRounds) break; }
    }
    scrollEl.scrollTo({top:lastHeight-viewportH,left:0,behavior:"instant"});
    await wait(waitPerStepMs);

    const finalH=Math.max(scrollEl.scrollHeight,document.documentElement.scrollHeight);
    const positions=[];
    for(let p=0;p<finalH;p+=viewportH){
      positions.push(Math.min(p,finalH-viewportH));
      if(p+viewportH>=finalH) break;
    }

    scrollEl.scrollTo({top:origTop,left:0,behavior:"instant"});
    scrollEl.style.overflow=origOverflow;
    return {finalHeight:finalH,positions,viewportH};
  }

  async function stitchAndExportBlobs(images){
    const width=Math.max(...images.map(i=>i.width));
    const totalH=images.reduce((s,it)=>s+it.height,0);

    async function makeCanvas(imgs,mime="image/png",q=0.92){
      const w=Math.max(...imgs.map(i=>i.width));
      const h=imgs.reduce((s,it)=>s+it.height,0);
      const c=document.createElement("canvas");
      c.width=w; c.height=h;
      const ctx=c.getContext("2d");
      let y=0;
      for(const it of imgs){ ctx.drawImage(it.img,0,y,it.width,it.height); y+=it.height; }
      const b=await canvasToBlob(c,mime,q);
      return {blob:b,width:w,height:h};
    }

    if(totalH<=SAFE_CANVAS_HEIGHT){
      const png=await makeCanvas(images,"image/png",0.92);
      if(png.blob.size<=MAX_BYTES) return [{blob:png.blob,mime:"image/png"}];
      const webp=await makeCanvas(images,"image/webp",WEBP_QUALITY);
      if(webp.blob.size<=MAX_BYTES) return [{blob:webp.blob,mime:"image/webp"}];
      return [{blob:webp.blob,mime:"image/webp"}];
    }

    const parts=[];
    let cursor=0;
    while(cursor<totalH){
      const h=Math.min(SAFE_CANVAS_HEIGHT,totalH-cursor);
      const c=document.createElement("canvas");
      c.width=width; c.height=h;
      const ctx=c.getContext("2d");
      let yTile=0,acc=0;
      for(const it of images){
        const top=acc,bottom=acc+it.height; acc+=it.height;
        const tTop=cursor,tBot=cursor+h;
        const iTop=Math.max(tTop,top),iBot=Math.min(tBot,bottom);
        if(iBot>iTop){
          const srcY=iTop-top,drawH=iBot-iTop;
          ctx.drawImage(it.img,0,srcY,it.width,drawH,0,yTile,it.width,drawH);
          yTile+=drawH; if(yTile>=h) break;
        }
      }
      const tile=await canvasToBlob(c,"image/webp",WEBP_QUALITY);
      parts.push({blob:tile,mime:"image/webp"});
      cursor+=h;
    }
    return parts;
  }

  async function splitIntoSizedWebPs(images){
    const result=[]; let current=[];
    for(let i=0;i<images.length;i++){
      const candidate=images[i];
      const batch=current.concat([candidate]);
      const parts=await stitchAndExportBlobs(batch);
      const size=parts.reduce((s,p)=>s+(p.blob?.size||0),0);
      if(size<=MAX_BYTES){ current=batch; }
      else{
        if(current.length===0){
          const it=candidate;
          const tmp=document.createElement("canvas");
          tmp.width=Math.floor(it.width/2); tmp.height=Math.floor(it.height/2);
          tmp.getContext("2d").drawImage(it.img,0,0,tmp.width,tmp.height);
          const scaled=await canvasToBlob(tmp,"image/webp",Math.max(0.75,WEBP_QUALITY-0.1));
          result.push({blob:scaled,mime:"image/webp"});
        }else{
          const final=await stitchAndExportBlobs(current);
          for(const p of final) result.push({blob:p.blob,mime:p.mime});
          current=[candidate];
        }
      }
    }
    if(current.length>0){
      const final=await stitchAndExportBlobs(current);
      for(const p of final) result.push({blob:p.blob,mime:p.mime});
    }
    return result;
  }

  async function startCapture(){
    const scrollEl=detectScrollContainer();
    const origScroll=scrollEl.scrollTop;
    const origOverflow=scrollEl.style.overflow;
    const origZoom=document.documentElement.style.zoom || "";

    try{
      // --- Hard-code effective DPR = 1.5 (zoom out to 1/1.5 ≈ 0.6667) ---
      document.documentElement.style.zoom = (1/1.5).toString();
      console.log("[Fixed Zoom] Applying zoom scale 0.667 for DPR≈1.5");
      await wait(300);

      const pre=await preScrollAndStabilize(scrollEl,{stabilizeRounds:2,waitPerStepMs:550});
      console.log("[preScroll] Final height:",pre.finalHeight,"positions:",pre.positions.length);

      const dataUrls=[];
      for(let i=0;i<pre.positions.length;i++){
        const y=pre.positions[i];
        scrollEl.scrollTo({top:y,left:0,behavior:"instant"});
        await new Promise(r=>requestAnimationFrame(()=>setTimeout(r,420)));
        const d=await safeCapture();
        dataUrls.push(d);
      }

      const imgs=[];
      for(const d of dataUrls){ const img=await loadImage(d); imgs.push({img,width:img.width,height:img.height}); }

      const stitched=await stitchAndExportBlobs(imgs);

      if(stitched.length===1 && stitched[0].mime==="image/png" && stitched[0].blob.size<=MAX_BYTES){
        const name=`${(new URL(location.href)).hostname.replace(/\./g,"_")}_fullpage.png`;
        downloadBlob(stitched[0].blob,name); alert("Saved PNG (under limit)."); return;
      }
      if(stitched.length===1 && stitched[0].mime.includes("webp") && stitched[0].blob.size<=MAX_BYTES){
        const name=`${(new URL(location.href)).hostname.replace(/\./g,"_")}_fullpage.webp`;
        downloadBlob(stitched[0].blob,name); alert("Saved WebP (single file)."); return;
      }

      const parts=await splitIntoSizedWebPs(imgs);
      for(let i=0;i<parts.length;i++){
        const p=parts[i];
        const ext=p.mime.includes("webp")?"webp":"png";
        const name=`${(new URL(location.href)).hostname.replace(/\./g,"_")}_part${i+1}.${ext}`;
        downloadBlob(p.blob,name);
      }
      alert(`Saved ${parts.length} image(s).`);
    }finally{
      scrollEl.style.overflow=origOverflow;
      scrollEl.scrollTo({top:origScroll,left:0,behavior:"instant"});
      document.documentElement.style.zoom = origZoom;
    }
  }
})();
