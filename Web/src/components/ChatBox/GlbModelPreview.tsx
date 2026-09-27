import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GeneratedFile } from '../../types';

const MAX_MODEL_BYTES = 32 * 1024 * 1024;

export default function GlbModelPreview({ file }: { file: GeneratedFile }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('正在加载 GLB…');
  const [error, setError] = useState('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = new AbortController();
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let loadedScene: THREE.Group | THREE.Scene | null = null;
    let observer: ResizeObserver | null = null;
    let frameId = 0;
    let pointerState: { id: number; x: number; y: number } | null = null;
    let yaw = Math.PI / 4;
    let pitch = Math.PI / 3;
    let distance = 5;
    let target = new THREE.Vector3();
    let camera: THREE.PerspectiveCamera | null = null;

    const fail = (reason: unknown) => {
      if (disposed) return;
      setError(reason instanceof Error ? reason.message : '无法解析此 GLB 文件。');
      setStatus('');
    };

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      cancelAnimationFrame(frameId);
      observer?.disconnect();
      if (renderer) {
        const canvas = renderer.domElement;
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.removeEventListener('wheel', onWheel);
      }
      loadedScene?.traverse((item) => {
        if (item instanceof THREE.Mesh) {
          item.geometry.dispose();
          (Array.isArray(item.material) ? item.material : [item.material]).forEach((material) => {
            Object.values(material).forEach((value) => {
              if (value instanceof THREE.Texture) value.dispose();
            });
            material.dispose();
          });
        }
      });
      renderer?.setAnimationLoop(null);
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer?.domElement.remove();
    };

    const updateCamera = () => {
      if (!camera) return;
      pitch = Math.max(0.12, Math.min(Math.PI - 0.12, pitch));
      camera.position.set(
        target.x + distance * Math.sin(pitch) * Math.sin(yaw),
        target.y + distance * Math.cos(pitch),
        target.z + distance * Math.sin(pitch) * Math.cos(yaw),
      );
      camera.lookAt(target);
    };
    const resize = () => {
      if (!renderer || !camera) return;
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const onDown = (event: PointerEvent) => {
      pointerState = { id: event.pointerId, x: event.clientX, y: event.clientY };
      renderer?.domElement.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!pointerState || pointerState.id !== event.pointerId) return;
      yaw -= (event.clientX - pointerState.x) * 0.008;
      pitch -= (event.clientY - pointerState.y) * 0.008;
      pointerState.x = event.clientX;
      pointerState.y = event.clientY;
      updateCamera();
    };
    const onUp = () => { pointerState = null; };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      distance = Math.max(0.25, Math.min(300, distance * Math.exp(event.deltaY * 0.001)));
      updateCamera();
    };

    void fetch(file.downloadUrl, { signal: controller.signal, credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`模型下载失败（${response.status}）。`);
        const length = Number(response.headers.get('content-length') || 0);
        if (length > MAX_MODEL_BYTES) throw new Error('模型超过 32 MB 预览上限。');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_MODEL_BYTES) throw new Error('模型超过 32 MB 预览上限。');
        if (bytes.byteLength < 12 || new TextDecoder().decode(new Uint8Array(bytes, 0, 4)) !== 'glTF') throw new Error('文件不是有效的 GLB。');
        if (new DataView(bytes).getUint32(4, true) !== 2 || new DataView(bytes).getUint32(8, true) !== bytes.byteLength) throw new Error('GLB 版本或文件长度校验失败。');
        const loader = new GLTFLoader();
        loader.parse(bytes, '', (gltf) => {
          if (disposed) {
            gltf.scene.traverse((item) => {
              if (item instanceof THREE.Mesh) { item.geometry.dispose(); (Array.isArray(item.material) ? item.material : [item.material]).forEach((material) => material.dispose()); }
            });
            return;
          }
          try {
            let meshCount = 0;
            gltf.scene.traverse((item) => { if (item instanceof THREE.Mesh) meshCount += 1; });
            if (meshCount > 500) throw new Error('模型网格数量超过预览上限。');
            loadedScene = gltf.scene;
            const scene = new THREE.Scene();
            scene.background = new THREE.Color('#171923');
            scene.add(gltf.scene);
            scene.add(new THREE.HemisphereLight(0xe8edff, 0x353342, 2.1));
            const light = new THREE.DirectionalLight(0xffffff, 3);
            light.position.set(5, 8, 6);
            scene.add(light);
            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.outputColorSpace = THREE.SRGBColorSpace;
            renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab';
            host.replaceChildren(renderer.domElement);
            camera = new THREE.PerspectiveCamera(42, 1, 0.01, 10000);
            const bounds = new THREE.Box3().setFromObject(gltf.scene);
            if (bounds.isEmpty()) throw new Error('GLB 中没有可显示的模型对象。');
            const sphere = bounds.getBoundingSphere(new THREE.Sphere());
            if (!Number.isFinite(sphere.radius) || sphere.radius <= 0 || sphere.radius > 10000) throw new Error('模型尺寸超出预览范围。');
            target = sphere.center;
            distance = Math.max(0.5, sphere.radius * 3.2);
            updateCamera();
            resize();
            observer = new ResizeObserver(resize);
            observer.observe(host);
            const canvas = renderer.domElement;
            canvas.addEventListener('pointerdown', onDown);
            canvas.addEventListener('pointermove', onMove);
            canvas.addEventListener('pointerup', onUp);
            canvas.addEventListener('pointercancel', onUp);
            canvas.addEventListener('wheel', onWheel, { passive: false });
            const activeRenderer = renderer;
            activeRenderer.setAnimationLoop(() => activeRenderer.render(scene, camera!));
            setStatus('拖动旋转 · 滚轮缩放');
          } catch (reason) {
            fail(reason);
          }
        }, fail);
      })
      .catch((reason) => { if (reason.name !== 'AbortError') fail(reason); });

    return cleanup;
  }, [file.downloadUrl]);

  return (
    <div className="glb-model-preview">
      {(status || error) && (
        <div role={error ? 'alert' : 'status'} style={{ position: 'absolute', zIndex: 1, top: 12, left: 12, padding: '8px 12px', borderRadius: 10, background: 'rgba(15,16,24,.78)', color: error ? '#fca5a5' : '#e5e7eb', fontSize: 13 }}>
          {error || status}
        </div>
      )}
      <div ref={hostRef} className="glb-model-preview-canvas" />
    </div>
  );
}
