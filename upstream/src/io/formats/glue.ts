// Browser/app glue for the interchange formats: registration with File ▸ Import/Export,
// options dialogs, committing IR into the open document and reporting warnings.
import { app } from '../../app/app';
import type { ImageData } from '../../data/types';
import { registerFormat } from '../files';
import { imageCanvas } from '../../render/images';
import { activeCollection, setMode } from '../../ops/object';
import { commitScene, type CommitOptions } from './to-document';
import type { IRScene } from './ir';
import { buildExportScene, type ExportOptions, type ExportScene } from './scene-builder';
import { optionsDialog, type FormatOption } from './ui';

export interface FormatDef {
  id: string;
  label: string;
  extensions: string[];
  description?: string;
  importOptions?: FormatOption[];
  exportOptions?: FormatOption[];
  /** import a picked file into the current document */
  importFile?: (file: File, options: Record<string, unknown>) => Promise<void>;
  /** produce the exported file */
  exportFile?: (options: Record<string, unknown> & { selectedOnly: boolean }) => Promise<{ bytes: Uint8Array | string; mime: string; ext: string }>;
}

export function defineFormat(def: FormatDef) {
  registerFormat({
    id: def.id,
    label: def.label,
    extensions: def.extensions,
    description: def.description,
    import: def.importFile
      ? async (file: File) => {
          const opts = await optionsDialog(`Import ${def.label}`, `${def.id}:import`, def.importOptions ?? [], 'Import', file.name);
          await def.importFile!(file, opts);
        }
      : undefined,
    export: def.exportFile
      ? async ({ selectedOnly }) => {
          const opts = await optionsDialog(`Export ${def.label}`, `${def.id}:export`, def.exportOptions ?? [], 'Export', selectedOnly ? 'Selected objects only' : 'All objects in the scene');
          return def.exportFile!({ ...opts, selectedOnly });
        }
      : undefined,
  });
}

/** Commit an IR scene into the open document (one undo step is pushed by the caller). */
export function commitToApp(ir: IRScene, opts: CommitOptions = {}) {
  const doc = app.doc;
  if (doc.mode !== 'OBJECT') setMode(doc, 'OBJECT');
  const res = commitScene(doc, ir, { collection: activeCollection(doc), ...opts });
  for (const w of res.warnings) app.report('WARNING', w);
  if (!res.objects.length) app.report('WARNING', 'The file contained no importable objects');
  app.changed('doc', 'select');
  return res;
}

export function exportSceneFromApp(opts: ExportOptions): ExportScene {
  return buildExportScene(app.doc, opts, app.graph);
}

export function reportWarnings(warnings: string[]) {
  for (const w of [...new Set(warnings)]) app.report('WARNING', w);
}

/** Encode an image's current pixels as PNG through a canvas (generated/painted images). */
export async function encodeImagePng(img: ImageData): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const canvas = imageCanvas(img);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return null;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' };
  } catch {
    return null;
  }
}

export async function readFileBytes(file: File) {
  return new Uint8Array(await file.arrayBuffer());
}

export const APPLY_MODIFIERS: FormatOption = { id: 'apply_modifiers', label: 'Apply Modifiers', type: 'bool', default: true, description: 'Export the evaluated mesh (viewport modifier settings)' };

/** Pack roughness (→ G) and metallic (→ B) image channels into one PNG (glTF layout). */
export async function packMetallicRoughnessPng(rough: { img: ImageData; channel: string } | null, metal: { img: ImageData; channel: string } | null): Promise<Uint8Array | null> {
  try {
    const decode = async (img: ImageData) => {
      if (img.bytes) return await createImageBitmap(new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.mime }));
      return await createImageBitmap(imageCanvas(img));
    };
    const r = rough ? await decode(rough.img) : null,
      m = metal ? await decode(metal.img) : null;
    const w = Math.max(r?.width ?? 1, m?.width ?? 1),
      h = Math.max(r?.height ?? 1, m?.height ?? 1);
    const read = (bmp: ImageBitmap | null) => {
      if (!bmp) return null;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const rp = read(r),
      mp = read(m);
    const ch = (c: string) => (c === 'G' ? 1 : c === 'B' ? 2 : c === 'A' ? 3 : 0);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d')!;
    const data = octx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      data.data[i * 4] = 255;
      data.data[i * 4 + 1] = rp ? rp[i * 4 + ch(rough!.channel)] : 255;
      data.data[i * 4 + 2] = mp ? mp[i * 4 + ch(metal!.channel)] : 255;
      data.data[i * 4 + 3] = 255;
    }
    octx.putImageData(data, 0, 0);
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
