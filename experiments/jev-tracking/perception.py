"""Optional pixel-only perception. No goals, actor IDs, depths or action recommendations."""
import cv2, json, math, pathlib, sys, time, numpy as np
cv2.setNumThreads(1)
cv2.setRNGSeed(7)

def overlap(a,b):
    inter=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    return inter/max(1,(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter)
def centre(b): return np.array([(b[0]+b[2])/2,(b[1]+b[3])/2])
def corners(b): return np.float32([[b[0],b[1]],[b[2],b[1]],[b[2],b[3]],[b[0],b[3]]])
def bearing(b,k):
    c=centre(b)
    return round(math.degrees(math.atan((c[0]-k['cx'])/k['fx'])),2),round(math.degrees(math.atan((k['cy']-c[1])/k['fy'])),2)
def plain(value):
    if isinstance(value,np.ndarray): return value.tolist()
    if isinstance(value,np.generic): return value.item()
    raise TypeError(type(value).__name__)

class Perception:
    def __init__(self,mode='klt',models=None):
        self.mode=mode;self.models=models;self.prev=None;self.tracks=[];self.next_id=0;self.previous_ms=-1
    def nano(self,image,box):
        params=cv2.TrackerNano_Params()
        params.backbone=str(pathlib.Path(self.models)/'nanotrack_backbone_sim.onnx')
        params.neckhead=str(pathlib.Path(self.models)/'nanotrack_head_sim.onnx')
        tracker=cv2.TrackerNano_create(params)
        x1,y1,x2,y2=map(int,box);tracker.init(image,(x1,y1,max(2,x2-x1),max(2,y2-y1)))
        return tracker
    def update(self,request):
        started=time.perf_counter();image=cv2.imread(request['file']);assert image is not None
        gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY);at=request['acquiredMs'];k=request['calibration'];raw=list(request['objects']);assert at>self.previous_ms
        if self.mode=='colour':
            self.previous_ms=at
            return {'objects':raw,'lostTracks':[],'overflow':0,'method':'colour','processingMs':1000*(time.perf_counter()-started)}
        # Generic achromatic edge components, not simulator colours or object labels.
        hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
        contours,_=cv2.findContours(cv2.Canny(gray,40,100),cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x,y,w,h=cv2.boundingRect(contour)
            if w<4 or h<4 or w*h<25 or w*h>gray.size*.75:continue
            crop=hsv[y+1:y+h-1,x+1:x+w-1]
            if not crop.size or float(np.median(crop[:,:,1]))>60:continue
            box=[x,y,x+w,y+h]
            if any(overlap(box,r['box'])>.5 for r in raw):continue
            right,up=bearing(box,k)
            raw.append({'id':f'n{len(raw)}','color':'neutral','box':box,'pixels':int(w*h),'rightDeg':right,'upDeg':up,'widthPercent':round(w/image.shape[1]*100,2),'clipped':x==0 or y==0 or x+w>=image.shape[1] or y+h>=image.shape[0],'history':[]})
        self.tracks=[t for t in self.tracks if at-t['seen']<=8000]
        for t in self.tracks:
            t['support']=0;t['survival']=0.;t['residual']=None;t['score']=None;t['prediction']=None
            if self.mode=='nano':
                ok,box=t['nano'].update(image);t['score']=float(t['nano'].getTrackingScore())
                if ok and t['score']>=.5:
                    x,y,w,h=box;t['prediction']=[x,y,x+w,y+h];t['support']=1
            elif self.prev is not None and t['points'] is not None and len(t['points'])>=3:
                p=t['points'];q,s,_=cv2.calcOpticalFlowPyrLK(self.prev,gray,p,None,winSize=(21,21),maxLevel=3)
                if q is not None:
                    back,s2,_=cv2.calcOpticalFlowPyrLK(gray,self.prev,q,None,winSize=(21,21),maxLevel=3)
                    if back is not None:
                        residual=np.linalg.norm((back-p).reshape(-1,2),axis=1)
                        valid=(s.ravel()>0)&(s2.ravel()>0)&(residual<1.5)
                        valid &= (q[:,0,0]>=0)&(q[:,0,0]<gray.shape[1])&(q[:,0,1]>=0)&(q[:,0,1]<gray.shape[0])
                        t['support']=int(valid.sum());t['survival']=float(valid.mean());t['residual']=float(np.median(residual[valid])) if valid.any() else None
                        if valid.sum()>=3:
                            cv2.setRNGSeed(7)
                            m,inliers=cv2.estimateAffinePartial2D(p[valid],q[valid],method=cv2.RANSAC,ransacReprojThreshold=2)
                            if m is not None and .65<math.hypot(m[0,0],m[0,1])<1.5:
                                points=cv2.transform(corners(t['extent']).reshape(1,-1,2),m).reshape(-1,2)
                                t['prediction']=[float(points[:,0].min()),float(points[:,1].min()),float(points[:,0].max()),float(points[:,1].max())]
        available=list(self.tracks);objects=[]
        for r in raw:
            candidates=[]
            for t in available:
                if t['color']!=r['color']:continue
                box=t['prediction'] or t['box'];distance=float(np.linalg.norm(centre(box)-centre(r['box'])));iou=overlap(box,r['box'])
                if distance<40 and (iou>.05 or distance<12):candidates.append((iou-distance/400,t))
            candidates.sort(key=lambda x:x[0],reverse=True)
            ambiguous=len(candidates)>1 and candidates[0][0]-candidates[1][0]<.1
            t=candidates[0][1] if candidates and not ambiguous else None
            if t is not None:available.remove(t)
            else:
                self.next_id+=1;t={'id':f'k{self.next_id}','color':r['color'],'seen':at,'box':r['box'],'extent':r['box'],'history':[],'points':None,'support':0,'survival':0.,'residual':None,'score':None,'prediction':None}
                if self.mode=='nano':t['nano']=self.nano(image,r['box'])
                self.tracks.append(t)
            predicted=t['prediction'];ratio=(r['box'][2]-r['box'][0])/max(1,(predicted[2]-predicted[0])) if predicted else None
            shrink=ratio is not None and ratio<.75
            foreign_overlap=bool(predicted and any(o is not r and overlap(predicted,o['box'])>.05 for o in raw))
            uncertain=bool(r['clipped'] or shrink or foreign_overlap or ambiguous)
            # Keep extent predictions separate. Actual aiming bearings remain measured visible-region bearings.
            extent=predicted if uncertain and predicted else r['box']
            history=[{'ageMs':at-h['at'],'rightDeg':h['rightDeg'],'upDeg':h['upDeg'],'widthPercent':h['widthPercent']} for h in t['history'][-3:]]
            measured={**r,'id':t['id'],'history':history,'measurement':'observed','extentQuality':'uncertain' if uncertain else 'unflagged-visible-extent',
                'possibleOcclusion':bool(shrink or foreign_overlap),'associationAmbiguous':ambiguous,
                'tracking':{'method':self.mode,'validFeatures':t['support'],'featureSurvival':round(t['survival'],3),'forwardBackwardErrorPx':None if t['residual'] is None else round(t['residual'],3),'score':None if t['score'] is None else round(t['score'],3)},
                'estimatedExtent':None if predicted is None else {'box':[round(float(v),2) for v in predicted],'basis':'image-tracker prediction, not visible boundary or metric size'}}
            objects.append(measured)
            mask=np.zeros_like(gray);x1,y1,x2,y2=map(int,r['box']);mask[max(0,y1):min(gray.shape[0],y2),max(0,x1):min(gray.shape[1],x2)]=255
            t['points']=cv2.goodFeaturesToTrack(gray,maxCorners=40,qualityLevel=.01,minDistance=3,mask=mask,blockSize=3)
            t.update({'seen':at,'box':r['box'],'extent':extent,'history':(t['history']+[{'at':at,'rightDeg':r['rightDeg'],'upDeg':r['upDeg'],'widthPercent':r['widthPercent']}])[-3:]})
        lost=[]
        for t in available:
            right,up=bearing(t['box'],k)
            lost.append({'id':t['id'],'color':t['color'],'measurement':'predicted' if t['prediction'] else 'lost','lastSeenMs':t['seen'],'ageMs':at-t['seen'],'lastRightDeg':right,'lastUpDeg':up,'currentLocation':'unknown','predictedBox':t['prediction']})
            t['points']=None
        self.prev=gray;self.previous_ms=at
        overflow=max(0,len(self.tracks)-24)
        if overflow:self.tracks=[];objects=[];lost=[]
        return {'objects':objects,'lostTracks':lost,'overflow':overflow,'method':self.mode,'processingMs':1000*(time.perf_counter()-started)}

if __name__=='__main__':
    mode=sys.argv[1] if len(sys.argv)>1 else 'klt';tracker=Perception(mode,sys.argv[2] if len(sys.argv)>2 else None)
    print(json.dumps({'ready':True,'opencv':cv2.__version__,'numpy':np.__version__}),flush=True)
    for line in sys.stdin:
        try:
            req=json.loads(line);answer=tracker.update(req);print(json.dumps({'id':req['id'],'result':answer},default=plain,allow_nan=False),flush=True)
        except Exception as error:
            print(json.dumps({'error':str(error)}),flush=True);sys.exit(1)
