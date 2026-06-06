export const SCORING_CRITERIA = [
  { id: 'title', label: 'Title Quality', baseMax: 12 },
  { id: 'summary', label: 'Summary Quality', baseMax: 10 },
  { id: 'headers', label: 'Header Structure', baseMax: 10 },
  { id: 'content', label: 'Content Completeness', baseMax: 18 },
  { id: 'scannability', label: 'Scannability & Structure', baseMax: 10 },
  { id: 'media', label: 'Alt Text / Media', baseMax: 8 },
  { id: 'code', label: 'Code Block Quality', baseMax: 8 },
  { id: 'tables', label: 'Table Quality', baseMax: 8 },
  { id: 'links', label: 'Links & URLs', baseMax: 8 },
  { id: 'taxonomy', label: 'Taxonomy & Product Context', baseMax: 8 }
];

export function computeDynamicMaxes(flags) {
  const naSet = new Set();
  if (!flags.includes('HAS_IMAGES') && !flags.includes('HAS_VIDEO')) naSet.add('media');
  if (!flags.includes('HAS_CODE_BLOCKS')) naSet.add('code');
  if (!flags.includes('HAS_TABLES')) naSet.add('tables');

  const freedPoints = SCORING_CRITERIA.filter(c => naSet.has(c.id)).reduce((sum, c) => sum + c.baseMax, 0);
  if (freedPoints === 0) return { maxes: Object.fromEntries(SCORING_CRITERIA.map(c => [c.id, c.baseMax])), naSet };

  const activeIds = SCORING_CRITERIA.filter(c => !naSet.has(c.id)).map(c => c.id);
  const redistribution = {};
  const contentBonus = Math.round(freedPoints * 0.45);
  redistribution['content'] = contentBonus;

  const secondaryIds = activeIds.filter(id => id !== 'content' && id !== 'title' && id !== 'summary');
  const secondaryBase = secondaryIds.reduce((s, id) => s + SCORING_CRITERIA.find(c => c.id === id).baseMax, 0);
  const remaining = freedPoints - contentBonus;
  for (const id of secondaryIds) {
    const base = SCORING_CRITERIA.find(c => c.id === id).baseMax;
    redistribution[id] = Math.round(remaining * (base / secondaryBase));
  }

  const maxes = {};
  for (const c of SCORING_CRITERIA) {
    if (naSet.has(c.id)) maxes[c.id] = 0;
    else maxes[c.id] = c.baseMax + (redistribution[c.id] || 0);
  }
  const total = Object.values(maxes).reduce((a, b) => a + b, 0);
  if (total !== 100) maxes['content'] += (100 - total);

  return { maxes, naSet };
}
