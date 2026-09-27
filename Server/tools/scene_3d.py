"""
3D 场景生成工具
职责：接收 AI 给出的简短场景描述，后端用 Three.js 模板生成可交互的 .html 文件，
浏览器直接打开即可拖拽旋转查看。
"""
import json
import os
from datetime import datetime
from langchain_core.tools import tool

from storage import GENERATED_ROOT, ensure_storage_dirs

ensure_storage_dirs()
GENERATED_DIR = str(GENERATED_ROOT)


def _build_download_url(filename: str) -> str:
    return f"/api/download/{filename}"


def _gen_filename() -> str:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"scene3d_{timestamp}.html"


_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>__TITLE__</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#0f0f19;}
  #c{display:block;width:100%;height:100%;}
  .tip{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);
       color:rgba(255,255,255,.45);font:12px/1.6 -apple-system,sans-serif;
       letter-spacing:.5px;pointer-events:none;}
</style>
</head>
<body>
<canvas id="c"></canvas>
<div class="tip">拖拽旋转 · 滚轮缩放</div>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
<script>
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(60,innerWidth/innerHeight,0.1,1000);
camera.position.set(0,1.6,__DIST__);
const renderer=new THREE.WebGLRenderer({canvas:document.getElementById('c'),antialias:true});
renderer.setSize(innerWidth,innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
scene.add(new THREE.AmbientLight(0xffffff,0.55));
const key=new THREE.DirectionalLight(0xffffff,1.1);key.position.set(5,8,5);scene.add(key);
const fill=new THREE.DirectionalLight(0x88aaff,0.4);fill.position.set(-5,2,-3);scene.add(fill);

__MESH__

const ctrl=new THREE.OrbitControls(camera,renderer.domElement);
ctrl.enableDamping=true;ctrl.dampingFactor=0.06;
ctrl.minDistance=2;ctrl.maxDistance=30;
(function loop(){__ANIM__;renderer.render(scene,camera);requestAnimationFrame(loop);})();
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
</script>
</body>
</html>"""


def _build_scene(prompt: str):
    """根据描述关键词返回 (mesh_js, anim_js, distance)"""
    p = prompt.lower()

    if any(k in p for k in ["地球", "earth", "globe"]):
        mesh = """
const globe=new THREE.Mesh(new THREE.SphereGeometry(1.3,64,64),new THREE.MeshPhongMaterial({color:0x2f6bd4,shininess:180,specular:0x88bbff,emissive:0x0a1830}));
scene.add(globe);
const lat=new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(1.32,12,8)),new THREE.LineBasicMaterial({color:0x7fb0ff,transparent:true,opacity:0.25}));
scene.add(lat);
const glow=new THREE.Mesh(new THREE.SphereGeometry(1.45,32,32),new THREE.MeshBasicMaterial({color:0x3a7bff,transparent:true,opacity:0.08,side:THREE.BackSide}));
scene.add(glow);
window.__objs=[globe,lat,glow];"""
        anim = "__objs[0].rotation.y+=0.004;__objs[1].rotation.y+=0.004;"
        return mesh, anim, 5.0

    if any(k in p for k in ["粒子", "星云", "particle", "nebula", "star", "星空"]):
        mesh = """
const N=2600,pos=new Float32Array(N*3);
for(let i=0;i<N;i++){const r=6*Math.cbrt(Math.random());const t=Math.random()*Math.PI*2;const ph=Math.acos(2*Math.random()-1);
pos[i*3]=r*Math.sin(ph)*Math.cos(t);pos[i*3+1]=r*Math.cos(ph);pos[i*3+2]=r*Math.sin(ph)*Math.sin(t);}
const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));
const pts=new THREE.Points(g,new THREE.PointsMaterial({color:0x9fb8ff,size:0.05,transparent:true,opacity:0.85}));
scene.add(pts);window.__objs=[pts];"""
        anim = "__objs[0].rotation.y+=0.0015;"
        return mesh, anim, 8.0

    if any(k in p for k in ["环", "torus", "knot", "结", "dna", "分子"]):
        mesh = """
const knot=new THREE.Mesh(new THREE.TorusKnotGeometry(1.1,0.34,180,24),new THREE.MeshStandardMaterial({color:0x8b5cf6,metalness:0.6,roughness:0.25}));
scene.add(knot);window.__objs=[knot];"""
        anim = "__objs[0].rotation.x+=0.005;__objs[0].rotation.y+=0.008;"
        return mesh, anim, 4.0

    # 默认：立方体
    mesh = """
const geo=new THREE.BoxGeometry(1.4,1.4,1.4);
const cube=new THREE.Mesh(geo,new THREE.MeshNormalMaterial());
scene.add(cube);
const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geo),new THREE.LineBasicMaterial({color:0xffffff}));
scene.add(edges);window.__objs=[cube,edges];"""
    anim = "__objs[0].rotation.x+=0.01;__objs[0].rotation.y+=0.012;__objs[1].rotation.copy(__objs[0].rotation);"
    return mesh, anim, 4.0


@tool
def create_3d_scene(title: str, prompt: str) -> str:
    """
    生成一个可交互的 3D 场景网页（.html），用户可在浏览器里拖拽旋转查看。
    当用户要求做3D建模、3D展示、3D可视化、旋转模型、3D动画时调用此工具。

    Args:
        title: 场景名称，简短中文，例如 "旋转地球"。
        prompt: 一句话场景描述，说明要展示什么主体，例如 "一个旋转的蓝色地球"。
                后端会根据描述自动选择合适的3D模型和动画。

    Returns:
        JSON 字符串，包含 success、fileType、displayName、downloadUrl
    """
    try:
        mesh, anim, dist = _build_scene(prompt)
        html = (_HTML_TEMPLATE
                .replace("__TITLE__", title)
                .replace("__MESH__", mesh)
                .replace("__ANIM__", anim)
                .replace("__DIST__", str(dist)))

        filename = _gen_filename()
        filepath = os.path.join(GENERATED_DIR, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(html)

        return json.dumps({
            "success": True,
            "fileType": "3d",
            "displayName": f"{title}.html",
            "downloadUrl": _build_download_url(filename),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)
