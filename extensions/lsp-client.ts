import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";

interface LspRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: unknown;
}

interface LspResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export function pathToUri(filePath: string): string {
  if (filePath.startsWith("file://")) return filePath;
  const resolved = path.resolve(filePath);
  if (process.platform === "win32") {
    return "file:///" + resolved.replace(/\\/g, "/");
  }
  return "file://" + resolved;
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    const p = uri.slice("file://".length);
    return process.platform === "win32" && p.startsWith("/")
      ? p.slice(1).replace(/\//g, "\\")
      : p;
  }
  return uri;
}

export interface LspConfig {
  languageId: string;
  command: string;
  args: string[];
}

function which(cmd: string): string | null {
  try {
    const { execSync } = require("node:child_process");
    const result = execSync(
      `which ${cmd} 2>/dev/null || command -v ${cmd} 2>/dev/null`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const found = result.trim().split("\n")[0];
    return found || null;
  } catch {
    return null;
  }
}

function hasFile(cwd: string, name: string): boolean {
  try {
    return fs.existsSync(path.join(cwd, name));
  } catch {
    return false;
  }
}

function cwdHasExt(cwd: string, ext: string): boolean {
  try {
    return fs.readdirSync(cwd).some((f) => f.endsWith(ext));
  } catch {
    return false;
  }
}

export function detectLsp(cwd: string): LspConfig | null {
  // TypeScript / JavaScript
  if (hasFile(cwd, "package.json")) {
    if (hasFile(cwd, "deno.json") || hasFile(cwd, "deno.jsonc")) {
      const cmd = which("deno");
      if (cmd) return { languageId: "typescript", command: cmd, args: ["lsp"] };
    }
    const cmd = which("typescript-language-server");
    if (cmd) return { languageId: "typescript", command: cmd, args: ["--stdio"] };
  }
  // Rust
  if (hasFile(cwd, "Cargo.toml")) {
    const cmd = which("rust-analyzer");
    if (cmd) return { languageId: "rust", command: cmd, args: [] };
  }
  // Go
  if (hasFile(cwd, "go.mod")) {
    const cmd = which("gopls");
    if (cmd) return { languageId: "go", command: cmd, args: [] };
  }
  // Python
  if (
    hasFile(cwd, "pyproject.toml") ||
    hasFile(cwd, "setup.py") ||
    hasFile(cwd, "requirements.txt") ||
    cwdHasExt(cwd, ".py")
  ) {
    const pylsp = which("pylsp");
    if (pylsp) return { languageId: "python", command: pylsp, args: [] };
    const pyright = which("pyright-langserver");
    if (pyright) return { languageId: "python", command: pyright, args: ["--stdio"] };
  }
  // Zig
  if (hasFile(cwd, "build.zig")) {
    const cmd = which("zls");
    if (cmd) return { languageId: "zig", command: cmd, args: [] };
  }
  // C / C++
  if (cwdHasExt(cwd, ".c") || cwdHasExt(cwd, ".cpp") || cwdHasExt(cwd, ".h")) {
    const cmd = which("clangd");
    if (cmd) return { languageId: "cpp", command: cmd, args: [] };
  }
  // Lua
  if (cwdHasExt(cwd, ".lua")) {
    const cmd = which("lua-language-server");
    if (cmd) return { languageId: "lua", command: cmd, args: [] };
  }
  return null;
}

export class LspClient {
  private proc!: ChildProcess;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private nextId = 1;
  public ready = false;
  public languageId: string;
  public openFiles = new Set<string>();

  constructor(
    public readonly config: LspConfig,
    public readonly cwd: string,
  ) {
    this.languageId = config.languageId;
  }

  /** Spawn the process and initialize. Rejects if command missing or init fails. */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.config.command, this.config.args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "inherit"],
      });
      this.proc = proc;

      // Catch spawn failures (ENOENT, permission denied, etc.)
      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn ${this.config.command}: ${err.message}`));
      });

      // Wait until we actually get stdout before resolving the connect promise
      const onFirstData = (chunk: Buffer) => {
        this.buffer += chunk.toString("utf-8");
        this.processBuffer();
      };
      proc.stdout?.once("data", onFirstData);
      proc.stdout?.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf-8");
        this.processBuffer();
      });

      proc.on("exit", (code) => {
        this.ready = false;
        for (const [, { reject }] of this.pending) {
          reject(new Error(`LSP process exited with code ${code}`));
        }
        this.pending.clear();
      });

      // After a small tick, if no error occurred, resolve connect
      setImmediate(() => {
        if (proc.killed) return; // error handler already rejected
        resolve();
      });
    });
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToUri(this.cwd),
      workspaceFolders: [
        { uri: pathToUri(this.cwd), name: path.basename(this.cwd) },
      ],
      capabilities: {
        textDocument: {
          hover: { dynamicRegistration: false },
          definition: { dynamicRegistration: false, linkSupport: true },
          typeDefinition: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false },
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
          },
          completion: {
            dynamicRegistration: false,
            completionItem: { snippetSupport: false },
          },
          rename: { dynamicRegistration: false },
          formatting: { dynamicRegistration: false },
          rangeFormatting: { dynamicRegistration: false },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
    });
    this.ready = true;
    this.notify("initialized", {});
    return result;
  }

  private processBuffer() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;

      const body = this.buffer.slice(bodyStart, bodyStart + length);
      this.buffer = this.buffer.slice(bodyStart + length);

      try {
        const msg = JSON.parse(body) as LspResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(msg.error.message));
          } else {
            p.resolve(msg.result);
          }
        }
      } catch {
        // ignore malformed
      }
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const msg: LspRequest = { jsonrpc: "2.0", id, method, params };
      const payload = JSON.stringify(msg);
      const data = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin?.write(data);
    });
  }

  notify(method: string, params?: unknown) {
    const msg = { jsonrpc: "2.0", method, params };
    const payload = JSON.stringify(msg);
    const data = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
    this.proc.stdin?.write(data);
  }

  async shutdown() {
    if (!this.ready) return;
    try {
      await this.request("shutdown", undefined);
      this.notify("exit", {});
    } catch {
      // ignore
    }
  }

  kill() {
    this.proc?.kill("SIGTERM");
  }

  didOpen(filePath: string, version: number, text: string) {
    if (!this.ready) return;
    const uri = pathToUri(filePath);
    this.openFiles.add(filePath);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.languageId,
        version,
        text,
      },
    });
  }

  didChange(filePath: string, version: number, text: string) {
    if (!this.ready || !this.openFiles.has(filePath)) return;
    this.notify("textDocument/didChange", {
      textDocument: { uri: pathToUri(filePath), version },
      contentChanges: [{ text }],
    });
  }

  didClose(filePath: string) {
    if (!this.ready || !this.openFiles.has(filePath)) return;
    this.openFiles.delete(filePath);
    this.notify("textDocument/didClose", {
      textDocument: { uri: pathToUri(filePath) },
    });
  }

  formatHover(result: unknown): string {
    const r = result as any;
    const contents = r?.contents;
    if (!contents) return "No hover info";
    if (typeof contents === "string") return contents;
    if (contents?.value) return contents.value;
    if (contents?.kind === "markdown") return contents.value;
    if (Array.isArray(contents)) {
      return contents
        .map((c: any) => {
          if (typeof c === "string") return c;
          if (c?.kind === "markdown") return c.value;
          return c?.value || "";
        })
        .join("\n\n");
    }
    return JSON.stringify(contents, null, 2);
  }

  formatLocations(result: unknown): string {
    const locations = Array.isArray(result)
      ? result
      : result
        ? [result]
        : [];
    if (locations.length === 0) return "No locations found";
    return locations
      .map((loc: any) => {
        const uri = loc.targetUri || loc.uri;
        const range = loc.targetRange || loc.range;
        const fp = uriToPath(uri);
        const line = (range?.start?.line ?? 0) + 1;
        const col = (range?.start?.character ?? 0) + 1;
        return `${fp}:${line}:${col}`;
      })
      .join("\n");
  }

  formatSymbols(result: unknown): string {
    const items = Array.isArray(result) ? result : [];
    if (items.length === 0) return "No symbols found";
    return items
      .map((sym: any) => {
        const kind = symKindToString(sym.kind);
        const loc = sym.location || { uri: sym.uri, range: sym.range };
        const fp = uriToPath(loc?.uri || "");
        const line = (loc?.range?.start?.line ?? 0) + 1;
        const container = sym.containerName
          ? ` [in ${sym.containerName}]`
          : "";
        return `${sym.name} (${kind})${container} — ${fp}:${line}`;
      })
      .join("\n");
  }
}

function symKindToString(kind: number): string {
  const kinds = [
    "File",
    "Module",
    "Namespace",
    "Package",
    "Class",
    "Method",
    "Property",
    "Field",
    "Constructor",
    "Enum",
    "Interface",
    "Function",
    "Variable",
    "Constant",
    "String",
    "Number",
    "Boolean",
    "Array",
    "Object",
    "Key",
    "Null",
    "EnumMember",
    "Struct",
    "Event",
    "Operator",
    "TypeParameter",
  ];
  return kinds[kind - 1] || "Unknown";
}
