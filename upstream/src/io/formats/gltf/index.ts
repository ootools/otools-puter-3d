// glTF 2.0 registration: File ▸ Import / Export ▸ glTF 2.0 (.glb/.gltf)
import { commitToApp, defineFormat, encodeImagePng, exportSceneFromApp, packMetallicRoughnessPng, readFileBytes, reportWarnings, APPLY_MODIFIERS } from '../glue';
import { companionFilesDialog } from '../ui';
import { externalUris, parseContainer, readGltf } from './read';
import { writeGltf } from './write';
import { baseName } from '../common';

defineFormat({
  id: 'gltf',
  label: 'glTF 2.0 (.glb/.gltf)',
  extensions: ['.glb', '.gltf'],
  description: 'Khronos glTF 2.0 binary or JSON (embedded or with external .bin/textures)',
  importOptions: [
    { id: 'merge_vertices', label: 'Merge Vertices', type: 'bool', default: false, description: 'Weld vertices with identical positions (sharp edges are kept where normals differ)' },
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
    {
      id: 'bone_heuristic',
      label: 'Bone Dir',
      type: 'enum',
      default: 'AUTO',
      items: [
        ['AUTO', 'Best Fit (point at children)'],
        ['Y', 'glTF (keep joint axes)'],
      ],
    },
  ],
  exportOptions: [
    {
      id: 'format',
      label: 'Format',
      type: 'enum',
      default: 'GLB',
      items: [
        ['GLB', 'glTF Binary (.glb)'],
        ['GLTF_EMBEDDED', 'glTF Embedded (.gltf)'],
      ],
    },
    { id: 'y_up', label: '+Y Up', type: 'bool', default: true },
    APPLY_MODIFIERS,
    { id: 'skins', label: 'Skinning', type: 'bool', default: true, description: 'Export armatures as skins (armature modifiers are not applied)' },
    { id: 'shape_keys', label: 'Shape Keys', type: 'bool', default: true, description: 'Export shape keys as morph targets' },
    { id: 'animation', label: 'Animation', type: 'bool', default: true, description: 'Sample object, bone and shape key animation every frame' },
    {
      id: 'animation_mode',
      label: 'Animation Mode',
      type: 'enum',
      default: 'ACTIONS',
      items: [
        ['ACTIONS', 'Actions'],
        ['SCENE', 'Scene (single animation)'],
      ],
      showIf: (v) => !!v.animation,
    },
    { id: 'scene_range', label: 'Use Scene Frame Range', type: 'bool', default: false, showIf: (v) => !!v.animation },
    { id: 'extras', label: 'Custom Properties', type: 'bool', default: true },
  ],
  async importFile(file, o) {
    const bytes = await readFileBytes(file);
    const resources = new Map<string, Uint8Array>();
    if (!file.name.toLowerCase().endsWith('.glb')) {
      const { json } = parseContainer(bytes);
      const missing = externalUris(json);
      if (missing.length) {
        const files = await companionFilesDialog(
          'External glTF Resources',
          `"${file.name}" references external files. Select them (they can be chosen together) to import buffers and textures:`,
          missing.map(baseName),
          [...new Set(missing.map((m) => `.${m.split('.').pop()}`))].join(','),
        );
        for (const f of files) resources.set(f.name, await readFileBytes(f));
      }
    }
    const ir = readGltf(bytes, { resources });
    commitToApp(ir, { mergeVertices: !!o.merge_vertices, shading: o.shading as 'NORMALS', boneDirection: o.bone_heuristic as 'AUTO' });
  },
  async exportFile(o) {
    const scene = exportSceneFromApp({
      selectedOnly: o.selectedOnly,
      applyModifiers: !!o.apply_modifiers,
      skins: !!o.skins,
      shapeKeys: !!o.shape_keys,
      animation: !!o.animation,
      sceneFrameRange: !!o.scene_range,
    });
    const glb = o.format !== 'GLTF_EMBEDDED';
    const res = await writeGltf(scene, {
      format: glb ? 'GLB' : 'GLTF_EMBEDDED',
      yUp: !!o.y_up,
      extras: !!o.extras,
      encodeImage: encodeImagePng,
      packMetallicRoughness: packMetallicRoughnessPng,
      animationMode: o.animation_mode as 'ACTIONS',
      generator: 'Puter 3D glTF exporter',
    });
    reportWarnings(res.warnings);
    return { bytes: res.bytes, mime: glb ? 'model/gltf-binary' : 'model/gltf+json', ext: glb ? '.glb' : '.gltf' };
  },
});
