"""No ground-truth import: image/calibration/model-output measurements only."""
import math
import cv2
import numpy as np

CONFIG = dict(blueHSVLow=[90,80,45],blueHSVHigh=[135,255,255],componentMinimumPixels=100,
              erodePixels=3,minimumValidFraction=.5,quantiles=[.1,.9],stereoDisparityExpansionPx=.5,
              depthConvention='camera-forward axial Z in metres; camera-relative bearing negative left',
              model=dict(encoder='vits',features=64,out_channels=[48,96,192,384],max_depth=80,input_size=518,threads=8,device='cpu',dtype='float32',groundTruthScaleFit=False),
              preview=dict(scaleMinimumM=0,scaleMaximumM=25,invalidColor='black',meaning='clipped fixed-scale color map, not metric data'))


def target(image,cal):
    hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    blue=cv2.inRange(hsv,np.array(CONFIG['blueHSVLow'],np.uint8),np.array(CONFIG['blueHSVHigh'],np.uint8))
    n,labels,stats,centroids=cv2.connectedComponentsWithStats(blue,8)
    eligible=[i for i in range(1,n) if stats[i,cv2.CC_STAT_AREA]>=CONFIG['componentMinimumPixels']]
    if len(eligible)!=1:
        return ('missing' if not eligible else 'ambiguous'),np.zeros(blue.shape,bool),None
    label=eligible[0]
    roi=cv2.erode((labels==label).astype(np.uint8),np.ones((7,7),np.uint8)).astype(bool)
    bearing=math.degrees(math.atan((float(centroids[label][0])-cal['cx'])/cal['fx']))
    return 'single',roi,bearing


def observe(image,cal,depth,valid,method,disparity=None):
    status,roi,bearing=target(image,cal)
    valid=valid&np.isfinite(depth)&(depth>0)
    support=roi&valid
    fraction=float(support.sum()/roi.sum()) if roi.any() else 0.
    median=None; interval=None
    if status=='single' and fraction>=CONFIG['minimumValidFraction']:
        median=float(np.median(depth[support]))
        if method=='stereo':
            lo,hi=np.quantile(disparity[support]+cal['doffsPx'],CONFIG['quantiles'])
            fb=cal['fx']*cal['baselineM']
            if lo>.5:
                interval=[float(fb/(hi+.5)),float(fb/(lo-.5))]
            else:
                median=None
        else:
            interval=list(map(float,np.quantile(depth[support],CONFIG['quantiles'])))
    meaning=('ROI disparity q10/q90 expanded by +/-0.5 pixel and inverted to axial metres; descriptive algorithmic band, not calibrated confidence' if method=='stereo' else 'ROI depth q10/q90 descriptive spatial spread, not a confidence interval or calibrated uncertainty; dense finite output is not certainty')
    return dict(source='rendered_rgb',targetStatus=status,axialDepthIntervalM=interval,axialDepthM=median,validFraction=fraction,bearingDeg=bearing,intervalMeaning=meaning),roi


def preview(depth,valid):
    positive=valid&np.isfinite(depth)&(depth>0)
    values=np.zeros(depth.shape,np.uint8)
    values[positive]=np.clip(depth[positive]/25*255,0,255).astype(np.uint8)
    rgb=cv2.applyColorMap(values,cv2.COLORMAP_TURBO);rgb[~positive]=0
    return rgb
