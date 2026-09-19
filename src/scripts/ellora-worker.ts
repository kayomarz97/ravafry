import * as THREE from 'three';

type Disposable = THREE.BufferGeometry | THREE.Material;
type ViewState = { width: number; height: number; dpr: number; progress: number; active: boolean };
type SceneMessage = { type: 'init'; canvas: OffscreenCanvas; view: ViewState } | { type: 'view'; view: ViewState } | { type: 'dispose' };
const scope = self as unknown as { postMessage(message: unknown): void; close(): void };
let update: ((view: ViewState) => void) | undefined;
let cleanup: (() => void) | undefined;

self.onmessage = (event: MessageEvent<SceneMessage>) => {
  try {
    if (event.data.type === 'init') start(event.data.canvas, event.data.view);
    else if (event.data.type === 'view') update?.(event.data.view);
    else { cleanup?.(); scope.close(); }
  } catch {
    cleanup?.();
    scope.postMessage({ type: 'fallback' });
    scope.close();
  }
};

function start(canvas: OffscreenCanvas, initialView: ViewState) {
  const renderer = new THREE.WebGLRenderer({
    canvas, alpha: true, antialias: false, depth: true, stencil: false,
    powerPreference: 'low-power', failIfMajorPerformanceCaveat: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  camera.position.set(0, 0.25, 23);
  const architecture = new THREE.Group();
  scene.add(architecture);

  const resources = new Set<Disposable>();
  const trackGeometry = <T extends THREE.BufferGeometry>(geometry: T): T => {
    resources.add(geometry);
    return geometry;
  };
  const trackMaterial = <T extends THREE.Material>(material: T): T => {
    resources.add(material);
    return material;
  };

  const stone = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.93,
    metalness: 0.02,
    flatShading: true,
  }));
  const darkStone = trackMaterial(new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  }));
  const warmReveal = trackMaterial(new THREE.MeshBasicMaterial({
    color: 0xd49a32,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));

  const unitBox = trackGeometry(new THREE.BoxGeometry(1, 1, 1, 1, 1, 1));
  const shaftGeometry = trackGeometry(new THREE.CylinderGeometry(0.42, 0.5, 1, 8, 1, false));
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  const color = new THREE.Color();

  const portalPieces: Array<[number, number, number, number, number, number, number]> = [];
  const layerColors = [0x4b4640, 0x34312d, 0x262522];
  for (let layer = 0; layer < 3; layer += 1) {
    const inset = layer * 0.72;
    const z = 1.2 - layer * 1.15;
    const edge = 8.7 - inset;
    const opening = 5.2 - inset * 0.16;
    const height = 16.2 - inset * .3;
    const sideWidth = edge - opening;
    portalPieces.push(
      [-(opening + sideWidth / 2), 0, z, sideWidth, height, 1.15, layerColors[layer]],
      [opening + sideWidth / 2, 0, z, sideWidth, height, 1.15, layerColors[layer]],
      [0, height / 2 - 1.05, z, opening * 2, 2.1, 1.15, layerColors[layer]],
      [0, -height / 2 + 0.55, z, opening * 2, 1.1, 1.15, layerColors[layer]],
    );
  }

  const portal = new THREE.InstancedMesh(unitBox, stone, portalPieces.length);
  portalPieces.forEach(([x, y, z, sx, sy, sz, tint], index) => {
    matrix.compose(position.set(x, y, z), quaternion, scale.set(sx, sy, sz));
    portal.setMatrixAt(index, matrix);
    portal.setColorAt(index, color.setHex(tint));
  });
  portal.instanceMatrix.needsUpdate = true;
  if (portal.instanceColor) portal.instanceColor.needsUpdate = true;
  architecture.add(portal);

  const columnXs = [-6.2, -5.15, -4.7, 4.7, 5.15, 6.2];
  const shafts = new THREE.InstancedMesh(shaftGeometry, stone, columnXs.length);
  columnXs.forEach((x, index) => {
    matrix.compose(position.set(x, 0, 3), quaternion, scale.set(.7, 10.8, .8));
    shafts.setMatrixAt(index, matrix);
    shafts.setColorAt(index, color.setHex(index % 2 ? 0x403c36 : 0x504a42));
  });
  shafts.instanceMatrix.needsUpdate = true;
  if (shafts.instanceColor) shafts.instanceColor.needsUpdate = true;
  architecture.add(shafts);

  const bandPieces: Array<[number, number, number, number, number, number, number]> = [];
  columnXs.forEach((x, columnIndex) => {
    const tint = columnIndex % 2 ? 0x302e2a : 0x464139;
    bandPieces.push(
      [x, -5.55, 3, 1.35, .5, 1.35, tint],
      [x, -5.95, 3, 1.7, .3, 1.6, tint],
      [x, 5.35, 3, .92, .32, 1.1, tint],
      [x, 5.7, 3, 1.25, .32, 1.35, tint],
      [x, 3.1, 3, .78, .13, .9, tint],
      [x, -3.1, 3, .86, .13, .9, tint],
    );
  });
  const bands = new THREE.InstancedMesh(unitBox, darkStone, bandPieces.length);
  bandPieces.forEach(([x, y, z, sx, sy, sz, tint], index) => {
    matrix.compose(position.set(x, y, z), quaternion, scale.set(sx, sy, sz));
    bands.setMatrixAt(index, matrix);
    bands.setColorAt(index, color.setHex(tint));
  });
  bands.instanceMatrix.needsUpdate = true;
  if (bands.instanceColor) bands.instanceColor.needsUpdate = true;
  architecture.add(bands);

  const massPieces: Array<[number, number, number, number, number, number, number]> = [
    [0, 7.65, 2.65, 18.7, 1.35, 2.0, 0x292824],
    [0, 8.55, 2.0, 17.3, .55, 2.4, 0x3b3731],
    [0, 9.05, 1.2, 15.6, .45, 2.7, 0x262522],
    [-7.4, -6.35, 2.4, 4.5, .85, 2.3, 0x292824],
    [7.4, -6.35, 2.4, 4.5, .85, 2.3, 0x292824],
    [-8.6, 1.0, .3, 1.4, 12.5, 3.6, 0x1f1e1b],
    [8.6, 1.0, .3, 1.4, 12.5, 3.6, 0x1f1e1b],
  ];
  const masses = new THREE.InstancedMesh(unitBox, darkStone, massPieces.length);
  massPieces.forEach(([x, y, z, sx, sy, sz, tint], index) => {
    matrix.compose(position.set(x, y, z), quaternion, scale.set(sx, sy, sz));
    masses.setMatrixAt(index, matrix);
    masses.setColorAt(index, color.setHex(tint));
  });
  masses.instanceMatrix.needsUpdate = true;
  if (masses.instanceColor) masses.instanceColor.needsUpdate = true;
  architecture.add(masses);

  const revealGeometry = trackGeometry(new THREE.PlaneGeometry(9.1, 1.1));
  const reveal = new THREE.Mesh(revealGeometry, warmReveal);
  reveal.position.set(0, 6.7, -2.1);
  architecture.add(reveal);

  scene.add(new THREE.HemisphereLight(0xbab2a4, 0x171612, 1.15));
  const graze = new THREE.DirectionalLight(0xffd59a, 3.4);
  graze.position.set(-8, 10, 12);
  graze.target.position.set(5, -1, 0);
  scene.add(graze, graze.target);
  const rim = new THREE.DirectionalLight(0x8892a0, 1.5);
  rim.position.set(9, 2, 7);
  scene.add(rim);


  let view = initialView;
  let disposed = false;
  let frame = 0;
  let width = 0;
  let height = 0;
  let dpr = 0;
  let entranceStarted = 0;
  const requestRender = () => {
    if (!disposed && view.active && !frame) frame = requestAnimationFrame(render);
  };
  const render = () => {
    frame = 0;
    if (disposed || !view.active) return;
    if (width !== view.width || height !== view.height || dpr !== view.dpr) {
      ({ width, height, dpr } = view);
      renderer.setDrawingBufferSize(width, height, dpr);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      architecture.scale.x = THREE.MathUtils.clamp(camera.aspect * 1.22, .35, 2.7);
    }
    if (!entranceStarted) entranceStarted = performance.now();
    const entrance = 1 - THREE.MathUtils.clamp((performance.now() - entranceStarted) / 900, 0, 1);
    const eased = entrance * entrance * (3 - 2 * entrance);
    camera.position.set(view.progress * .46, .25 - view.progress * .28, 23 - view.progress * 1.15 + eased * 1.8);
    architecture.rotation.set(view.progress * -.012, -.035 + view.progress * .085 - eased * .065, 0);
    architecture.position.y = eased * .22;
    graze.position.x = -8 + view.progress * 9;
    try {
      renderer.render(scene, camera);
      scope.postMessage({ type: 'frame', frame: renderer.info.render.frame, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
      if (entrance > 0) requestRender();
    } catch {
      cleanup?.();
      scope.postMessage({ type: 'fallback' });
      scope.close();
    }
  };
  update = (next) => {
    view = next;
    if (!view.active && frame) { cancelAnimationFrame(frame); frame = 0; }
    requestRender();
  };
  cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (frame) cancelAnimationFrame(frame);
    resources.forEach((resource) => resource.dispose());
    renderer.dispose();
    scene.clear();
  };
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    cleanup?.();
    scope.postMessage({ type: 'fallback' });
    scope.close();
  });
  requestRender();
}
