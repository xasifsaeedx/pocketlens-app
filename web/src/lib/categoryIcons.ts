// The category icon set, grouped for an intuitive picker (search + labeled sections).
// Values are SF Symbol names (the DB stores these; iOS renders them natively, web maps
// them to lucide-react via iconMap). Mirrors CategoryEditSheet.swift's `iconGroups` —
// keep the two in sync, and add any new symbol to iconMap.ts or it renders as a Tag.

export interface CategoryIconGroup {
  name: string
  icons: string[]
}

export const CATEGORY_ICON_GROUPS: CategoryIconGroup[] = [
  {
    name: 'Food & Drink',
    icons: [
      'cart.fill', 'basket.fill', 'fork.knife', 'takeoutbag.and.cup.and.straw.fill',
      'cup.and.saucer.fill', 'wineglass.fill', 'birthday.cake.fill', 'carrot.fill', 'fish.fill',
    ],
  },
  {
    name: 'Shopping',
    icons: [
      'bag.fill', 'creditcard.fill', 'gift.fill', 'tshirt.fill',
      'shippingbox.fill', 'tag.fill', 'eyeglasses', 'scissors',
    ],
  },
  {
    name: 'Transport',
    icons: [
      'car.fill', 'bus.fill', 'tram.fill', 'airplane',
      'bicycle', 'fuelpump.fill', 'ferry.fill', 'parkingsign',
    ],
  },
  {
    name: 'Home & Bills',
    icons: [
      'house.fill', 'bolt.fill', 'drop.fill', 'flame.fill',
      'lightbulb.fill', 'wifi', 'phone.fill', 'iphone', 'trash.fill',
      'wrench.and.screwdriver.fill', 'hammer.fill', 'paintbrush.fill',
    ],
  },
  {
    name: 'Health',
    icons: [
      'heart.fill', 'cross.fill', 'stethoscope', 'pills.fill',
      'dumbbell.fill', 'figure.run', 'bandage.fill',
    ],
  },
  {
    name: 'Entertainment',
    icons: [
      'tv.fill', 'music.note', 'gamecontroller.fill', 'film.fill', 'ticket.fill',
      'headphones', 'guitars.fill', 'popcorn.fill', 'camera.fill', 'paintpalette.fill',
    ],
  },
  {
    name: 'Work & Study',
    icons: [
      'book.fill', 'graduationcap.fill', 'pencil', 'briefcase.fill',
      'laptopcomputer', 'building.2.fill', 'newspaper.fill', 'envelope.fill',
    ],
  },
  {
    name: 'Money',
    icons: [
      'dollarsign.circle.fill', 'banknote.fill', 'wallet.pass.fill',
      'building.columns.fill', 'chart.line.uptrend.xyaxis', 'percent',
    ],
  },
  {
    name: 'Pets & Nature',
    icons: ['pawprint.fill', 'cat.fill', 'bird.fill', 'leaf.fill'],
  },
  {
    name: 'Travel',
    icons: [
      'suitcase.fill', 'map.fill', 'globe', 'mountain.2.fill',
      'tent.fill', 'sun.max.fill', 'umbrella.fill',
    ],
  },
  {
    name: 'Symbols',
    icons: [
      'star.fill', 'sparkles', 'crown.fill', 'trophy.fill', 'flag.fill',
      'bell.fill', 'bookmark.fill', 'key.fill', 'shield.fill', 'person.fill', 'person.2.fill',
    ],
  },
]

/** Flattened list of every pickable symbol (legacy consumers / lookups). */
export const CATEGORY_ICONS: string[] = CATEGORY_ICON_GROUPS.flatMap((g) => g.icons)

/**
 * The compact default set shown before the picker is expanded — the original 23 icons.
 * "Show all" reveals the full grouped, searchable set.
 */
export const CATEGORY_ICONS_FEATURED: string[] = [
  'cart.fill', 'fork.knife', 'car.fill', 'house.fill',
  'airplane', 'heart.fill', 'tshirt.fill', 'tv.fill',
  'creditcard.fill', 'dollarsign.circle.fill', 'gift.fill',
  'pawprint.fill', 'dumbbell.fill', 'music.note', 'book.fill',
  'cross.fill', 'fuelpump.fill', 'bag.fill', 'cup.and.saucer.fill',
  'tag.fill', 'star.fill', 'bolt.fill', 'drop.fill',
]
