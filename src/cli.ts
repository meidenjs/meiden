import { buildApp, startProductionServer, startServer } from "./dev";
import { colors, color } from "./runtime/utils";
import { networkInterfaces } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);

type Command = "dev" | "build" | "start";

interface ParsedArgs {
  command: Command;
  root: string;
  port?: number;
  outDir?: string;
  minify?: boolean;
}

function printHelp() {
  console.log(`meiden

Usage:
  meiden dev [dir] [--port 3000]                Start the development server
  meiden build [dir] [--out-dir dist] [--minify] Build the app into dist
  meiden start [dir] [--port 3000]              Start the production server from dist
`);
}

function parseArgs(args: string[]): ParsedArgs | undefined {
  const [command, ...rest] = args;

  if (command === "dev" || command === "build" || command === "start") {
    let dir: string | undefined;
    let port: number | undefined;
    let outDir: string | undefined;
    let minify = true;

    for (let index = 0; index < rest.length; index += 1) {
      const value = rest[index];

      if (value === "--port" || value === "-p") {
        const portValue = rest[index + 1];
        port = portValue ? Number(portValue) : Number.NaN;
        index += 1;

        continue;
      }

      if (value === "--out-dir" || value === "-o") {
        outDir = rest[index + 1];
        index += 1;

        continue;
      }

      if (value === "--no-minify") {
        minify = false;

        continue;
      }

      if (value === "--minify") {
        minify = true;

        continue;
      }

      if (!dir) {
        dir = value;
      }
    }

    if (port !== undefined && !Number.isInteger(port)) {
      throw new Error("Expected --port to be an integer.");
    }

    return {
      command,
      port,
      outDir,
      minify,
      root: dir ? new URL(dir, `file://${process.cwd()}/`).pathname : process.cwd(),
    };
  }

  return undefined;
}

function getNetworkHost() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return undefined;
}

function printDevReady(port: number) {
  const networkHost = getNetworkHost();

  console.log();
  console.log(`${color("Meiden", colors.cyan)} ${color("ready", colors.green)}`);
  console.log();
  console.log(`  ${color("Local:", colors.dim)}   http://localhost:${port}`);

  if (networkHost) {
    console.log(`  ${color("Network:", colors.dim)} http://${networkHost}:${port}`);
  }

  console.log();
}

async function main() {
  let parsed: ParsedArgs | undefined;

  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  if (!parsed) {
    printHelp();
    process.exitCode = args.length === 0 ? 0 : 1;
    return;
  }

  if (parsed.command === "build") {
    const startedAt = performance.now();
    const result = await buildApp({
      root: parsed.root,
      outDir: parsed.outDir,
      minify: parsed.minify,
    });
    const duration = performance.now() - startedAt;

    console.log();
    console.log(`${color("Meiden", colors.cyan)} ${color("built", colors.green)}`);
    console.log();

    for (const asset of result.assets) {
      const size = (asset.size / 1024).toFixed(2);
      const typeLabel = asset.type.padEnd(7);
      console.log(`  ${color(typeLabel, colors.dim)} ${asset.name.padEnd(40)} ${color(`${size} KB`, colors.green)}`);
    }

    console.log();
    console.log(`  ${color("Output:", colors.dim)}  ${result.outDir}`);
    console.log(`  ${color("Routes:", colors.dim)}  ${result.routes}`);
    console.log(`  ${color("Islands:", colors.dim)} ${result.islands}`);
    console.log(`  ${color("Time:", colors.dim)}    ${duration.toFixed(1)}ms`);
    console.log();
    return;
  }

  if (parsed.command === "start") {
    const projectRoot = resolve(parsed.root);
    const serverPath = join(projectRoot, parsed.outDir ?? "dist", "server.js");

    if (existsSync(serverPath)) {
      console.log(`${color("Meiden", colors.cyan)} ${color("starting standalone server", colors.dim)}`);
      if (parsed.port) {
        process.env.PORT = String(parsed.port);
      }
      await import(pathToFileURL(serverPath).href);
      return;
    }

    const server = startProductionServer({ root: parsed.root, port: parsed.port });
    printDevReady(server.port ?? parsed.port ?? 3000);
    return;
  }

  const app = await startServer({ root: parsed.root, port: parsed.port });
  const server = app.server;
  printDevReady(server?.port ?? parsed.port ?? 3000);
}

await main();
