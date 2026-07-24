// cookList.js — the cooking list roll-up (pure).
//
// THE BUG THIS FIXES: the list keyed each line on
// `${it.category}::${it.name}::${it.variant}`, trusting the `category` stored
// ON THE ITEM. Manual entries carry one (the picker sets it from the menu);
// orders that arrive through the customer form do not carry the same value.
// So the SAME dish in the SAME variant produced two different keys and showed
// up as two separate lines with two separate counts, and Kevin had to add them
// in his head every week while cooking.
//
// THE FIX: derive the category from the menu BY NAME, and key only on
// name + variant. Two lines for one dish then become structurally impossible
// rather than something to watch for, because the category can no longer vary
// for a given name. Whatever the item claims about itself is used only as a
// fallback for things the menu does not know (an omakase line, an off-menu
// one-off), which is exactly where a stored category is the only information
// available.
//
// The menu map is INJECTED rather than imported so this stays testable without
// dragging the registry in, and so it always reflects the same source the
// order pickers used.

export const UNCATEGORIZED = 'other';

// menuByCategory: { [categoryKey]: [{ name }, ...] } — pass FULL_MENU.
export function categoryIndex(menuByCategory) {
  const index = new Map();
  for (const [cat, items] of Object.entries(menuByCategory || {})) {
    for (const it of items || []) {
      if (it && it.name && !index.has(it.name)) index.set(it.name, cat);
    }
  }
  return index;
}

// orders: active orders. categoryOrder: Object.keys(CATEGORY_LABELS).
export function buildCookList(orders, menuByCategory, categoryOrder) {
  const index = categoryIndex(menuByCategory);
  const order = Array.isArray(categoryOrder) ? categoryOrder : [];
  const map = new Map();

  for (const o of orders || []) {
    for (const it of (o && o.items) || []) {
      if (!it || !it.name) continue;
      const name = it.name;
      const variant = it.variant || '';
      // Name plus variant ONLY. The category is derived below and is identical
      // for every occurrence of a name, so it cannot split a count.
      const key = `${name}::${variant}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          // Derived first, item's own claim second, bucket of last resort third.
          category: index.get(name) || it.category || UNCATEGORIZED,
          name,
          variant,
          qty: 0,
        });
      }
      map.get(key).qty += Number(it.qty) || 1;
    }
  }

  const rank = (c) => {
    const i = order.indexOf(c);
    return i === -1 ? order.length : i; // unknown categories sort last, together
  };
  return [...map.values()].sort(
    (a, b) => rank(a.category) - rank(b.category)
      || a.name.localeCompare(b.name)
      || a.variant.localeCompare(b.variant)
  );
}
