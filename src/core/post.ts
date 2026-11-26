// Global post settings: each scene file may set them (`post` in lab/scenes/*.json); the show's
// post node (core-post) mixes them during transitions and adds the pads' FX on top.

export interface PostParams {
  decay: number; zoom: number; rotate: number;
  bloom: number; threshold: number; exposure: number;
}

/** Per-host views: same scene state, different framing of it. Index = view number. */
export const VIEWS = ['normal', 'mirror', 'flip', 'rotate 180', 'zoom', 'kaleido'] as const;

export const POST_DEFAULT: PostParams = { decay: 0, zoom: 0, rotate: 0, bloom: 0.6, threshold: 0.7, exposure: 1 };
export const POST_KEYS = Object.keys(POST_DEFAULT) as (keyof PostParams)[];
