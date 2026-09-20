"""Image synthesis/evaluation fixtures. Never imported by perception."""
import math
import re
import cv2
import numpy as np
from common import ROOT, OUT, save, rel


def specs():
    result = []
    for split, depths, offset in [('development', [7.5,8.5,9.5,10.5,11.5,13.5], 0),
                                 ('confirmation', [7.8,8.8,9.8,10.8,11.8,13.8], 1000)]:
        items = [('nominal', z, b) for z,b in zip(depths, [-8,0,8,-8,0,8])]
        items += [('occlusion40', 8.2+(0.2 if offset else 0), -8), ('occlusion40',12.6+(0.2 if offset else 0),8),
                  ('lowtexture',10.2+(0.2 if offset else 0),0), ('ambiguous',10,0), ('missing',None,0), ('dark',10,0)]
        for i,(family,z,bearing) in enumerate(items):
            result.append(dict(id=f'{split[0]}{i+1:02}', split=split, family=family, z=z, bearing=bearing, seed=92601+offset+i))
    return result


def render(spec):
    w,h = 640,360
    f = w/(2*math.tan(math.radians(70)/2))
    cal = dict(fx=f,fy=f,cx=(w-1)/2,cy=(h-1)/2,width=w,height=h,baselineM=.20,doffsPx=0,rectified=True)
    rng = np.random.default_rng(spec['seed'])
    texture = [cv2.GaussianBlur(rng.integers(20,235,(1024,1024),dtype=np.uint8),(3,3),.5) for _ in range(4)]
    yy,xx = np.indices((h,w),dtype=np.float32)
    qx,qy = (xx-cal['cx'])/f, (yy-cal['cy'])/f
    planes = [dict(z=22,bounds=None,index=0,color='gray')]
    if spec['z'] is not None:
        z = spec['z']; x = z*math.tan(math.radians(spec['bearing']))
        planes.append(dict(z=z,bounds=[x-.9,x+.9,-.6,.6],index=1,color='blue'))
        if spec['family'] == 'ambiguous':
            planes = [planes[0],dict(z=9.1,bounds=[-2.8,-1.,-.6,.6],index=1,color='blue'),dict(z=12.2,bounds=[1,2.8,-.6,.6],index=2,color='blue')]
        if spec['family'] == 'occlusion40':
            # Genuine foreground occluder 0.6m in front. Scale world bounds to
            # cover exactly 40% of the left-view projected target width; the
            # synchronized right view receives its own parallax/visibility.
            occluder_z=z-.6; ratio=occluder_z/z
            planes.append(dict(z=occluder_z,bounds=[(x-.9)*ratio,(x-.9+.4*1.8)*ratio,-.6*ratio,.6*ratio],index=3,color='gray'))
    views = []
    for camera_x in (0,cal['baselineM']):
        output = np.zeros((h,w,3),np.uint8)
        truth = np.full((h,w),22,np.float32)
        for plane in planes:
            wx,wy = camera_x+qx*plane['z'], qy*plane['z']
            bounds = plane['bounds']
            mask = np.ones((h,w),bool) if bounds is None else ((wx>=bounds[0])&(wx<=bounds[1])&(wy>=bounds[2])&(wy<=bounds[3]))
            scalar = cv2.remap(texture[plane['index']], ((wx*140+512)%1024).astype(np.float32), ((wy*140+512)%1024).astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
            if plane['color']=='blue':
                if spec['family']=='lowtexture':
                    scalar[:] = 130
                value = np.stack([80+scalar*.65,20+scalar*.28,8+scalar*.12],axis=-1).astype(np.uint8)
            else:
                value = np.repeat(scalar[:,:,None],3,axis=2)
            output[mask] = value[mask]
            truth[mask] = plane['z']
        if spec['family']=='dark':
            output = (output*.03).astype(np.uint8)
        views.append((output,truth))
    return cal,views


def pfm(path):
    with path.open('rb') as stream:
        assert stream.readline().strip()==b'Pf'
        w,h=map(int,stream.readline().split()); scale=float(stream.readline())
        return np.flipud(np.frombuffer(stream.read(),dtype='<f4' if scale<0 else '>f4').reshape(h,w)).copy()


def main():
    if (OUT/'input-manifest.json').exists():
        raise RuntimeError('Refusing input regeneration')
    records=[]; truth=[]
    for spec in specs():
        directory=OUT/'inputs'/spec['id']; directory.mkdir(parents=True)
        cal,views=render(spec)
        for camera,(pixels,_) in zip(['left','right'],views):
            cv2.imwrite(str(directory/f'{camera}.png'),pixels)
        save(directory/'calibration.json',cal)
        np.save(directory/'reference-depth-evaluator-only.npy',views[0][1])
        records.append(dict(id=spec['id'],split=spec['split'],kind='synthetic',leftPath=rel(directory/'left.png'),rightPath=rel(directory/'right.png'),calibrationPath=rel(directory/'calibration.json')))
        truth.append(dict(sceneId=spec['id'],split=spec['split'],family=spec['family'],referenceAxialDepthM=spec['z'] if spec['family'] not in ['ambiguous','missing'] else None,render=spec))
    for name in ['Adirondack','Motorcycle','Pipes']:
        source=ROOT/'.runtime/experiments/jev-spatial-text-v1/stereo/sources'/f'{name}-perfect'
        lines=dict(line.split('=',1) for line in (source/'calib.txt').read_text().splitlines())
        mat=list(map(float,re.findall(r'[-+]?\d*\.?\d+',lines['cam0'])))
        w,h=int(lines['width']),int(lines['height']); ow=768; oh=round(h*ow/w); sx,sy=ow/w,oh/h
        cal=dict(fx=mat[0]*sx,fy=mat[4]*sy,cx=(mat[2]+.5)*sx-.5,cy=(mat[5]+.5)*sy-.5,baselineM=float(lines['baseline'])/1000,doffsPx=float(lines['doffs'])*sx,width=ow,height=oh,rectified=True,sourceScaleXY=[sx,sy])
        sid='real-'+name.lower(); directory=OUT/'inputs'/sid; directory.mkdir(parents=True)
        for camera,filename in [('left','im0.png'),('right','im1.png')]:
            image=cv2.imread(str(source/filename),cv2.IMREAD_COLOR)
            cv2.imwrite(str(directory/f'{camera}.png'),cv2.resize(image,(ow,oh),interpolation=cv2.INTER_AREA))
        d=cv2.resize(pfm(source/'disp0.pfm'),(ow,oh),interpolation=cv2.INTER_NEAREST)*sx
        valid=np.isfinite(d)&(d>0)&(d+cal['doffsPx']>0)
        depth=np.full(d.shape,np.nan,np.float32);depth[valid]=cal['fx']*cal['baselineM']/(d[valid]+cal['doffsPx'])
        np.save(directory/'reference-depth-evaluator-only.npy',depth)
        save(directory/'calibration.json',cal)
        records.append(dict(id=sid,split='regression',kind='real',leftPath=rel(directory/'left.png'),rightPath=rel(directory/'right.png'),calibrationPath=rel(directory/'calibration.json'),sourcePaths=[rel(source/x) for x in ['calib.txt','disp0.pfm','im0.png','im1.png']]))
    save(OUT/'input-manifest.json',records)
    save(OUT/'evaluation-truth.json',truth)
    print('Generated 24 fresh stereo render pairs and 3 reused real RGB pairs')


if __name__=='__main__':
    main()
