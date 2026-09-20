"""Unscored engineering checks: projection, depth, stereo alignment and views."""
import json
import math
import time
import argparse
from pathlib import Path
import numpy as np
from PIL import Image
import pyrender
import trimesh
from renderer import StereoRenderer, camera_matrix, FOCAL, WIDTH, HEIGHT, BASELINE, RUNTIME


def run():
    parser=argparse.ArgumentParser()
    parser.add_argument("--output-root",type=Path,default=RUNTIME)
    args=parser.parse_args()
    args.output_root.mkdir(parents=True,exist_ok=True)
    renderer=StereoRenderer()
    checks=[]
    try:
        for yaw,pitch,roll in [(0,0,0),(1.1,-0.12,0),(2.2,0.2,0.1)]:
            camera={"position":[3,-4,2],"yaw_rad":yaw,"pitch_rad":pitch,"roll_rad":roll}
            centre=camera_matrix(camera)
            scene=pyrender.Scene(bg_color=[0,0,0,1],ambient_light=[1,1,1])
            # An opaque plane, exactly 10m perpendicular to the rig's optical axis.
            plane=trimesh.Trimesh(vertices=[[-2,-1,-10],[2,-1,-10],[2,1,-10],[-2,1,-10]],faces=[[0,1,2],[0,2,3]],process=False)
            plane.apply_transform(centre)
            material=pyrender.MetallicRoughnessMaterial(baseColorFactor=[1,1,1,1],emissiveFactor=[1,1,1],doubleSided=True)
            node=scene.add(pyrender.Mesh.from_trimesh(plane,material=material))
            camera_node=scene.add(pyrender.IntrinsicsCamera(FOCAL,FOCAL,WIDTH/2,HEIGHT/2,znear=.05,zfar=160))
            centres={}; depth_errors=[]
            for eye,offset in [("left",-BASELINE/2),("right",BASELINE/2)]:
                scene.set_pose(camera_node,camera_matrix(camera,offset))
                rgb,depth=renderer.renderer.render(scene,flags=pyrender.RenderFlags.SEG,seg_node_map={node:[255,255,255]})
                mask=rgb[:,:,0]>127
                rows,columns=np.where(mask)
                centres[eye]=[float(np.mean(columns+.5)),float(np.mean(rows+.5))]
                depth_errors.append(float(np.max(np.abs(depth[mask]-10))))
            disparity=centres["left"][0]-centres["right"][0]
            vertical=abs(centres["left"][1]-centres["right"][1])
            assert abs(disparity-FOCAL*BASELINE/10)<1, (disparity,FOCAL*BASELINE/10)
            assert vertical<.01,vertical
            assert max(depth_errors)<.005,depth_errors
            assert abs(np.linalg.det(centre[:3,:3])-1)<1e-10
            checks.append({"camera":camera,"measured_disparity_px":disparity,"expected_disparity_px":FOCAL*BASELINE/10,
                           "vertical_disparity_px":vertical,"max_axial_depth_error_m":max(depth_errors)})
        # ENU signs: at yaw zero, south projects right and up projects above.
        matrix=camera_matrix({"position":[0,0,0]})
        optical=np.linalg.inv(matrix)@np.array([10,-1,1,1])
        assert optical[0]>0 and optical[1]>0 and optical[2]<0
        samples=[]
        cases=[("offset-high",{"position":[0,2.5,3.2],"yaw_rad":-.17,"pitch_rad":-.15},{"seed":904}),
               ("occluded",{"position":[0,-2,2.2],"yaw_rad":.13,"pitch_rad":-.07},{"seed":904,"obstacles":[{"id":"wall","position":[7.2,.8,.9],"size":[.35,2.2,1.8],"color":[.65,.60,.51]}]}),
               ("pole",{"position":[0,-2,2.2],"yaw_rad":.13,"pitch_rad":-.07},{"seed":904,"poles":[{"position":[6.5,-.5,1.5],"radius":.12,"height":3}]}),
               ("lookalike",{"position":[0,-2,2.2],"yaw_rad":.13,"pitch_rad":-.07},{"seed":904,"lookalikes":[{"id":"distractor","pose":{"position":[14,-3,0],"yaw_rad":.1},"color":[.03,.16,.7]}]})]
        for name,camera,config in cases:
            result=renderer.render(camera,{"position":[10,0,0]},config,args.output_root/"qualification-views"/name)
            samples.append({"name":name,"target_visible_pixels":int(np.count_nonzero(result["evaluator"]["target_mask"]["left"])),"render_ms":result["metadata"]["render_ms"]})
        warm=[]
        for i in range(8):
            result=renderer.render(cases[-1][1],{"position":[10+i*.01,0,0]},cases[-1][2])
            warm.append(result["metadata"]["render_ms"])
        report={"status":"passed","checks":checks,"views":samples,"warm_stereo_plus_evaluator_ms":warm,
                "warm_median_ms":float(np.median(warm)),"warm_p95_ms":float(np.percentile(warm,95)),
                "geometry":renderer.geometry,"asset_validation":renderer.asset_validation,"opengl":renderer.gl,"startup_ms":renderer.startup_ms,
                "limits":"Unscored projection/render qualification, not detector/range accuracy or realtime acquisition qualification."}
        (args.output_root/"qualification.json").write_text(json.dumps(report,indent=2))
        print(json.dumps(report,indent=2))
    finally: renderer.close()


if __name__ == "__main__": run()
