-- Update 1 (supporting change): widen the server-side undo window.
--
-- The client's UNDO_WINDOW_SECONDS went from 5 to 12 as part of the
-- swipe-sensitivity work. The two windows have to stay consistent:
-- undo_swipe() enforces its own limit server-side (component 6, so a
-- client can't rewrite history at will), and if the server window is
-- shorter than the button's lifetime, the button sits there enabled and
-- silently fails when tapped -- the worst possible version of this,
-- since a mis-swipe is exactly the moment someone needs it to work.
--
-- 15s = the client's 12s plus the same round-trip/clock-skew grace the
-- original 8s carried over the old 5s. The button is gone at 12s either
-- way, so the extra 3s never widens what a user can actually do.

create or replace function app_undo_window() returns interval
  language sql immutable as $$ select interval '15 seconds' $$;
