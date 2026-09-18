import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
const point = (p: any) => new THREE.Vector3(p.x, p.z, -p.y);
export function flightScene(element: HTMLElement, run: any) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#111b25");
  scene.add(new THREE.HemisphereLight(0xe5f6ff, 0x253847, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(3, 14, 6);
  scene.add(light);
  function box(parent: THREE.Object3D, size: any, color: string, p: any) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.z, size.y),
      new THREE.MeshStandardMaterial({ color, roughness: 0.8 }),
    );
    mesh.position.copy(point(p));
    parent.add(mesh);
    return mesh;
  }
  let crossing: THREE.Mesh | undefined;
  for (const o of run.manifest.scenario.obstacles) {
    const m = box(
      scene,
      o.shape.size,
      o.shape.color ?? "#596878",
      o.pose.position,
    );
    const q = o.pose.rotation;
    m.quaternion.set(q.x, q.z, -q.y, q.w);
    if (o.id === "crossing") crossing = m;
  }
  scene.add(new THREE.GridHelper(36, 36, 0x486279, 0x253b4c));
  const drone = new THREE.Group();
  scene.add(drone);
  box(drone, { x: 0.65, y: 0.2, z: 0.12 }, "#63ead0", { x: 0, y: 0, z: 0 });
  box(drone, { x: 0.2, y: 0.65, z: 0.12 }, "#63ead0", { x: 0, y: 0, z: 0 });
  const rover = box(scene, { x: 0.55, y: 0.55, z: 0.18 }, "#4889ff", {
    x: 0,
    y: 0,
    z: 0,
  });
  const path = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(
      run.evaluation.trajectory.map((f: any) => point(f.drone)),
    ),
    new THREE.LineBasicMaterial({
      color: 0x63ead0,
      transparent: true,
      opacity: 0.35,
    }),
  );
  scene.add(path);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 150);
  camera.position.set(12, 17, 15);
  const onboard = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 100),
    renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  element.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();
  function render(ms: number) {
    const frames = run.evaluation.trajectory,
      f = frames.findLast((v: any) => v.simMs <= ms) ?? frames[0];
    if (!f) return;
    drone.position.copy(point(f.drone));
    drone.rotation.y = (f.heading * Math.PI) / 180;
    rover.position.copy(point(f.target));
    if (crossing && f.crossing) crossing.position.copy(point(f.crossing));
    const heading = (f.heading * Math.PI) / 180,
      pitch = (f.pitch * Math.PI) / 180;
    onboard.position.copy(drone.position);
    onboard.lookAt(
      onboard.position
        .clone()
        .add(
          new THREE.Vector3(
            Math.cos(heading) * Math.cos(pitch),
            Math.sin(pitch),
            -Math.sin(heading) * Math.cos(pitch),
          ),
        ),
    );
    const w = Math.max(element.clientWidth, 240),
      h = 260,
      lower = 100;
    renderer.setSize(w, h, false);
    renderer.setScissorTest(true);
    camera.aspect = w / (h - lower);
    camera.updateProjectionMatrix();
    renderer.setViewport(0, lower, w, h - lower);
    renderer.setScissor(0, lower, w, h - lower);
    renderer.render(scene, camera);
    onboard.fov = THREE.MathUtils.radToDeg(
      2 *
        Math.atan(
          Math.tan(THREE.MathUtils.degToRad(f.hfov) / 2) / onboard.aspect,
        ),
    );
    onboard.updateProjectionMatrix();
    renderer.setViewport(0, 0, w, lower);
    renderer.setScissor(0, 0, w, lower);
    renderer.clear();
    const cw = (lower * 16) / 9,
      left = (w - cw) / 2;
    renderer.setViewport(left, 0, cw, lower);
    renderer.setScissor(left, 0, cw, lower);
    drone.visible = false;
    path.visible = false;
    renderer.render(scene, onboard);
    drone.visible = true;
    path.visible = true;
  }
  return {
    render,
    dispose() {
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          o.geometry.dispose();
          for (const m of Array.isArray(o.material) ? o.material : [o.material])
            m.dispose();
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
