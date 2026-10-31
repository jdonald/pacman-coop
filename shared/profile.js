// Player names & avatar skins.

const ADJECTIVES = [
  'Wobbly', 'Sneaky', 'Crunchy', 'Bouncy', 'Sleepy', 'Turbo', 'Fuzzy', 'Giggly',
  'Hungry', 'Sparkly', 'Wiggly', 'Zippy', 'Grumpy', 'Cosmic', 'Soggy', 'Jolly',
  'Spicy', 'Dizzy', 'Mighty', 'Tiny', 'Funky', 'Noodly', 'Snappy', 'Chunky',
];
const NOUNS = [
  'Waffle', 'Pickle', 'Noodle', 'Muffin', 'Taco', 'Biscuit', 'Dumpling', 'Pretzel',
  'Nugget', 'Pancake', 'Meatball', 'Burrito', 'Gumdrop', 'Crouton', 'Bagel', 'Donut',
  'Potato', 'Cupcake', 'Churro', 'Tater', 'Mochi', 'Nacho', 'Jellybean', 'Cheeto',
];

export function randomName(rand = Math.random) {
  const a = ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(rand() * NOUNS.length)];
  return `${a} ${n}`;
}

export const SKIN_COLORS = [
  { id: 'sun', label: 'Sunshine', hex: '#ffd60a' },
  { id: 'bubblegum', label: 'Bubblegum', hex: '#ff6fb5' },
  { id: 'ice', label: 'Ice', hex: '#5ee6ff' },
  { id: 'lime', label: 'Lime', hex: '#7dff5a' },
  { id: 'tangerine', label: 'Tangerine', hex: '#ff9d2e' },
  { id: 'grape', label: 'Grape', hex: '#b98bff' },
  { id: 'snow', label: 'Snow', hex: '#f4f4f4' },
  { id: 'cherry', label: 'Cherry', hex: '#ff4d4d' },
];

export const HATS = [
  { id: 'none', label: 'None' },
  { id: 'bow', label: 'Bow' },
  { id: 'cap', label: 'Cap' },
  { id: 'crown', label: 'Crown' },
  { id: 'tophat', label: 'Top hat' },
  { id: 'shades', label: 'Shades' },
  { id: 'propeller', label: 'Propeller' },
];

/** Default skin for a player slot so that co-op partners look different. */
export function defaultSkin(rand = Math.random) {
  const color = SKIN_COLORS[Math.floor(rand() * 6)].id;
  const hat = HATS[1 + Math.floor(rand() * (HATS.length - 1))].id;
  return { color, hat };
}

export function colorHex(colorId) {
  return (SKIN_COLORS.find((c) => c.id === colorId) || SKIN_COLORS[0]).hex;
}

/** Sanitize an untrusted profile coming from the network. */
export function sanitizeProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  let name = typeof p.name === 'string' ? p.name : '';
  name = name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 18);
  if (!name) name = randomName();
  const skin = p.skin && typeof p.skin === 'object' ? p.skin : {};
  const color = SKIN_COLORS.some((c) => c.id === skin.color) ? skin.color : 'sun';
  const hat = HATS.some((h) => h.id === skin.hat) ? skin.hat : 'none';
  return { name, skin: { color, hat } };
}
