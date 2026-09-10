import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  extractBehaviorCloningSamples,
  splitForGame,
  type BehaviorCloningSample,
  type DatasetSplit,
  type TraceEventChunk,
} from "../packages/trace-export/src/index.js";

interface CliOptions {
  inputs: string[];
  output: string;
  includeNoops: boolean;
}

function usage(): never {
  console.error(
    "Usage: bun run export:bc -- [--input <file-or-directory>]... [--output <directory>] [--include-noops]",
  );
  process.exit(2);
}

function parseArgs(args: string[]): CliOptions {
  const inputs: string[] = [];
  let output = resolve("bc-dataset");
  let includeNoops = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--input") {
      const value = args[++index];
      if (!value) usage();
      inputs.push(resolve(value));
    } else if (argument === "--output") {
      const value = args[++index];
      if (!value) usage();
      output = resolve(value);
    } else if (argument === "--include-noops") {
      includeNoops = true;
    } else {
      usage();
    }
  }
  if (inputs.length === 0) {
    const recordings = resolve(homedir(), ".tui-gamepigeon", "recordings");
    inputs.push(resolve(recordings, "completed", "chunks"));
    inputs.push(resolve(recordings, "overlay-completed"));
    inputs.push(resolve(recordings, "overlay-pending"));
  }
  return { inputs, output, includeNoops };
}

function jsonFiles(input: string): string[] {
  let stats;
  try {
    stats = statSync(input);
  } catch {
    return [];
  }
  if (stats.isFile()) return input.endsWith(".json") ? [input] : [];
  if (!stats.isDirectory()) return [];
  return readdirSync(input, { withFileTypes: true })
    .flatMap((entry) => jsonFiles(resolve(input, entry.name)))
    .sort();
}

function loadChunks(inputs: readonly string[]): TraceEventChunk[] {
  return inputs.flatMap(jsonFiles).flatMap((path) => {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as TraceEventChunk;
      return value.schema_version === 2 && Array.isArray(value.events) ? [value] : [];
    } catch (error) {
      throw new Error(`Could not parse ${path}: ${String(error)}`);
    }
  });
}

function writeDataset(
  output: string,
  samples: readonly BehaviorCloningSample[],
  includeNoops: boolean,
): void {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  chmodSync(output, 0o700);
  const splits: Record<DatasetSplit, BehaviorCloningSample[]> = {
    train: [],
    validation: [],
    test: [],
  };
  for (const sample of samples) splits[splitForGame(sample.game_id)].push(sample);
  for (const [name, rows] of Object.entries(splits)) {
    const body = rows.map((row) => JSON.stringify(row)).join("\n");
    writeFileSync(resolve(output, `${name}.jsonl`), body ? `${body}\n` : "", { mode: 0o600 });
  }
  const manifest = {
    schema_version: 1,
    format: "behavior_cloning_jsonl",
    split_unit: "game_id",
    noops_included: includeNoops,
    samples: {
      total: samples.length,
      train: splits.train.length,
      validation: splits.validation.length,
      test: splits.test.length,
    },
    games: [...new Set(samples.map((sample) => sample.game_type))].sort(),
  };
  writeFileSync(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

const options = parseArgs(process.argv.slice(2));
const chunks = loadChunks(options.inputs);
const samples = extractBehaviorCloningSamples(chunks, { includeNoops: options.includeNoops });
writeDataset(options.output, samples, options.includeNoops);
console.log(`Exported ${samples.length} BC samples from ${chunks.length} chunks to ${options.output}`);
