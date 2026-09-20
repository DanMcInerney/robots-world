"""Image-only stereo visual odometry with explicit unknowns and map epochs."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parent.parent/"stereo"))
from matching import estimate as stereo_estimate

SETTINGS = dict(maxFeatures=900,qualityLevel=.01,minDistance=6,featureBlockSize=5,
                lkWindow=21,lkLevels=3,forwardBackwardMaxPx=1.0,minPnPPoints=24,
                ransacIterations=150,ransacReprojectionPx=2.0,ransacConfidence=.999,
                minInlierRatio=.45,minInliers=20,maxReprojectionMedianPx=1.2,
                maxTranslationPerEstimateM=.5,maxRotationPerEstimateDeg=20,
                replenishBelow=250,maxStoredLandmarks=5000,randomSeed=1907)


def rotation_degrees(rotation):
    return float(np.rad2deg(np.arccos(np.clip((np.trace(rotation)-1)/2,-1,1))))


class Odometry:
    def __init__(self, calibration):
        self.calibration = calibration
        self.K = np.array([[calibration["fx"],0,calibration["cx"]], [0,calibration["fy"],calibration["cy"]], [0,0,1]],dtype=float)
        self.epoch=-1
        self.reference=None
        self.landmarks={}
        self.next_id=0
        self.reset()

    def reset(self):
        self.epoch += 1
        self.reference=None
        self.landmarks={}
        self.points=np.empty((0,2),np.float32)
        self.ids=[]
        self.map_from_camera=np.eye(4)

    def join(self, epoch, landmark_id):
        if epoch != self.epoch:
            return dict(status="stale-epoch",position=None)
        point = self.landmarks.get(landmark_id)
        return dict(status="measured" if point is not None else "unknown-id",position=point.tolist() if point is not None else None)

    def unproject(self, points, result):
        coordinates = np.rint(points).astype(int)
        h,w=result["depth"].shape
        inside=(coordinates[:,0]>=0)&(coordinates[:,0]<w)&(coordinates[:,1]>=0)&(coordinates[:,1]<h)
        coordinates[:,0]=np.clip(coordinates[:,0],0,w-1)
        coordinates[:,1]=np.clip(coordinates[:,1],0,h-1)
        depth=result["depth"][coordinates[:,1],coordinates[:,0]]
        valid=inside & result["valid"][coordinates[:,1],coordinates[:,0]] & np.isfinite(depth)
        xyz=np.column_stack(((points[:,0]-self.calibration["cx"])*depth/self.calibration["fx"],
                             (points[:,1]-self.calibration["cy"])*depth/self.calibration["fy"],depth))
        return xyz,valid

    def add_features(self, image, result):
        if len(self.points)>=SETTINGS["replenishBelow"]:
            return
        mask=result["valid"].astype(np.uint8)*255
        for point in self.points:
            cv2.circle(mask,tuple(np.rint(point).astype(int)),SETTINGS["minDistance"],0,-1)
        points=cv2.goodFeaturesToTrack(image,maxCorners=SETTINGS["maxFeatures"]-len(self.points),
                                      qualityLevel=SETTINGS["qualityLevel"],minDistance=SETTINGS["minDistance"],
                                      mask=mask,blockSize=SETTINGS["featureBlockSize"])
        if points is None:
            return
        points=points.reshape(-1,2)
        xyz,valid=self.unproject(points,result)
        for point,location in zip(points[valid],xyz[valid]):
            if len(self.landmarks)>=SETTINGS["maxStoredLandmarks"]:
                break
            identifier=f"e{self.epoch}-p{self.next_id}"
            self.next_id+=1
            self.landmarks[identifier]=self.map_from_camera[:3,:3]@location+self.map_from_camera[:3,3]
            self.points=np.concatenate((self.points,point[None,:]),axis=0)
            self.ids.append(identifier)

    def process(self, image, right, frame_id):
        cv2.setRNGSeed(SETTINGS["randomSeed"])
        result=stereo_estimate(image,right,self.calibration)
        evidence={"frameId":frame_id,"epoch":self.epoch,"depthCoverage":float(result["valid"].mean()),
                  "pose":None,"status":"unknown","failureReason":None,"mapLandmarkCount":len(self.landmarks),
                  "trackedPoints":0,"pnpCandidates":0,"inliers":0,"inlierRatio":None,
                  "reprojectionMedianPx":None,"landmarkObservations":[],
                  "poseMeaning":"map-from-camera in current epoch; map axes equal first optical camera; arbitrary local origin, no ENU pose supplied"}
        if self.reference is None:
            self.add_features(image,result)
            if len(self.points)<SETTINGS["minPnPPoints"]:
                evidence["failureReason"]="insufficient-depth-supported-features-to-anchor"
                return evidence,result
            self.reference=(image,result,frame_id)
            evidence.update(status="epoch-anchor",pose=self.map_from_camera.tolist(),mapLandmarkCount=len(self.landmarks),trackedPoints=len(self.points))
            return evidence,result
        prior_image,prior_result,reference_id=self.reference
        evidence["referenceFrameId"]=reference_id
        initial=self.points.astype(np.float32).reshape(-1,1,2)
        current,status,_=cv2.calcOpticalFlowPyrLK(prior_image,image,initial,None,winSize=(SETTINGS["lkWindow"],)*2,maxLevel=SETTINGS["lkLevels"])
        back,back_status,_=cv2.calcOpticalFlowPyrLK(image,prior_image,current,None,winSize=(SETTINGS["lkWindow"],)*2,maxLevel=SETTINGS["lkLevels"])
        current=current.reshape(-1,2)
        old_xyz,depth_valid=self.unproject(self.points,prior_result)
        _,new_depth_valid=self.unproject(current,result)
        tracked=status.ravel().astype(bool)&back_status.ravel().astype(bool)&(np.linalg.norm(back.reshape(-1,2)-self.points,axis=1)<=SETTINGS["forwardBackwardMaxPx"])
        usable=tracked&depth_valid&new_depth_valid
        indexes=np.flatnonzero(usable)
        evidence["trackedPoints"],evidence["pnpCandidates"]=int(tracked.sum()),len(indexes)
        if len(indexes)<SETTINGS["minPnPPoints"]:
            evidence["failureReason"]="insufficient-stereo-supported-correspondences"
            return evidence,result
        ok,rvec,tvec,inliers=cv2.solvePnPRansac(old_xyz[indexes].astype(np.float64),current[indexes].astype(np.float64),self.K,None,
                                            iterationsCount=SETTINGS["ransacIterations"],reprojectionError=SETTINGS["ransacReprojectionPx"],
                                            confidence=SETTINGS["ransacConfidence"],flags=cv2.SOLVEPNP_EPNP)
        if not ok or inliers is None:
            evidence["failureReason"]="pnp-ransac-failed"
            return evidence,result
        selected=indexes[inliers.ravel()]
        rvec,tvec=cv2.solvePnPRefineLM(old_xyz[selected].astype(np.float64),current[selected].astype(np.float64),self.K,None,rvec,tvec)
        rotation=cv2.Rodrigues(rvec)[0]
        projected=cv2.projectPoints(old_xyz[selected],rvec,tvec,self.K,None)[0].reshape(-1,2)
        median_error=float(np.median(np.linalg.norm(projected-current[selected],axis=1)))
        count,ratio=len(selected),len(selected)/len(indexes)
        evidence.update(inliers=count,inlierRatio=ratio,reprojectionMedianPx=median_error,
                        relativeTranslationM=float(np.linalg.norm(tvec)),relativeRotationDeg=rotation_degrees(rotation))
        if (count<SETTINGS["minInliers"] or ratio<SETTINGS["minInlierRatio"] or median_error>SETTINGS["maxReprojectionMedianPx"]
            or np.linalg.norm(tvec)>SETTINGS["maxTranslationPerEstimateM"] or rotation_degrees(rotation)>SETTINGS["maxRotationPerEstimateDeg"]):
            evidence["failureReason"]="pose-quality-gate-rejected"
            return evidence,result
        current_from_previous=np.eye(4)
        current_from_previous[:3,:3],current_from_previous[:3,3]=rotation,tvec.ravel()
        self.map_from_camera=self.map_from_camera@np.linalg.inv(current_from_previous)
        # Reobserve existing sensor-anchored landmarks, without fusing or using GT.
        self.points=current[selected]
        self.ids=[self.ids[index] for index in selected]
        new_xyz,_=self.unproject(self.points,result)
        measured_map=new_xyz@self.map_from_camera[:3,:3].T+self.map_from_camera[:3,3]
        evidence["landmarkObservations"]=[dict(id=identifier,pixel=point.tolist(),mapMeasured=measured.tolist(),
                                               anchoredMap=self.landmarks[identifier].tolist(),
                                               selfConsistencyResidualM=float(np.linalg.norm(measured-self.landmarks[identifier])))
                                          for identifier,point,measured in zip(self.ids,self.points,measured_map)]
        self.add_features(image,result)
        self.reference=(image,result,frame_id)
        evidence.update(status="estimated",pose=self.map_from_camera.tolist(),mapLandmarkCount=len(self.landmarks))
        return evidence,result
