import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SOURCE_URL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json';
const TARGET_COLLECTIONS = new Set([
  'The Harlequin Collection',
  'The Ascent Collection',
  'The Boreal Collection',
  'The Radiant Collection',
  'The Graphic Design Collection'
]);

const WEAR_LABELS = [
  { key: 'Factory New', min: 0.0, max: 0.07 },
  { key: 'Minimal Wear', min: 0.07, max: 0.15 },
  { key: 'Field-Tested', min: 0.15, max: 0.38 },
  { key: 'Well-Worn', min: 0.38, max: 0.45 },
  { key: 'Battle-Scarred', min: 0.45, max: 1.0 }
];

const { stdout } = await execFileAsync('curl', ['-sL', SOURCE_URL], { maxBuffer: 20 * 1024 * 1024 });
const raw = JSON.parse(stdout);

const skins = raw
  .filter((skin) => skin.collections?.some((c) => TARGET_COLLECTIONS.has(c.name)))
  .map((skin) => {
    const collections = skin.collections.map((c) => c.name).filter((n) => TARGET_COLLECTIONS.has(n));
    const minFloat = skin.min_float ?? 0;
    const maxFloat = skin.max_float ?? 1;

    return {
      id: skin.id,
      name: skin.name,
      weapon: skin.weapon?.name ?? skin.weapon?.id ?? '',
      rarity: skin.rarity?.name ?? 'Unknown',
      minFloat,
      maxFloat,
      stattrak: Boolean(skin.stattrak),
      souvenir: Boolean(skin.souvenir),
      collections,
      availableExteriors: WEAR_LABELS
        .filter((wear) => Math.max(minFloat, wear.min) < Math.min(maxFloat, wear.max))
        .map((wear) => wear.key)
    };
  })
  .sort((a, b) => a.collections[0].localeCompare(b.collections[0]) || a.rarity.localeCompare(b.rarity) || a.name.localeCompare(b.name));

const output = {
  generatedAt: new Date().toISOString(),
  source: SOURCE_URL,
  collections: [...TARGET_COLLECTIONS],
  totalSkins: skins.length,
  skins
};

await fs.writeFile(new URL('../public/data/collection_skins.json', import.meta.url), JSON.stringify(output, null, 2));
console.log(`Generated ${skins.length} skins`);
