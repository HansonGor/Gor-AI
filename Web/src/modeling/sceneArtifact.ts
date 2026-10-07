import { exportSceneGlb, type SceneSpec } from './sceneSpec.ts';
import type { GeneratedFile } from '../types.ts';
import { glbFileName } from '../preview/core/artifactFormat.ts';

/** Generate the deliverable from data, independently of the HTML viewer/compiler. */
export async function saveSceneArtifact(
  scene: SceneSpec,
  save: (blob: Blob, name: string) => Promise<GeneratedFile>,
): Promise<GeneratedFile> {
  const blob = await exportSceneGlb(scene);
  return save(blob, glbFileName(scene.name));
}
