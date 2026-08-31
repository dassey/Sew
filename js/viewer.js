import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

export class Viewer {
  constructor(container) {
    this.container = container;
    this.parts = new Map();
    this.disposables = [];

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111418);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 6000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(180, -220, 170);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 2500;

    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);

    this._setupLights();
    this._setupStage();

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this.resize();

    this._animate = this._animate.bind(this);
    this._running = true;
    requestAnimationFrame(this._animate);
  }

  _setupLights() {
    this.scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x24262b, 1.35));

    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-120, -180, 260);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.35;
    this.keyLight = key;
    this.scene.add(key);
    this.scene.add(key.target);

    const fill = new THREE.DirectionalLight(0xc9d8ea, 0.55);
    fill.position.set(200, 140, 120);
    this.scene.add(fill);
  }

  _setupStage() {
    const grid = new THREE.GridHelper(600, 30, 0x2c3138, 0x22262c);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.02;
    this.grid = grid;
    this.scene.add(grid);

    const shadowMat = new THREE.ShadowMaterial({ opacity: 0.34 });
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), shadowMat);
    catcher.receiveShadow = true;
    catcher.position.z = -0.01;
    this.scene.add(catcher);
    this.disposables.push(catcher.geometry, shadowMat);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    const aspect = w / h;
    const changed = !this._lastAspect || Math.abs(aspect - this._lastAspect) / this._lastAspect > 0.1;

    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this._lastAspect = aspect;

    if (changed && this.parts.size) this.frameModel();
  }

  _animate() {
    if (!this._running) return;
    requestAnimationFrame(this._animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    for (const [, mesh] of this.parts) {
      this.modelGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.parts.clear();
  }

  setModel(parts, opts = {}) {
    this.clear();

    for (const part of parts) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
      geometry.computeVertexNormals();

      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(part.color),
        roughness: 0.82,
        metalness: 0.0,
        flatShading: false,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = part.id;
      this.modelGroup.add(mesh);
      this.parts.set(part.id, mesh);
    }

    this._fitLights();
    if (opts.frameCamera !== false) this.frameModel();
  }

  setPartColor(id, color) {
    const mesh = this.parts.get(id);
    if (mesh) mesh.material.color.set(color);
  }

  setPartVisible(id, visible) {
    const mesh = this.parts.get(id);
    if (mesh) mesh.visible = visible;
  }

  setGridVisible(visible) {
    this.grid.visible = visible;
  }

  setAutoRotate(on, speed = 0.7) {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = speed;
  }

  _boundingBox() {
    const box = new THREE.Box3();
    let any = false;
    for (const [, mesh] of this.parts) {
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox);
      any = true;
    }
    return any ? box : null;
  }

  _fitLights() {
    const box = this._boundingBox();
    if (!box) return;
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const reach = Math.max(size.x, size.y) * 0.85 + 20;

    const cam = this.keyLight.shadow.camera;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = 1;
    cam.far = reach * 6;
    cam.updateProjectionMatrix();

    const dist = Math.max(size.x, size.y, size.z) * 1.8 + 60;
    this.keyLight.position.set(centre.x - dist * 0.5, centre.y - dist * 0.75, dist);
    this.keyLight.target.position.copy(centre);
    this.keyLight.target.updateMatrixWorld();

    this.grid.position.set(centre.x, centre.y, -0.02);
  }

  frameModel(padding) {
    const box = this._boundingBox();
    if (!box) return;
    if (padding === undefined) padding = this.camera.aspect < 0.9 ? 1.06 : 1.25;
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 10);

    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * padding;

    const direction = this.camera.position
      .clone()
      .sub(this.controls.target)
      .normalize();
    if (!isFinite(direction.length()) || direction.length() < 0.01) {
      direction.set(0.55, -0.7, 0.6).normalize();
    }

    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(direction, distance);
    this.camera.near = Math.max(0.5, distance / 400);
    this.camera.far = distance * 8;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setView(name) {
    const box = this._boundingBox();
    const centre = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const dirs = {
      iso: [0.55, -0.72, 0.62],
      top: [0, -0.001, 1],
      front: [0, -1, 0.16],
      side: [1, 0, 0.16],
    };
    const d = dirs[name] || dirs.iso;
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.controls.target.copy(centre);
    this.camera.position
      .copy(centre)
      .add(new THREE.Vector3(d[0], d[1], d[2]).normalize().multiplyScalar(distance));
    this.controls.update();
    this.frameModel();
  }

  async snapshot(scale = 2) {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer.setSize(w * scale, h * scale, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);

    const blob = await new Promise((resolve) =>
      this.renderer.domElement.toBlob(resolve, 'image/png')
    );

    this.renderer.setSize(w, h, false);
    this.resize();
    return blob;
  }

  dispose() {
    this._running = false;
    this._resizeObserver.disconnect();
    this.clear();
    for (const d of this.disposables) d.dispose?.();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
