-- ============================================================
-- CATEGORY GROUP COLOR + ICON
--   Groups were purely organisational (name + sort_order only).
--   Give them a color + SF Symbol icon so the client can render a
--   group the same way it renders a category (shared edit modal).
--
--   Additive + fresh-DB safe: nullable-with-default columns, existing
--   rows backfilled to a neutral gray + stack glyph. RLS already lives
--   on category_groups (own-row via user_id) — no policy change.
-- ============================================================

alter table category_groups
  add column if not exists color text not null default '#8E8E93',
  add column if not exists icon  text not null default 'square.stack.3d.up.fill';

-- Backfill any pre-existing rows whose columns are null (defensive; the
-- defaults above already cover rows created before this migration).
update category_groups set color = '#8E8E93' where color is null;
update category_groups set icon  = 'square.stack.3d.up.fill' where icon is null;
