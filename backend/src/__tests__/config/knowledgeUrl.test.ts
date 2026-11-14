import { normalizeKnowledgeUrl } from '../../config/knowledgeUrl';

describe('normalizeKnowledgeUrl', () => {
  it('accepts http and https and strips trailing slashes', () => {
    expect(normalizeKnowledgeUrl('http://knowledge:3100')).toBe('http://knowledge:3100');
    expect(normalizeKnowledgeUrl('  https://k.example/base//  ')).toBe('https://k.example/base');
  });

  it('rejects other protocols, garbage and credentials', () => {
    for (const raw of ['ftp://x', 'not a url', '', 'http://user:pw@x:3100', 'http://user@x']) {
      expect(normalizeKnowledgeUrl(raw)).toBeNull();
    }
  });

  it('rejects a query, a fragment and a bare trailing ? or #', () => {
    for (const raw of [
      'https://knowledge.example/base?x=1',
      'https://knowledge.example/base#f',
      'https://knowledge.example/base?',
      'https://knowledge.example/base#',
      'https://knowledge.example/?',
    ]) {
      expect(normalizeKnowledgeUrl(raw)).toBeNull();
    }
  });
});
