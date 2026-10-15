// Progressive path tracer built on three-gpu-pathtracer's WebGLPathTracer. We drive the inner
// accumulation renderer directly so the result can be denoised and colour-managed ourselves.
import { Matrix4, type Camera, type WebGLRenderer, type Texture, type WebGLRenderTarget } from 'three';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import type { RenderScene } from './renderscene';
import type { RenderSettings } from '../../data/types';
import { bounceSettings } from './units';

interface Inner {
  _pathTracer: {
    setSize(w: number, h: number): void;
    getSize(v: { x: number; y: number }): void;
    update(): void;
    reset(): void;
    samples: number;
    alpha: boolean;
    tiles: { set(x: number, y: number): void };
    target: { texture: Texture };
    isCompiling: boolean;
    material: { backgroundAlpha: number; filterGlossyFactor: number };
  };
}

export class PathTracerCore {
  readonly pt: WebGLPathTracer;
  private inner: Inner['_pathTracer'];
  private renderer: WebGLRenderer;
  private sceneVersion = -1;
  private lightsVersion = -1;
  private envKey = '';
  private revision = -1;
  private camMatrix = new Matrix4();
  private camProj = new Matrix4();
  private camKey = '';
  width = 0;
  height = 0;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    this.pt = new WebGLPathTracer(renderer);
    this.pt.renderToCanvas = false;
    this.pt.synchronizeRenderSize = false;
    this.pt.multipleImportanceSampling = true;
    this.pt.filterGlossyFactor = 0.25;
    this.inner = (this.pt as unknown as Inner)._pathTracer;
    this.inner.tiles.set(1, 1);
  }

  get samples() {
    return Math.floor(this.inner.samples);
  }

  get isCompiling() {
    return this.inner.isCompiling;
  }

  get texture(): Texture {
    return this.inner.target.texture;
  }

  /** Render target holding the accumulated (scene-linear, premultiplied) image. */
  get renderTarget(): WebGLRenderTarget {
    return this.inner.target as unknown as WebGLRenderTarget;
  }

  setTiles(x: number, y: number) {
    this.inner.tiles.set(x, y);
  }

  applySettings(r: RenderSettings) {
    const b = bounceSettings(r);
    if (this.pt.bounces !== b.bounces || this.pt.transmissiveBounces !== b.transmissive) {
      this.pt.bounces = b.bounces;
      this.pt.transmissiveBounces = b.transmissive;
      this.reset();
    }
  }

  /**
   * Update scene data. `revision` is the document revision the RenderScene was built from;
   * geometry/material/light/environment changes are uploaded and restart accumulation.
   */
  sync(rs: RenderScene, camera: Camera, revision: number) {
    if (this.sceneVersion === -1 || revision !== this.revision) {
      // the generator detects unchanged geometry and only refits/rebuilds as needed
      this.pt.setScene(rs.scene, camera);
      this.sceneVersion = rs.structureVersion;
      this.lightsVersion = rs.lightsVersion;
      this.envKey = rs.envKey;
      this.revision = revision;
      this.storeCamera(camera);
      this.reset();
      return;
    }
    if (rs.lightsVersion !== this.lightsVersion) {
      this.lightsVersion = rs.lightsVersion;
      this.pt.updateLights();
      this.reset();
    }
    if (rs.envKey !== this.envKey) {
      this.envKey = rs.envKey;
      this.pt.updateEnvironment();
      this.reset();
    }
    const key = this.cameraKey(camera);
    if (key !== this.camKey) {
      this.pt.setCamera(camera);
      this.storeCamera(camera);
      this.reset();
    }
  }

  private cameraKey(camera: Camera) {
    camera.updateMatrixWorld();
    return camera.matrixWorld.elements.join(',') + '|' + (camera as unknown as { projectionMatrix: Matrix4 }).projectionMatrix.elements.join(',') + '|' + ((camera as unknown as { focusDistance?: number }).focusDistance ?? '') + ((camera as unknown as { fStop?: number }).fStop ?? '');
  }

  private storeCamera(camera: Camera) {
    this.camKey = this.cameraKey(camera);
    this.camMatrix.copy(camera.matrixWorld);
    this.camProj.copy((camera as unknown as { projectionMatrix: Matrix4 }).projectionMatrix);
  }

  setSize(w: number, h: number) {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.inner.setSize(w, h);
    this.reset();
  }

  reset() {
    this.pt.reset();
    this.inner.reset();
  }

  /** Render one sample pass (one tile when tiled). */
  sample() {
    const r = this.renderer;
    const ext = r.extensions.get('EXT_float_blend');
    this.inner.alpha = this.inner.material.backgroundAlpha !== 1 || !ext;
    const scissor = r.getScissorTest();
    r.setScissorTest(false);
    this.inner.update();
    r.setScissorTest(scissor);
  }

  dispose() {
    this.pt.dispose();
  }
}
