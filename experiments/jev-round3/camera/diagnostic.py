"""Bounded preparation diagnostic requested after detector smoke failure."""
import json
import math
import argparse
from pathlib import Path
import numpy as np
from renderer import StereoRenderer, RUNTIME

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--out",type=Path,default=RUNTIME/"lighting-diagnostic")
    args=parser.parse_args()
    renderer=StereoRenderer()
    out=args.out
    if out.exists(): raise FileExistsError(out)
    out.mkdir()
    try:
        mesh_audit=[]
        for name,mesh in renderer.parts:
            # Nonzero geometry and triangle area catch fallback-accessor regressions.
            mesh_audit.append({"name":name,"vertices":len(mesh.vertices),"faces":len(mesh.faces),
                "bounds":mesh.bounds.tolist(),"area":float(mesh.area),"degenerate_faces":int(np.count_nonzero(mesh.area_faces<1e-12)),
                "normals_finite":bool(np.isfinite(mesh.vertex_normals).all()),"median_normal_length":float(np.median(np.linalg.norm(mesh.vertex_normals,axis=1)))})
        config={"seed":903,"lighting":{"ambient":[.20,.20,.20],"directional_intensity":3.0,"shadows":True}}
        outputs=[]
        for name,bearing in [("rear",0),("three-quarter",math.pi/4),("side",math.pi/2)]:
            camera={"position":[-10*math.cos(bearing),-10*math.sin(bearing),2.2],"yaw_rad":bearing,"pitch_rad":-0.13}
            result=renderer.render(camera,{"position":[0,0,0],"yaw_rad":0},config,out/name)
            outputs.append({"name":name,"camera_pose":camera,"output":str((out/name).resolve()),"metadata":result["metadata"]})
        report={"reason":"YOLO11n-seg missed/incorrectly classified original rear-quarter smoke; three unscored views under declared optional shadowed lighting",
                "original_candidate_defaults_changed":False,"scene_config":config,"mesh_audit":mesh_audit,"views":outputs,
                "limits":"Lighting and view diagnostic only; camera route or detector selection requires parent decision before scoring."}
        (out/"report.json").write_text(json.dumps(report,indent=2))
        print(json.dumps({"mesh_count":len(mesh_audit),"faces":sum(m["faces"] for m in mesh_audit),"views":outputs},indent=2))
    finally: renderer.close()

if __name__=="__main__": main()
