// USD registration: File ▸ Import / Export ▸ Universal Scene Description (.usd*)
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { commitToApp, defineFormat, encodeImagePng, exportSceneFromApp, readFileBytes, reportWarnings, APPLY_MODIFIERS } from '../glue';
import { companionFilesDialog } from '../ui';
import { readUsd, usdExternalFiles } from './read';
import { packUsdz, writeUsda } from './write';
import { app } from '../../../app/app';

defineFormat({
  id: 'usd',
  label: 'Universal Scene Description (.usd*)',
  extensions: ['.usd', '.usda', '.usdc', '.usdz'],
  description: 'USD text (.usda), binary crate (.usdc) and packages (.usdz)',
  importOptions: [
    { id: 'scale', label: 'Scale', type: 'float', default: 1, min: 0.0001, max: 10000 },
    { id: 'import_animation', label: 'Animation', type: 'bool', default: true },
    {
      id: 'shading',
      label: 'Shading',
      type: 'enum',
      default: 'NORMALS',
      items: [
        ['NORMALS', 'Use Normal Data'],
        ['FLAT', 'Flat Shading'],
        ['SMOOTH', 'Smooth Shading'],
      ],
    },
  ],
  exportOptions: [
    {
      id: 'format',
      label: 'Format',
      type: 'enum',
      default: 'USDZ',
      items: [
        ['USDZ', 'USDZ package (.usdz)'],
        ['USDA', 'USD text (.usda)'],
        ['USDA_ZIP', 'USDA + textures (.zip)'],
      ],
    },
    {
      id: 'up_axis',
      label: 'Up Axis',
      type: 'enum',
      default: 'Z',
      items: [
        ['Z', 'Z'],
        ['Y', 'Y'],
      ],
    },
    APPLY_MODIFIERS,
    { id: 'export_armatures', label: 'Armatures (UsdSkel)', type: 'bool', default: true },
    { id: 'export_shapekeys', label: 'Shape Keys', type: 'bool', default: true },
    { id: 'export_animation', label: 'Animation', type: 'bool', default: true },
  ],
  async importFile(file, o) {
    const bytes = await readFileBytes(file);
    const resources = new Map<string, Uint8Array>();
    const missing = usdExternalFiles(bytes);
    if (missing.length) {
      const files = await companionFilesDialog('USD Dependencies', `"${file.name}" references other files (textures, layers). Select them to include them:`, missing, '.usd,.usda,.usdc,image/*');
      for (const f of files) resources.set(f.name, await readFileBytes(f));
    }
    const ir = readUsd(bytes, { resources });
    ir.unitScale *= Number(o.scale) || 1;
    if (!o.import_animation) ir.animations = [];
    commitToApp(ir, { shading: o.shading as 'NORMALS' });
  },
  async exportFile(o) {
    const scene = exportSceneFromApp({
      selectedOnly: o.selectedOnly,
      applyModifiers: !!o.apply_modifiers,
      skins: !!o.export_armatures,
      shapeKeys: !!o.export_shapekeys,
      animation: !!o.export_animation,
    });
    const out = await writeUsda(scene, { upAxis: o.up_axis as 'Z', animation: !!o.export_animation, encodeImage: encodeImagePng });
    reportWarnings(out.warnings);
    const base = app.filename.replace(/\.[^.]+$/, '') || 'scene';
    if (o.format === 'USDA') {
      if (out.textures.length) app.report('WARNING', `${out.textures.length} texture(s) are referenced but not included; use USDZ or "USDA + textures" to keep them`);
      return { bytes: out.usda, mime: 'text/plain', ext: '.usda' };
    }
    if (o.format === 'USDA_ZIP') {
      const files: Record<string, Uint8Array> = { [`${base}.usda`]: new TextEncoder().encode(out.usda) };
      for (const t of out.textures) files[t.path] = t.bytes;
      return { bytes: zipSync(files, { level: 6 }), mime: 'application/zip', ext: '.usda.zip' };
    }
    return { bytes: packUsdz(out, `${base}.usda`), mime: 'model/vnd.usdz+zip', ext: '.usdz' };
  },
});
