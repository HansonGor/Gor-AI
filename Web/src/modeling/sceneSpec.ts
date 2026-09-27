import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export type SceneGeometry = 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus' | 'plane';
export type Vector3Tuple = [number, number, number];

export interface SceneObjectSpec {
  id: string;
  name: string;
  geometry: SceneGeometry;
  size: Vector3Tuple;
  position: Vector3Tuple;
  rotation: Vector3Tuple;
  scale: Vector3Tuple;
  color: string;
  metalness: number;
  roughness: number;
  copy_offsets: Vector3Tuple[];
}

export interface SceneSpec {
  version: 1;
  name: string;
  objects: SceneObjectSpec[];
}

export function isSceneRendererProject(files: Record<string, string>): boolean {
  const indexHtml = files['/index.html'] ?? '';
  const rendererSource = files['/src/main.ts'] ?? '';
  const moduleScript = (indexHtml.match(/<script\b[^>]*>/gi) ?? []).find((script) =>
    /\btype\s*=\s*["']module["']/i.test(script),
  );
  const scriptPath = moduleScript?.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  const entryPath = scriptPath?.startsWith('./') ? `/${scriptPath.slice(2)}` : scriptPath;
  if (files['/src/scene.json'] === undefined || entryPath !== '/src/main.ts') return false;
  try {
    validateSceneSpec(JSON.parse(files['/src/scene.json']));
  } catch {
    return false;
  }
  // Support both current renderers that import scene.json and earlier snapshots
  // that embedded the validated SceneSpec directly in the generated renderer.
  return /import\s+spec\s+from\s+["']\.\/scene\.json["']/.test(rendererSource)
    || (/__GOR_PREVIEW_DISPOSE__/.test(rendererSource)
      && /new\s+THREE\.WebGLRenderer/.test(rendererSource)
      && /makeGeometry/.test(rendererSource));
}

const VECTOR_KEYS = ['size', 'position', 'rotation', 'scale'] as const;
const COLOR = /^#[0-9a-f]{6}$/i;

export function validateSceneSpec(value: unknown): SceneSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('场景数据格式无效。');
  const scene = value as Record<string, unknown>;
  if (scene.version !== 1 || typeof scene.name !== 'string' || !scene.name.trim() || scene.name.length > 80) {
    throw new Error('场景版本或名称无效。');
  }
  if (!Array.isArray(scene.objects) || scene.objects.length < 1 || scene.objects.length > 80) {
    throw new Error('场景对象数量必须为 1 到 80 个。');
  }
  const ids = new Set<string>();
  let expandedCount = 0;
  const objects = scene.objects.map((raw): SceneObjectSpec => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('场景对象格式无效。');
    const object = raw as Record<string, unknown>;
    if (typeof object.id !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(object.id) || ids.has(object.id)) throw new Error('场景对象 ID 无效或重复。');
    ids.add(object.id);
    if (typeof object.name !== 'string' || !object.name.trim() || object.name.length > 80) throw new Error(`对象 ${object.id} 名称无效。`);
    if (!['box', 'sphere', 'cylinder', 'cone', 'torus', 'plane'].includes(String(object.geometry))) throw new Error(`对象 ${object.id} 几何类型不支持。`);
    for (const key of VECTOR_KEYS) {
      const vector = object[key];
      if (!Array.isArray(vector) || vector.length !== 3 || vector.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry) || Math.abs(entry) > 100)) {
        throw new Error(`对象 ${object.id} 的 ${key} 数值无效。`);
      }
    }
    const size = object.size as number[];
    const scale = object.scale as number[];
    if (size.some((entry) => entry <= 0) || scale.some((entry) => entry <= 0)) throw new Error(`对象 ${object.id} 的尺寸与缩放必须为正数。`);
    if (object.geometry === 'sphere' && !(size[0] === size[1] && size[1] === size[2])) throw new Error('球体三个轴的尺寸必须相等。');
    if (typeof object.color !== 'string' || !COLOR.test(object.color)) throw new Error(`对象 ${object.id} 的颜色无效。`);
    for (const key of ['metalness', 'roughness'] as const) {
      const amount = object[key];
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || amount > 1) throw new Error(`对象 ${object.id} 的材质参数无效。`);
    }
    const copyOffsets = object.copy_offsets ?? [];
    if (!Array.isArray(copyOffsets) || copyOffsets.length > 12 || copyOffsets.some((offset) => !Array.isArray(offset) || offset.length !== 3 || offset.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry) || Math.abs(entry) > 100))) {
      throw new Error(`对象 ${object.id} 的复制偏移无效。`);
    }
    expandedCount += 1 + copyOffsets.length;
    return {
      id: object.id,
      name: object.name,
      geometry: object.geometry as SceneGeometry,
      size: [...size] as Vector3Tuple,
      position: [...object.position as number[]] as Vector3Tuple,
      rotation: [...object.rotation as number[]] as Vector3Tuple,
      scale: [...scale] as Vector3Tuple,
      color: object.color,
      metalness: object.metalness as number,
      roughness: object.roughness as number,
      copy_offsets: copyOffsets.map((offset) => [...offset] as Vector3Tuple),
    };
  });
  if (expandedCount > 100) throw new Error('场景展开后的对象数量最多为 100。');
  return { version: 1, name: scene.name, objects };
}

function createGeometry(item: SceneObjectSpec): THREE.BufferGeometry {
  const [x, y, z] = item.size;
  switch (item.geometry) {
    case 'box': return new THREE.BoxGeometry(x, y, z);
    case 'sphere': return new THREE.SphereGeometry(x / 2, 24, 16);
    case 'cylinder': return new THREE.CylinderGeometry(x / 2, z / 2, y, 20);
    case 'cone': return new THREE.ConeGeometry(x / 2, y, 20);
    case 'torus': return new THREE.TorusGeometry(x, y, 12, 32);
    case 'plane': return new THREE.PlaneGeometry(x, z);
  }
}

export function createSceneModelGroup(scene: SceneSpec): THREE.Group {
  const root = new THREE.Group();
  root.name = scene.name;
  for (const item of scene.objects) {
    const geometry = createGeometry(item);
    const material = new THREE.MeshStandardMaterial({
      color: item.color,
      metalness: item.metalness,
      roughness: item.roughness,
    });
    const offsets: Vector3Tuple[] = [[0, 0, 0], ...item.copy_offsets];
    offsets.forEach((offset, index) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = index === 0 ? item.name : `${item.name} ${index + 1}`;
      mesh.position.set(item.position[0] + offset[0], item.position[1] + offset[1], item.position[2] + offset[2]);
      mesh.rotation.set(...item.rotation);
      mesh.scale.set(...item.scale);
      root.add(mesh);
    });
  }
  return root;
}

export async function exportSceneGlb(scene: SceneSpec): Promise<Blob> {
  const model = createSceneModelGroup(scene);
  const exporter = new GLTFExporter();
  try {
    const data = await new Promise<ArrayBuffer>((resolve, reject) => {
      exporter.parse(model, (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error('GLB 导出器没有返回二进制结果。'));
      }, reject, { binary: true, onlyVisible: true });
    });
    return new Blob([data], { type: 'model/gltf-binary' });
  } finally {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry);
        (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => materials.add(material));
      }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  }
}

export function createSceneRendererSource(_scene?: SceneSpec): string {
  return `import * as THREE from 'three';\nimport spec from './scene.json';\n` + `
const root = document.getElementById('root');
if (!root) throw new Error('Preview root element is missing.');
window.__GOR_PREVIEW_DISPOSE__?.();
const scene = new THREE.Scene();
scene.background = new THREE.Color('#171923');
const model = new THREE.Group();
model.name = spec.name;
const makeGeometry = (item) => {
  const [x,y,z] = item.size;
  switch(item.geometry) {
    case 'box': return new THREE.BoxGeometry(x,y,z);
    case 'sphere': return new THREE.SphereGeometry(x/2,24,16);
    case 'cylinder': return new THREE.CylinderGeometry(x/2,z/2,y,20);
    case 'cone': return new THREE.ConeGeometry(x/2,y,20);
    case 'torus': return new THREE.TorusGeometry(x,y,12,32);
    case 'plane': return new THREE.PlaneGeometry(x,z);
    default: throw new Error('Unsupported SceneSpec geometry: ' + item.geometry);
  }
};
for (const item of spec.objects) {
  const geometry = makeGeometry(item);
  const material = new THREE.MeshStandardMaterial({ color:item.color, metalness:item.metalness, roughness:item.roughness });
  for (const [index, offset] of [[0, [0,0,0]], ...item.copy_offsets.map((copy, i) => [i+1, copy])]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = index === 0 ? item.name : item.name + ' ' + (index + 1);
    mesh.position.set(item.position[0]+offset[0], item.position[1]+offset[1], item.position[2]+offset[2]);
    mesh.rotation.set(...item.rotation); mesh.scale.set(...item.scale); model.add(mesh);
  }
}
scene.add(model);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(100,100), new THREE.MeshStandardMaterial({color:'#242735', roughness:0.92}));
ground.rotation.x = -Math.PI/2; ground.position.y = -0.02; scene.add(ground);
scene.add(new THREE.HemisphereLight(0xe8edff, 0x353342, 2.1));
const key = new THREE.DirectionalLight(0xffffff, 3.0); key.position.set(5,8,6); scene.add(key);
const fill = new THREE.DirectionalLight(0x9aafff, 1.2); fill.position.set(-6,3,-4); scene.add(fill);
const renderer = new THREE.WebGLRenderer({antialias:true, alpha:false});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.shadowMap.enabled = true;
renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab'; root.replaceChildren(renderer.domElement);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
const bounds = new THREE.Box3().setFromObject(model); const sphere = bounds.getBoundingSphere(new THREE.Sphere());
const target = sphere.isEmpty() ? new THREE.Vector3() : sphere.center;
let distance = Math.max(4, sphere.radius * 3.2), yaw = Math.PI/4, pitch = Math.PI/3;
const updateCamera = () => { pitch=Math.max(0.12,Math.min(Math.PI-0.12,pitch)); camera.position.set(target.x+distance*Math.sin(pitch)*Math.sin(yaw),target.y+distance*Math.cos(pitch),target.z+distance*Math.sin(pitch)*Math.cos(yaw)); camera.lookAt(target); };
const resize = () => { const rect=root.getBoundingClientRect(); const width=Math.max(1,rect.width),height=Math.max(1,rect.height); renderer.setSize(width,height,false); camera.aspect=width/height; camera.updateProjectionMatrix(); };
updateCamera(); resize(); const observer=new ResizeObserver(resize); observer.observe(root);
let dragging=false,lastX=0,lastY=0;
const down=(event)=>{dragging=true;lastX=event.clientX;lastY=event.clientY;renderer.domElement.setPointerCapture(event.pointerId);renderer.domElement.style.cursor='grabbing';};
const move=(event)=>{if(!dragging)return; yaw-=(event.clientX-lastX)*0.008;pitch-=(event.clientY-lastY)*0.008;lastX=event.clientX;lastY=event.clientY;updateCamera();};
const up=()=>{dragging=false;renderer.domElement.style.cursor='grab';};
const wheel=(event)=>{event.preventDefault();distance=Math.max(Math.max(1,sphere.radius*0.6),Math.min(300,distance*Math.exp(event.deltaY*0.001)));updateCamera();};
renderer.domElement.addEventListener('pointerdown',down);renderer.domElement.addEventListener('pointermove',move);renderer.domElement.addEventListener('pointerup',up);renderer.domElement.addEventListener('pointercancel',up);renderer.domElement.addEventListener('wheel',wheel,{passive:false});
renderer.setAnimationLoop(()=>renderer.render(scene,camera));
window.__GOR_PREVIEW_DISPOSE__=()=>{renderer.setAnimationLoop(null);observer.disconnect();renderer.domElement.removeEventListener('pointerdown',down);renderer.domElement.removeEventListener('pointermove',move);renderer.domElement.removeEventListener('pointerup',up);renderer.domElement.removeEventListener('pointercancel',up);renderer.domElement.removeEventListener('wheel',wheel);scene.traverse((item)=>{if(item.geometry)item.geometry.dispose();if(item.material){for(const material of Array.isArray(item.material)?item.material:[item.material])material.dispose();}});renderer.dispose();renderer.forceContextLoss();};
`;
}

export function createSceneProjectFiles(scene: SceneSpec): Record<string, string> {
  return {
    '/index.html': `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${scene.name.replace(/[<>&"']/g, '')}</title></head><body><div id="root"></div><script type="module" src="/src/main.ts"></script></body></html>`,
    '/src/main.ts': createSceneRendererSource(scene),
    '/src/scene.json': JSON.stringify(scene, null, 2),
  };
}
