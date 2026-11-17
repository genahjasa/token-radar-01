// Token Radar's entrypoint (Node 22, standard library only): snapshot in, ranked board out.
//
// The run has four moves. First it reads the sealed snapshot — a file, or a directory holding
// snapshot.json — and scores every pre-token protocol with the radar-2 model in lib/model.ts.
// Then it writes the ranked board and the dashboard's data.js. Then it copies the dashboard
// and the screenshots beside them. Last it asks the vendored make.fun library to write the
// dossier, the summary the judge reads, from exactly the files the run just wrote.
//
// Nothing here reaches the network and nothing calls a model: the whole ranking is arithmetic
// on the snapshot's own figures, and two runs over the same snapshot write the same bytes.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../kit/input/snapshot.json

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { boardDiagnostics, boardIssue, buildRadar, dataScript, diagnosticsText, parseSnapshot } from './lib/model.ts';
import { buildDossier as makeDossier } from './vendor/makefun-board.ts';

const repoRoot = url.fileURLToPath(new URL('.', import.meta.url));

/** The gate's own caps, as the scorer states them: the text cap shapes the dossier, the rest refuse. */
const GATE = {
  textMaxBytes: 65_536,
  screenshots: { max: 4, maxBytes: 524_288 },
  dashboard: { maxFiles: 400, maxBytes: 4_194_304 },
};
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Stop the run with a message on stderr and an exit code the shell can read. */
function fail(message: string, code = 1): never {
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(code);
}

/** One --name <value> (or --name=<value>) out of argv, or the fallback when it is absent. */
function flag(argv: readonly string[], name: string, fallback: string): string {
  const bare = `--${name}`;
  const at = argv.indexOf(bare);
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1] as string;
  const joined = argv.find((a) => a.startsWith(`${bare}=`));
  return joined === undefined ? fallback : joined.slice(bare.length + 1);
}

/** Copy a directory's regular files into `to`, skipping dotfiles, and report the names copied. */
function copyFlat(from: string, to: string): string[] {
  if (!fs.existsSync(from)) return [];
  fs.mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of fs.readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = path.join(from, name);
    if (!fs.statSync(source).isFile()) continue;
    fs.copyFileSync(source, path.join(to, name));
    copied.push(name);
  }
  return copied;
}

/** The whole run, top to bottom: score, write, copy, dossier, then say what happened. */
function run(): void {
  const inputArg = flag(process.argv, 'input', '/input');
  const snapshotPath = inputArg.endsWith('.json') ? inputArg : path.join(inputArg, 'snapshot.json');
  if (!fs.existsSync(snapshotPath)) {
    fail(`no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`, 2);
  }
  const outDir = flag(process.argv, 'output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshot = parseSnapshot(fs.readFileSync(snapshotPath, 'utf8'));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
  fs.writeFileSync(path.join(outDir, 'data.js'), dataScript(radar));

  copyFlat(path.join(repoRoot, 'dashboard'), path.join(outDir, 'dashboard'));
  const shots = copyFlat(path.join(repoRoot, 'screenshots'), path.join(outDir, 'screenshots'));
  if (shots.length < 3) {
    fail(`screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`);
  }
  for (const name of shots) {
    if (!SHOT_NAME.test(name)) {
      fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
    }
  }

  // The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
  fs.writeFileSync(
    path.join(outDir, 'dossier.json'),
    makeDossier(outDir, {
      text_max_bytes: GATE.textMaxBytes,
      screenshots: { max: GATE.screenshots.max, max_bytes: GATE.screenshots.maxBytes },
      dashboard: { max_files: GATE.dashboard.maxFiles, max_bytes: GATE.dashboard.maxBytes },
    }),
  );

  const summary = boardDiagnostics(board, snapshot);
  process.stdout.write(
    [
      `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)`,
      `token radar: wrote ${path.join(outDir, 'board.json')}, ${path.join(outDir, 'data.js')}, ${path.join(outDir, 'dashboard')} (3 files), ${path.join(outDir, 'screenshots')} (${shots.length} images) and ${path.join(outDir, 'dossier.json')}`,
    ].join('\n') + '\n' + diagnosticsText(summary),
  );
}

run();
