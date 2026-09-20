"""One physical scene sampled at three resolutions from common finest samples."""
from __future__ import annotations
import itertools
import cv2
import numpy as np

BASE=dict(width=320,height=180,fx=200.,fy=200.,cx=159.5,cy=89.5,
          baselineM=.06,doffsPx=0.,rectified=True)
MASTER_SCALE=16
TILE_ROWS=128
PHYSICS=dict(nearM=1.17,backgroundM=5.2,seed=120731,textureSamplesPerM=240.,
             halfHeightM=45*1.17/200.,cameraSkewMs=0)


def calibration(scale):
    return dict(BASE,width=BASE["width"]*scale,height=BASE["height"]*scale,
                fx=BASE["fx"]*scale,fy=BASE["fy"]*scale,
                cx=(BASE["cx"]+.5)*scale-.5,cy=(BASE["cy"]+.5)*scale-.5)


def physical_scenes():
    return [dict(id=f"physical-{i}",baseWidthPx=width,basePositionPhasePx=phase,
                 poleWidthM=width*PHYSICS["nearM"]/BASE["fx"],
                 poleCenterXM=(160.+phase-BASE["cx"])*PHYSICS["nearM"]/BASE["fx"],**PHYSICS)
            for i,(width,phase) in enumerate(itertools.product((1,2),(0.,.25)))]


def specs():
    return [dict(id=f"resolution-{i:02d}",physicalId=scene["id"],scale=scale,
                 projectedWidthPx=scene["baseWidthPx"]*scale,calibration=calibration(scale),
                 numDisparities=64*scale)
            for i,(scene,scale) in enumerate(itertools.product(physical_scenes(),(1,2,4)))]


def render_master(scene):
    """Texture maps use metres, never scene/output pixel indices.

    A fixed 16x base-camera sample grid is the common integration measure. It
    gives 16/8/4 samples per axis in 1x/2x/4x images. Tile scratch allocation is
    bounded; two persistent sample images and the left hazard mask are ~45 MB.
    """
    cv2.setNumThreads(1)
    height,width=BASE["height"]*MASTER_SCALE,BASE["width"]*MASTER_SCALE
    rng=np.random.default_rng(scene["seed"])
    textures=[cv2.GaussianBlur(rng.integers(20,236,(1024,1024),dtype=np.uint8),(3,3),.55) for _ in range(2)]
    images=[];left_hazard=np.zeros((height,width),np.uint8)
    u=(np.arange(width,dtype=np.float32)+.5)/MASTER_SCALE-.5
    for eye,camera_x in enumerate((0.,BASE["baselineM"])):
        image=np.empty((height,width),np.uint8)
        for start in range(0,height,TILE_ROWS):
            end=min(height,start+TILE_ROWS)
            v=(np.arange(start,end,dtype=np.float32)+.5)/MASTER_SCALE-.5
            def plane(z,texture):
                x=np.broadcast_to((u-BASE["cx"])*z/BASE["fx"]+camera_x,(end-start,width))
                y=np.broadcast_to(((v-BASE["cy"])*z/BASE["fy"])[:,None],(end-start,width))
                values=cv2.remap(texture,(x*scene["textureSamplesPerM"]+512).astype(np.float32),
                                (y*scene["textureSamplesPerM"]+512).astype(np.float32),
                                cv2.INTER_LINEAR,borderMode=cv2.BORDER_WRAP)
                return x,y,values
            _,_,values=plane(scene["backgroundM"],textures[0])
            x,y,pole=plane(scene["nearM"],textures[1])
            half=scene["poleWidthM"]/2;center=scene["poleCenterXM"]
            hazard=(x>=center-half)&(x<center+half)&(np.abs(y)<scene["halfHeightM"])
            values[hazard]=pole[hazard]
            image[start:end]=values
            if eye==0:left_hazard[start:end]=hazard
        images.append(image)
    return images,left_hazard


def integrate(master,scale):
    step=MASTER_SCALE//scale
    h,w=BASE["height"]*scale,BASE["width"]*scale
    # Sums are exact integers; dyadic division is exact in float32 here.
    return master.reshape(h,step,w,step).sum(axis=(1,3),dtype=np.uint32).astype(np.float32)/(step*step)


def acquire(master_images,master_hazard,scene,scale):
    means=[integrate(image,scale) for image in master_images]
    images=[np.rint(mean).astype(np.uint8) for mean in means]
    fraction=integrate(master_hazard,scale)
    depth=np.full(fraction.shape,scene["backgroundM"],np.float32)
    depth[fraction>0]=scene["nearM"]
    return images,dict(depth=depth,hazardFraction=fraction,homogeneous=(fraction==0)|(fraction==1)),means


def equivalence(master_images,master_hazard,scene):
    data={scale:acquire(master_images,master_hazard,scene,scale) for scale in (1,2,4)}
    checks=[]
    for low,high in ((1,2),(2,4),(1,4)):
        ratio=high//low;h,w=BASE["height"]*low,BASE["width"]*low
        for eye in (0,1):
            coarse=data[high][2][eye].reshape(h,ratio,w,ratio).mean(axis=(1,3))
            np.testing.assert_array_equal(coarse,data[low][2][eye])
        coarse=data[high][1]["hazardFraction"].reshape(h,ratio,w,ratio).mean(axis=(1,3))
        np.testing.assert_array_equal(coarse,data[low][1]["hazardFraction"])
        checks.append(dict(low=low,high=high,exactPrequantizedImageMeans=True,exactHazardFootprintMass=True))
    return checks
