/**
 * Output budgets for the two tools.
 *
 * Tool results land in the model's context, so an unbounded dump (a whole
 * script of 60+ lines, 12 archive sections, 48 appearance rows) costs tokens
 * on every later turn of that conversation. Defaults below are the compact
 * set; every value can be raised individually through an env var, or all of
 * them at once with `ARK_WIKI_VERBOSE=1` (the pre-0.12 sizes).
 */

const VERBOSE = /^(1|true|yes|on)$/i.test(String(process.env.ARK_WIKI_VERBOSE ?? ''))

function envInt (name, compact, verbose) {
  const raw = Number(process.env[name])
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return VERBOSE ? verbose : compact
}

/** Story scripts: dialogue lines kept per lookup. */
export const STORY_LINE_LIMIT = envInt('ARK_WIKI_STORY_LINES', 24, 60)
/** Story scripts: characters per dialogue line. */
export const STORY_LINE_CHARS = envInt('ARK_WIKI_STORY_CHARS', 240, 300)
/** Story scripts: cast names listed above the dialogue. */
export const STORY_CHARACTER_LIMIT = envInt('ARK_WIKI_STORY_CAST', 12, 20)

/** 干员出场: appearance rows kept. */
export const APPEARANCE_LIMIT = envInt('ARK_WIKI_APPEARANCES', 24, 48)

/** Candidate rows kept for item/stage/story/world fuzzy matches. */
export const MAX_CANDIDATES = envInt('ARK_WIKI_CANDIDATES', 5, 8)

/** Operator sheet: archive sections kept and characters per section. */
export const ARCHIVE_LIMIT = envInt('ARK_WIKI_ARCHIVES', 6, 12)
export const ARCHIVE_TEXT_CHARS = envInt('ARK_WIKI_ARCHIVE_CHARS', 300, 400)

/** 泰拉大典 rows kept in each rendered block. */
export const WORLD_INFOBOX_LIMIT = envInt('ARK_WIKI_INFOBOX', 6, 8)
export const WORLD_DETAIL_LIMIT = envInt('ARK_WIKI_DETAILS', 4, 6)
export const WORLD_TERM_LIMIT = envInt('ARK_WIKI_TERMS', 3, 4)
