import { z } from 'zod';

/**
 * Sync-ready trader annotation. Annotations are keyed by the stable Fomo
 * trader ID, never by display handle, so they survive handle renames and
 * multi-device conflict resolution. The deletedAt field is a tombstone
 * marker reserved for future multi-device sync.
 */
export interface TraderAnnotationV1 {
  traderId: string;
  label?: string;
  color?: string;
  pinned?: boolean;
  muted?: boolean;
  updatedAt: number;
  deletedAt?: number;
}

export const MAX_ANNOTATION_LABEL_LENGTH = 40;

/**
 * Small, documented allowlist of hex swatches available for trader labels.
 * Kept deliberately short so the popup can render a fixed swatch picker.
 */
export const ANNOTATION_COLORS = [
  '#ef4444', // red — notable risk
  '#f97316', // orange — momentum
  '#eab308', // yellow — caution
  '#22c55e', // green — profit
  '#3b82f6', // blue — neutral
  '#8b5cf6', // violet — whale
  '#ec4899', // pink — favorite
  '#64748b', // slate — quiet
] as const;

export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

export const annotationColorSchema = z.enum(ANNOTATION_COLORS);

export const traderAnnotationSchema = z
  .object({
    traderId: z.string().trim().min(1),
    label: z.string().max(MAX_ANNOTATION_LABEL_LENGTH).optional(),
    color: annotationColorSchema.optional(),
    pinned: z.boolean().optional(),
    muted: z.boolean().optional(),
    updatedAt: z.number().int().nonnegative(),
    deletedAt: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/** Write-side annotation changes; omitted fields keep their stored value. */
export interface TraderAnnotationUpdate {
  label?: string;
  color?: AnnotationColor;
  pinned?: boolean;
  muted?: boolean;
}
