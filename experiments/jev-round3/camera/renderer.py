"""Experiment-only ENU stereo RGB renderer. Ground truth is written separately.

Coordinates are metres: +X east, +Y north, +Z up. Camera yaw zero looks
east, positive yaw turns north, positive pitch looks up. Position is the rig
midpoint. Cars use ground-footprint centre and +X forward at yaw zero.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import sys
import struct
import time

import numpy as np
from PIL import Image, ImageDraw
import trimesh
import pyrender
import DracoPy

ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / ".runtime/experiments/jev-round3-v1/camera"
ASSET = RUNTIME / "assets/ferrari.glb"
WIDTH, HEIGHT, HFOV, BASELINE = 640, 360, 70.0, 0.20
FOCAL = WIDTH / (2 * math.tan(math.radians(HFOV) / 2))
CALIBRATION = {"width": WIDTH, "height": HEIGHT, "fx": FOCAL, "fy": FOCAL,
               "cx": WIDTH/2, "cy": HEIGHT/2, "baseline_m": BASELINE,
               "horizontal_fov_deg": HFOV, "near_m": 0.05, "far_m": 160.0,
               "distortion": [0, 0, 0, 0, 0], "rectified": True,
               "pixel_coordinates": "u=column+0.5,v=row+0.5; top-left origin",
               "depth_definition": "positive camera-axis Z in metres"}


def camera_matrix(pose: dict, eye_offset: float = 0) -> np.ndarray:
    yaw, pitch, roll = (float(pose.get(k, 0)) for k in ("yaw_rad", "pitch_rad", "roll_rad"))
    forward = np.array([math.cos(pitch)*math.cos(yaw), math.cos(pitch)*math.sin(yaw), math.sin(pitch)])
    right0 = np.array([math.sin(yaw), -math.cos(yaw), 0.0])
    up0 = np.cross(right0, forward)
    right = math.cos(roll)*right0 + math.sin(roll)*up0
    up = -math.sin(roll)*right0 + math.cos(roll)*up0
    result = np.eye(4)
    result[:3, :3] = np.column_stack([right, up, -forward])
    result[:3, 3] = np.asarray(pose["position"], float) + eye_offset*right
    if not np.isfinite(result).all():
        raise ValueError("nonfinite camera pose")
    return result


def object_matrix(pose: dict) -> np.ndarray:
    yaw = float(pose.get("yaw_rad", 0))
    result = trimesh.transformations.rotation_matrix(yaw, [0, 0, 1])
    result[:3, 3] = np.asarray(pose["position"], float)
    if not np.isfinite(result).all():
        raise ValueError("nonfinite object pose")
    if pose.get("pitch_rad", 0) or pose.get("roll_rad", 0):
        raise ValueError("cars are planar; nonzero car pitch/roll unsupported")
    return result


def textured_plane(x0, x1, y0, y1, z, image, period=8):
    vertices = np.array([[x0,y0,z],[x1,y0,z],[x1,y1,z],[x0,y1,z]])
    uv = np.array([[x0,y0],[x1,y0],[x1,y1],[x0,y1]])/period
    material = trimesh.visual.material.PBRMaterial(baseColorTexture=image, roughnessFactor=1.0, metallicFactor=0)
    return trimesh.Trimesh(vertices=vertices, faces=[[0,1,2],[0,2,3]],
                           visual=trimesh.visual.TextureVisuals(uv=uv, material=material), process=False)


def texture(seed, kind):
    rng = np.random.default_rng(seed)
    n = 1024
    noise = rng.normal(0, 9, (n,n,1))
    base = [69,71,72] if kind == "road" else [74,94,48]
    pixels = np.clip(np.array(base)[None,None,:]+noise, 0,255).astype(np.uint8)
    image = Image.fromarray(pixels)
    draw = ImageDraw.Draw(image)
    if kind == "road":
        for _ in range(90):
            x,y = rng.integers(0,n,2)
            draw.line([(int(x),int(y)),(int(x+rng.integers(-70,70)),int(y+rng.integers(10,90)))], fill=(43,44,44), width=2)
    else:
        for _ in range(6000):
            x,y = rng.integers(0,n,2)
            draw.line((int(x),int(y),int(x+2),int(y+5)), fill=tuple(rng.integers([45,65,25],[115,135,60]).tolist()),width=1)
    return image


class StereoRenderer:
    def __init__(self, asset_path=ASSET):
        started = time.perf_counter()
        self.asset_path = Path(asset_path)
        self.asset_hash = hashlib.sha256(self.asset_path.read_bytes()).hexdigest()
        imported = trimesh.load(self.asset_path, force="scene", process=False)
        # trimesh currently reads fallback zero accessors without decoding Draco.
        # Decode the compressed geometry explicitly, retaining glTF scene/materials.
        binary = self.asset_path.read_bytes()
        json_size = struct.unpack_from("<I", binary, 12)[0]
        document = json.loads(binary[20:20+json_size])
        blob = binary[28+json_size:]
        geometry_names=list(imported.geometry)
        if len(geometry_names)!=len(document["meshes"]):
            raise ValueError("asset primitive count does not match imported geometry")
        # Verify the source mesh-index/scene-node mapping independently of names.
        # The pinned importer uses the same documented unique-name utility for nodes.
        node_names={}; node_counts={}
        for index,node in enumerate(document["nodes"]):
            node_names[trimesh.util.unique_name(node.get("name",str(index)),node_names,counts=node_counts)]=index
        self.asset_mapping=[]
        for node_name,node_index in node_names.items():
            source_node=document["nodes"][node_index]
            if "mesh" not in source_node: continue
            mesh_index=source_node["mesh"]
            actual_geometry=imported.graph[node_name][1]
            if actual_geometry!=geometry_names[mesh_index]:
                raise ValueError(f"source node/mesh mapping mismatch at {node_index}:{node_name}")
            self.asset_mapping.append({"source_node_index":node_index,"imported_node":node_name,
                                       "source_mesh_index":mesh_index,"imported_geometry":actual_geometry})
        if len(self.asset_mapping)!=len(document["meshes"]):
            raise ValueError("expected one scene node per source Ferrari mesh")
        for mesh_index,description in enumerate(document["meshes"]):
            if len(description["primitives"]) != 1:
                raise ValueError("asset loader supports one primitive per mesh")
            primitive=description["primitives"][0]
            extension=primitive.get("extensions",{}).get("KHR_draco_mesh_compression")
            if not extension: continue
            view=document["bufferViews"][extension["bufferView"]]
            start=view.get("byteOffset",0)
            decoded=DracoPy.decode(blob[start:start+view["byteLength"]])
            # glTF names are not unique; trimesh suffixes repeated wheel parts.
            # Pinned importer preserves mesh/primitive order for this one-primitive asset.
            geometry_name=geometry_names[mesh_index]
            if not (geometry_name==description["name"] or geometry_name.startswith(description["name"]+"_")):
                raise ValueError("unexpected glTF importer mesh order")
            old=imported.geometry[geometry_name]
            expected_vertices=document["accessors"][primitive["attributes"]["POSITION"]]["count"]
            expected_indices=document["accessors"][primitive["indices"]]["count"]
            # Draco may split vertices at attribute seams; topology index count
            # and declared position bounds must still match the source geometry.
            if len(decoded.points)<expected_vertices or decoded.faces.size!=expected_indices:
                raise ValueError("Draco topology counts inconsistent with source accessor metadata")
            if decoded.faces.min()<0 or decoded.faces.max()>=len(decoded.points):
                raise ValueError("decoded triangle index outside vertex array")
            accessor=document["accessors"][primitive["attributes"]["POSITION"]]
            decoded_bounds=np.array([decoded.points.min(axis=0),decoded.points.max(axis=0)])
            if not np.allclose(decoded_bounds,np.array([accessor["min"],accessor["max"]]),atol=.002,rtol=.001):
                raise ValueError("decoded position bounds disagree with source mesh accessor")
            if len(old.vertices)!=expected_vertices or old.faces.size!=expected_indices:
                raise ValueError("imported fallback geometry count differs from source accessor metadata")
            material=old.visual.material
            imported.geometry[geometry_name]=trimesh.Trimesh(vertices=decoded.points,faces=decoded.faces,
                vertex_normals=decoded.normals,
                visual=trimesh.visual.TextureVisuals(uv=decoded.tex_coord,material=material),process=False)
        source_to_enu = np.eye(4)
        source_to_enu[:3,:3] = [[0,0,-1],[-1,0,0],[0,1,0]]
        parts = []
        for name in imported.graph.nodes_geometry:
            transform, geometry = imported.graph[name]
            mesh = imported.geometry[geometry].copy()
            if mesh.area<=0 or not np.isfinite(mesh.vertices).all():
                raise ValueError(f"invalid or empty asset geometry: {name}")
            mesh.apply_transform(source_to_enu @ transform)
            parts.append((name, mesh))
        bounds = np.array([np.min([m.bounds[0] for _,m in parts],axis=0), np.max([m.bounds[1] for _,m in parts],axis=0)])
        scale = 4.5 / (bounds[1,0]-bounds[0,0])
        offset = np.array([(bounds[0,0]+bounds[1,0])/2,(bounds[0,1]+bounds[1,1])/2,bounds[0,2]])
        for _, mesh in parts:
            mesh.vertices = (mesh.vertices-offset)*scale
        self.parts = parts
        dimensions = (bounds[1]-bounds[0])*scale
        self.geometry = {"car_length_m":float(dimensions[0]),"car_width_m":float(dimensions[1]),"car_height_m":float(dimensions[2]),
                         "car_ground_origin":"centre of footprint; local +X forward, +Y left, +Z up",
                         "conservative_car_box":{"size":dimensions.tolist(),"local_center":[0,0,float(dimensions[2]/2)]}}
        self.asset_validation={"source_mesh_count":len(document["meshes"]),"decoded_mesh_count":len(parts),
            "all_parts_positive_area":True,"all_vertices_finite":True,"index_counts_and_accessor_bounds_verified":True,
            "vertex_count_note":"Draco may duplicate vertices at attribute seams; decoded count >= source accessor count, triangle index count identical",
            "source_mesh_index_to_graph_identity":self.asset_mapping}
        self.renderer = pyrender.OffscreenRenderer(WIDTH, HEIGHT)
        from OpenGL.GL import glGetString, GL_RENDERER, GL_VERSION, GL_VENDOR
        self.gl = {"renderer":glGetString(GL_RENDERER).decode(),"vendor":glGetString(GL_VENDOR).decode(),"version":glGetString(GL_VERSION).decode()}
        self.config_key = None
        self.scene = None
        self.startup_ms = (time.perf_counter()-started)*1000

    def close(self):
        self.renderer.delete()

    def _add_car(self, pose, color, prefix):
        nodes=[]
        for name, source in self.parts:
            mesh = source.copy()
            mat = mesh.visual.material
            if "body" in name.lower() or getattr(mat,"name","") == "Body_Color":
                mat.baseColorFactor = [*color, 1]
                mat.metallicFactor = 0.15
                mat.roughnessFactor = 0.35
            if "glass" in name.lower():
                mat.baseColorFactor = [0.075,0.11,0.14,1]
                mat.metallicFactor = 0.3
                mat.roughnessFactor = 0.25
            node=self.scene.add(pyrender.Mesh.from_trimesh(mesh, smooth=False),pose=object_matrix(pose),name=f"{prefix}:{name}")
            nodes.append(node)
        return nodes

    def _box(self, position, size, color, name):
        mesh = trimesh.creation.box(extents=size)
        material = pyrender.MetallicRoughnessMaterial(baseColorFactor=[*color,1],metallicFactor=0,roughnessFactor=1)
        pose=np.eye(4); pose[:3,3]=position
        return self.scene.add(pyrender.Mesh.from_trimesh(mesh,material=material),pose=pose,name=name)

    def _setup(self, config):
        lighting=config.get("lighting",{})
        self.scene = pyrender.Scene(bg_color=[0.62,0.76,0.9,1],ambient_light=lighting.get("ambient",[0.42,0.42,0.42]))
        seed=int(config.get("seed",42))
        for mesh in [textured_plane(-80,110,-70,70,0,texture(seed,"grass"),8),
                     textured_plane(-80,110,-5.5,5.5,0.008,texture(seed+1,"road"),8)]:
            self.scene.add(pyrender.Mesh.from_trimesh(mesh,smooth=False))
        for side in [-1,1]:
            self._box([15,side*5.3,0.015],[190,0.09,0.012],[0.88,0.87,0.72],"road-edge")
        for x in range(-65,101,6):
            self._box([x,0,0.018],[2.6,0.08,0.01],[0.84,0.79,0.37],"road-dash")
        # Textured physical roadside structures provide parallax beyond the car.
        rng=np.random.default_rng(seed+20)
        for side in [-1,1]:
            for x in range(-25,76,10):
                h=float(rng.uniform(3,7)); y=side*float(rng.uniform(14,19))
                self._box([x,y,h/2],[7,5,h],[0.48+0.1*float(rng.random()),0.49,0.45],"background-building")
                for wx in [-2,0,2]:
                    for wz in np.arange(1.1,h-0.3,1.5):
                        self._box([x+wx,y-side*2.51,float(wz)],[0.8,0.025,0.75],[0.11,0.18,0.22],"background-window")
        for i,b in enumerate(config.get("obstacles",config.get("boxes",[]))):
            if any(float(v)<=0 for v in b["size"]): raise ValueError("box dimensions must be positive")
            self._box(b["position"],b["size"],b.get("color",[0.62,0.6,0.55]),b.get("id",f"box-{i}"))
        for i,p in enumerate(config.get("poles",[])):
            mesh=trimesh.creation.cylinder(radius=p.get("radius",0.12),height=p.get("height",3),sections=32)
            pose=np.eye(4); pose[:3,3]=p["position"]
            self.scene.add(pyrender.Mesh.from_trimesh(mesh,material=pyrender.MetallicRoughnessMaterial(baseColorFactor=[0.5,0.5,0.48,1],roughnessFactor=1)),pose=pose,name=p.get("id",f"pole-{i}"))
        for i,car in enumerate(config.get("lookalikes",config.get("other_cars",[]))):
            self._add_car(car["pose"],car.get("color",car.get("body_color",[0.04,0.12,0.75])),car.get("id",f"other-{i}"))
        self.target_nodes=self._add_car({"position":[0,0,0]},config.get("target_body_color",[0.025,0.12,0.8]),"target")
        light_pose=camera_matrix({"position":[15,-10,20],"yaw_rad":2.0,"pitch_rad":-1.0})
        self.scene.add(pyrender.DirectionalLight(color=np.ones(3),intensity=lighting.get("directional_intensity",2.6)),pose=light_pose)
        self.camera_node=self.scene.add(pyrender.IntrinsicsCamera(FOCAL,FOCAL,WIDTH/2,HEIGHT/2,znear=0.05,zfar=160))
        self.config_key=json.dumps(config,sort_keys=True)

    def render(self, camera_pose, target_pose, scene_config=None, out_dir=None, evaluator=True):
        config=scene_config or {}
        started=time.perf_counter()
        setup=False
        if self.config_key != json.dumps(config,sort_keys=True):
            self._setup(config); setup=True
        target_transform=object_matrix(target_pose)
        for node in self.target_nodes: self.scene.set_pose(node,target_transform)
        images={}; depths={}; masks={}
        target_set=set(self.target_nodes)
        for eye,offset in [("left",-BASELINE/2),("right",BASELINE/2)]:
            self.scene.set_pose(self.camera_node,camera_matrix(camera_pose,offset))
            flags=pyrender.RenderFlags.SHADOWS_DIRECTIONAL if config.get("lighting",{}).get("shadows",False) else pyrender.RenderFlags.NONE
            rgb,depth=self.renderer.render(self.scene,flags=flags)
            images[eye]=rgb; depths[eye]=depth
            if evaluator:
                colors={node:([255,255,255] if node in target_set else [0,0,0]) for node in self.scene.mesh_nodes}
                seg,_=self.renderer.render(self.scene,flags=pyrender.RenderFlags.SEG,seg_node_map=colors)
                masks[eye]=(seg[:,:,0]>127).astype(np.uint8)*255
        render_ms=(time.perf_counter()-started)*1000
        metadata={"calibration":CALIBRATION,"render_ms":render_ms,"scene_setup_included":setup,
                  "startup_ms":self.startup_ms,"opengl":self.gl,"asset_sha256":self.asset_hash}
        result={"rgb":images,"metadata":metadata}
        if evaluator: result["evaluator"]={"depth":depths,"target_mask":masks,"camera_pose":camera_pose,"target_pose":target_pose,"scene_config":config,"geometry":self.geometry}
        if out_dir is not None:
            out=Path(out_dir); (out/"rgb").mkdir(parents=True,exist_ok=True)
            for eye,rgb in images.items(): Image.fromarray(rgb).save(out/"rgb"/f"{eye}.png")
            (out/"calibration.json").write_text(json.dumps(CALIBRATION,indent=2))
            (out/"render-metadata.json").write_text(json.dumps(metadata,indent=2))
            if evaluator:
                ev=out/"evaluator"; ev.mkdir(exist_ok=True)
                for eye in images:
                    np.save(ev/f"depth_{eye}.npy",depths[eye])
                    Image.fromarray(masks[eye]).save(ev/f"target_mask_{eye}.png")
                truth={"camera_pose":camera_pose,"target_pose":target_pose,"scene_config":config,"geometry":self.geometry,
                       "camera_to_world_opengl":{eye:camera_matrix(camera_pose,offset).tolist() for eye,offset in [("left",-BASELINE/2),("right",BASELINE/2)]}}
                (ev/"truth.json").write_text(json.dumps(truth,indent=2))
            metadata["output_dir"]=str(out.resolve())
            metadata["write_complete_ms"]=(time.perf_counter()-started)*1000
        return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request",type=Path,help="JSON with camera_pose,target_pose,scene_config,out_dir")
    parser.add_argument("--jsonl",action="store_true",help="persistent stdin JSON requests; one metadata response each")
    parser.add_argument("--smoke",action="store_true")
    parser.add_argument("--trajectory",type=Path,help="world trajectory JSON with top-level scene_config and frames")
    parser.add_argument("--out",type=Path,help="new route output directory for --trajectory")
    args=parser.parse_args()
    renderer=StereoRenderer()
    try:
        if args.smoke:
            for distance in [6,10,14]:
                result=renderer.render({"position":[0,-2,2.2],"yaw_rad":0.13,"pitch_rad":-0.07},
                                       {"position":[distance,0,0],"yaw_rad":0}, {"seed":903},(args.out or RUNTIME/"smoke")/f"range-{distance}")
                print(json.dumps(result["metadata"]),flush=True)
            print(json.dumps({"geometry":renderer.geometry}),flush=True)
        elif args.trajectory:
            if args.out is None: parser.error("--trajectory requires --out")
            trajectory=json.loads(args.trajectory.read_text(encoding="utf-8-sig"))
            spec=trajectory.get("spec",{})
            route_id=trajectory.get("routeId",trajectory.get("route_id",trajectory.get("id",spec.get("id",args.trajectory.stem))))
            if args.out.exists(): raise FileExistsError(f"refusing to replace route evidence: {args.out}")
            args.out.mkdir(parents=True)
            input_hash=hashlib.sha256(args.trajectory.read_bytes()).hexdigest()
            manifest=[]; evaluator_manifest=[]
            for index,frame in enumerate(trajectory["frames"]):
                frame_index=frame.get("frame_index",index+1)
                out=args.out/"frames"/f"{frame_index:04d}"
                result=renderer.render(frame["camera_pose"],frame["target_pose"],frame.get("scene_config",trajectory.get("scene_config",{})),out)
                sample_id=f"{route_id}-{frame_index:04d}"
                manifest.append({"id":sample_id,"routeId":route_id,"split":trajectory.get("split",spec.get("split")),"family":trajectory.get("family",spec.get("family")),
                    "frameIndex":frame_index,"atMs":frame.get("acquired_sim_ms"),"leftPath":str((out/"rgb/left.png").resolve()),
                    "rightPath":str((out/"rgb/right.png").resolve()),"calibrationPath":str((out/"calibration.json").resolve())})
                evaluator_manifest.append({"id":sample_id,"evaluatorPath":str((out/"evaluator/truth.json").resolve()),
                    "depthLeftPath":str((out/"evaluator/depth_left.npy").resolve()),"depthRightPath":str((out/"evaluator/depth_right.npy").resolve()),
                    "targetMaskLeftPath":str((out/"evaluator/target_mask_left.png").resolve()),"targetMaskRightPath":str((out/"evaluator/target_mask_right.png").resolve())})
                # Retain completed acquisitions even if an interrupted batch never finishes.
                with (args.out/"inputs.jsonl").open("a",encoding="utf-8") as f: f.write(json.dumps(manifest[-1])+"\n")
                with (args.out/"evaluator.jsonl").open("a",encoding="utf-8") as f: f.write(json.dumps(evaluator_manifest[-1])+"\n")
                print(json.dumps({"id":sample_id,"render_ms":result["metadata"]["render_ms"]}),flush=True)
            (args.out/"complete.json").write_text(json.dumps({"routeId":route_id,"frames":len(manifest),"trajectory_sha256":input_hash,
                "renderer_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"geometry":renderer.geometry,"opengl":renderer.gl},indent=2))
        elif args.jsonl:
            for line in sys.stdin:
                if not line.strip(): continue
                request=json.loads(line)
                result=renderer.render(**request)
                print(json.dumps(result["metadata"]),flush=True)
        elif args.request:
            request=json.loads(args.request.read_text(encoding="utf-8-sig"))
            result=renderer.render(**request)
            print(json.dumps(result["metadata"]))
        else: parser.error("select --request, --jsonl or --smoke")
    finally: renderer.close()


if __name__ == "__main__": main()
