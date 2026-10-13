import { truncateHead } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ImageGenResult } from './types.js';

export const imageOutputSchema = Type.Union([
  Type.Object({
    model: Type.String(),
    provider: Type.String(),
    images: Type.Array(
      Type.Object({
        path: Type.String(),
        mimeType: Type.String(),
        revisedPrompt: Type.Optional(Type.String()),
      }),
    ),
    truncated: Type.Boolean(),
    totalImages: Type.Integer(),
  }),
  Type.Object({ error: Type.String() }),
]);

export function imageOutput(result: ImageGenResult) {
  const model = truncateHead(result.model, { maxBytes: 256, maxLines: 10 }).content;
  const provider = truncateHead(result.provider, { maxBytes: 256, maxLines: 10 }).content;
  let truncated = model !== result.model || provider !== result.provider;
  const output = {
    model,
    provider,
    images: result.images.map((image) => {
      if (image.revisedPrompt === undefined) return { path: image.path, mimeType: image.mimeType };
      const prompt = truncateHead(image.revisedPrompt, { maxBytes: 1024, maxLines: 100 }).content;
      truncated ||= prompt !== image.revisedPrompt;
      return { path: image.path, mimeType: image.mimeType, revisedPrompt: prompt };
    }),
    truncated,
    totalImages: result.images.length,
  };
  if (Buffer.byteLength(JSON.stringify(output)) > 6 * 1024) {
    output.images = output.images.map(({ path, mimeType }) => ({ path, mimeType }));
    output.truncated = true;
  }
  while (Buffer.byteLength(JSON.stringify(output)) > 6 * 1024 && output.images.length)
    output.images.pop();
  return output;
}
