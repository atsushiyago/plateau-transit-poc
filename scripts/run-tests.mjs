import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const out = mkdtempSync(join(tmpdir(), 'plateau-tests-'));
try {
  const compile = spawnSync('node', ['node_modules/typescript/bin/tsc', '--target','ES2022','--module','commonjs','--skipLibCheck','--outDir',out,'app/lib/transit-analysis.ts','app/lib/network-routing.ts','app/lib/async-generation.ts'], {stdio:'inherit'});
  if (compile.status !== 0) process.exitCode = 1;
  else {
    const tests = spawnSync('node',['--test','scripts/tests/transit.test.mjs'],{stdio:'inherit',env:{...process.env,TRANSIT_TEST_BUILD:out}});
    process.exitCode = tests.status ?? 1;
  }
} finally { rmSync(out,{recursive:true,force:true}); }
