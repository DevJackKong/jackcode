import { performance } from 'node:perf_hooks';
import { ContextCompressor } from '../src/repo/context-compressor.ts';

const now = Date.now();
const fragments = Array.from({ length: 120 }, (_, i) => ({
  id: `frag-${i}`,
  type: i % 5 === 0 ? 'doc' : i % 7 === 0 ? 'chat' : 'code',
  content: [
    `// IMPORTANT ${i}`,
    `export interface Type${i} { value: string; index: number }`,
    `export function fn${i}(input: string, count: number) {`,
    `  const cache = input.repeat(count);`,
    `  return cache.slice(0, 100);`,
    `}`,
    `fn${i} fn${i} fn${i}`,
  ].join('\n').repeat(8),
  source: `src/module-${i}.ts`,
  timestamp: now - i * 1000,
  metadata: {
    accessCount: 1 + (i % 10),
    lastAccess: now - i * 1000,
    priority: i % 9 === 0 ? 0.95 : 0.35,
    tags: i % 11 === 0 ? ['critical'] : [],
  },
}));

const compressor = new ContextCompressor();
const packed = compressor.pack(fragments);

const scenarios = [
  { name: 'level1-qwen', options: { level: 1, model: 'qwen', query: 'module function cache' } },
  { name: 'level2-gpt', options: { level: 2, model: 'gpt', query: 'critical interface signatures' } },
  { name: 'level3-deepseek-tight', options: { level: 3, model: 'deepseek', query: 'important summary', reservedOutputTokens: 50000 } },
];

for (const scenario of scenarios) {
  const t0 = performance.now();
  const result = compressor.compressWithOptions(packed, scenario.options);
  const t1 = performance.now();
  console.log(JSON.stringify({
    scenario: scenario.name,
    durationMs: Number((t1 - t0).toFixed(2)),
    originalTokens: result.stats.originalTokens,
    finalTokens: result.stats.finalTokens,
    savedTokens: result.stats.savedTokens,
    fragmentsOut: result.fragments.length,
    ratio: Number(result.stats.ratio.toFixed(4)),
  }));
}
