// Collada registration: File ▸ Import ▸ Collada (.dae)
import { commitToApp, defineFormat, readFileBytes } from './glue';
import { companionFilesDialog } from './ui';
import { colladaImageFiles, readCollada } from './collada';

defineFormat({
  id: 'collada',
  label: 'Collada (.dae)',
  extensions: ['.dae'],
  description: 'COLLADA 1.4/1.5 documents (meshes, materials, hierarchy, cameras, lights, skins, animation)',
  importOptions: [
    { id: 'merge_vertices', label: 'Merge Vertices', type: 'bool', default: true, description: 'Weld the triangle soup produced by the loader back into connected meshes' },
    {
      id: 'bone_heuristic',
      label: 'Bone Dir',
      type: 'enum',
      default: 'AUTO',
      items: [
        ['AUTO', 'Best Fit (point at children)'],
        ['Y', 'Keep Joint Axes'],
      ],
    },
  ],
  async importFile(file, o) {
    const text = new TextDecoder().decode(await readFileBytes(file));
    const resources = new Map<string, Uint8Array>();
    const images = colladaImageFiles(text);
    if (images.length) {
      const files = await companionFilesDialog('Collada Textures', `"${file.name}" references these images. Select them to import the textures:`, images, 'image/*,.tga,.tif,.tiff');
      for (const f of files) resources.set(f.name, await readFileBytes(f));
    }
    const ir = await readCollada(text, resources);
    commitToApp(ir, { mergeVertices: !!o.merge_vertices, boneDirection: o.bone_heuristic as 'AUTO' });
  },
});
