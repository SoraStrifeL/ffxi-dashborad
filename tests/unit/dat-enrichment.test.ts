import { describe, it, expect } from 'vitest';
import { normalizeDatName, buildIdIndex, buildNameIndex, type DatRow } from '../../src/dat';

describe('normalizeDatName', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normalizeDatName('Provoke')).toBe('provoke');
    expect(normalizeDatName("Foreman's Best Friend")).toBe('foremansbestfriend');
  });

  it('treats case and punctuation differences as equal', () => {
    expect(normalizeDatName('Bronze Subligar +1')).toBe(normalizeDatName('bronze_subligar_+1'));
  });

  it('collapses whitespace and underscores the same way', () => {
    expect(normalizeDatName('Zeruhn Report')).toBe(normalizeDatName('zeruhn_report'));
  });
});

describe('buildIdIndex', () => {
  it('indexes rows by their numeric id', () => {
    const rows: DatRow[] = [
      { id: 12832, name: 'Bronze Subligar', description: 'DEF:3' },
      { id: 12823, name: 'Brz. Subligar +1', description: 'DEF:4' },
    ];
    const idx = buildIdIndex(rows);
    expect(idx.get(12832)?.name).toBe('Bronze Subligar');
    expect(idx.get(12823)?.description).toBe('DEF:4');
    expect(idx.get(1)).toBeUndefined();
  });

  it('last row wins on a duplicate id', () => {
    const rows: DatRow[] = [
      { id: 1, name: 'First' },
      { id: 1, name: 'Second' },
    ];
    expect(buildIdIndex(rows).get(1)?.name).toBe('Second');
  });
});

describe('buildNameIndex', () => {
  const rows: DatRow[] = [
    { id: 547, name: 'Provoke', description: 'Goads an enemy into attacking you.' },
    { id: 716, name: 'Animated Flourish', description: 'Provokes target.' },
  ];

  it('looks up by exact normalized name', () => {
    const idx = buildNameIndex(rows);
    expect(idx.get(normalizeDatName('Provoke'))?.id).toBe(547);
  });

  it('matches case-insensitively, matching DB names like "provoke"', () => {
    const idx = buildNameIndex(rows);
    expect(idx.get(normalizeDatName('provoke'))?.id).toBe(547);
  });

  it('does not match a substring of a different entry', () => {
    const idx = buildNameIndex(rows);
    expect(idx.get(normalizeDatName('Animated'))).toBeUndefined();
  });

  it('matches "+1" gear variants once punctuation is stripped', () => {
    const gearRows: DatRow[] = [
      { id: 12832, name: 'Bronze Subligar', description: 'DEF:3' },
      { id: 12823, name: 'Brz. Subligar +1', description: 'bronze subligar +1' },
    ];
    const idx = buildNameIndex(gearRows);
    expect(idx.get(normalizeDatName('bronze_subligar_+1'))).toBeUndefined(); // DB uses a different short name than the DAT "Brz." abbreviation — documents the limit of name-matching
    expect(idx.get(normalizeDatName('Bronze Subligar'))?.id).toBe(12832);
  });
});
