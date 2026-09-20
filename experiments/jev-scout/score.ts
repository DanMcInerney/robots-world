/** Posthoc scoring of the visible blue patch from recorded camera measurements, never a controller input. */
export function scoreScout(frames:any[],seconds:number,collisions:number,bounds:number,errors:number){
  let first:number|null=null,run=0,longest=0,framedMs=0,centredMs=0,visibleMs=0,postMs=0,lostStart:number|null=null,gapInLoss=false;
  const losses:{startMs:number;endMs:number|null;durationMs:number;recovered:boolean;includesCameraGap:boolean}[]=[],timeline:any[]=[],coverageGaps:{startMs:number;endMs:number}[]=[];
  const gap=(start:number,end:number)=>{if(end<=start)return;coverageGaps.push({startMs:start,endMs:end});run=0;
    if(first!==null){lostStart??=start;gapInLoss=true;}
    timeline.push({simMs:start,visible:false,centred:false,framed:false,widthPercent:null,measurement:'unknown-camera-coverage',untilMs:end});
  };
  for(let i=0;i<frames.length;i++){
    const f=frames[i],c=f.camera,k=c.calibration,blue=c.objects.filter((o:any)=>o.color==='blue');
    gap(i===0?0:frames[i-1].acquiredMs+250,f.acquiredMs);
    // This fixture contains exactly one blue actor. No goal-conditioned selection enters perception.
    const b=blue.length===1?blue[0]:null,dt=Math.min(250,(frames[i+1]?.acquiredMs??seconds*1000)-f.acquiredMs);
    const visible=!!b,centred=visible&&Math.abs(Math.tan(b.rightDeg*Math.PI/180)*k.fx/k.cx)<=.3&&Math.abs(Math.tan(b.upDeg*Math.PI/180)*k.fy/k.cy)<=.3;
    const framed=centred&&!b.clipped&&b.widthPercent>=8&&b.widthPercent<=14&&c.hfovDeg===70;
    if(visible&&first===null)first=f.acquiredMs;
    const continuous=i===0||f.acquiredMs-frames[i-1].acquiredMs<=250;
    run=framed?(continuous?run:0)+dt:0;longest=Math.max(longest,run);
    if(first!==null){postMs=seconds*1000-first;if(visible)visibleMs+=dt;if(centred)centredMs+=dt;if(framed)framedMs+=dt;
      if(!visible&&lostStart===null)lostStart=f.acquiredMs;
      if(visible&&lostStart!==null){if(f.acquiredMs-lostStart>=1000)losses.push({startMs:lostStart,endMs:f.acquiredMs,durationMs:f.acquiredMs-lostStart,recovered:true,includesCameraGap:gapInLoss});lostStart=null;gapInLoss=false;}
    }
    timeline.push({simMs:f.acquiredMs,visible,centred,framed,widthPercent:b?.widthPercent??null});
  }
  gap(frames.length?frames.at(-1).acquiredMs+250:0,seconds*1000);
  if(lostStart!==null&&seconds*1000-lostStart>=1000)losses.push({startMs:lostStart,endMs:null,durationMs:seconds*1000-lostStart,recovered:false,includesCameraGap:gapInLoss});
  const pass=first!==null&&first<=45000&&postMs>=30000&&framedMs/postMs>=.4&&longest>=2000&&!collisions&&!bounds&&!errors&&!losses.some(l=>l.durationMs>20000);
  return {success:pass,firstDetectionMs:first,postAcquisitionMs:postMs,visibleFraction:postMs?visibleMs/postMs:0,centredFraction:postMs?centredMs/postMs:0,
    framingFraction:postMs?framedMs/postMs:0,longestFramedMs:longest,losses,recovered:losses.filter(l=>l.recovered).length,collisionTicks:collisions,boundsTicks:bounds,timeline,coverageGaps,
    meaning:'Visible-patch detection/framing at acquired RGB samples; coverage beyond 250 ms after a frame is explicitly unknown and counts toward loss, including the tail. Coverage loss is not evidence of physical occlusion. One uniquely blue actor. Missing/ambiguous blue is not scored as observed. No geometric centre-ray or hidden full object size substituted.'};
}
