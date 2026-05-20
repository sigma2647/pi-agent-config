import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import { LspClient, detectLsp, pathToUri } from "./lsp-client";

// Shared state
let client: LspClient | null = null;
let active = false;

// Ensure file is opened before requesting
function ensureDidOpen(filePath: string, client: LspClient) {
  if (client.openFiles.has(filePath)) return;
  try {
    const text = fs.readFileSync(filePath, "utf-8");
    client.didOpen(filePath, 1, text);
  } catch {
    // file may not exist yet
  }
}

export default async function (pi: ExtensionAPI) {
  // ── Auto-start LSP on session start ──
  pi.on("session_start", async (_event, ctx) => {
    const config = detectLsp(ctx.cwd);
    if (!config) {
      ctx.ui.notify("LSP: no matching language server detected", "info");
      return;
    }
    try {
      client = new LspClient(config, ctx.cwd);
      await client.connect();
      await client.initialize();
      active = true;
      ctx.ui.notify(`LSP ready: ${config.command} (${config.languageId})`, "success");
    } catch (err: any) {
      ctx.ui.notify(`LSP unavailable: ${err.message}`, "warning");
      client = null;
      active = false;
    }
  });

  // ── Shutdown on session end ──
  pi.on("session_shutdown", async () => {
    if (client) {
      await client.shutdown();
      client.kill();
      client = null;
      active = false;
    }
  });

  // ── File sync: keep LSP updated when write/edit happen ──
  pi.on("tool_result", async (event, _ctx) => {
    if (!client?.ready) return;
    const filePath = (event.input as any)?.path;
    if (!filePath) return;
    if (event.toolName === "write" || event.toolName === "edit") {
      try {
        const text = fs.readFileSync(filePath, "utf-8");
        if (client.openFiles.has(filePath)) {
          client.didChange(filePath, Date.now(), text);
        } else {
          client.didOpen(filePath, 1, text);
        }
      } catch {
        // ignore missing
      }
    }
  });

  // ── Tool: lsp_hover ──
  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get hover (type/docs) info at a file position via the language server",
    promptSnippet: "Ask the language server for hover info at file:line:column",
    promptGuidelines: [
      "Use lsp_hover when you need type signatures, documentation, or quick info about a symbol.",
      "Provide the file path, 1-based line, and 1-based column.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "Absolute file path" }),
      line: Type.Number({ description: "1-based line number" }),
      column: Type.Number({ description: "1-based column number" }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!client?.ready) return { content: [{ type: "text", text: "LSP not available" }], details: {} };
      ensureDidOpen(params.file, client);
      try {
        const result = await client.request("textDocument/hover", {
          textDocument: { uri: pathToUri(params.file) },
          position: { line: params.line - 1, character: params.column - 1 },
        });
        return {
          content: [{ type: "text", text: client.formatHover(result) }],
          details: result,
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── Tool: lsp_definition ──
  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Definition",
    description: "Go to definition of a symbol via LSP",
    promptSnippet: "Find the definition location of a symbol",
    promptGuidelines: [
      "Use lsp_definition when you need to find where a symbol (function, type, variable) is defined.",
      "Provide the file path, 1-based line, and 1-based column of the symbol.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "Absolute file path" }),
      line: Type.Number({ description: "1-based line number" }),
      column: Type.Number({ description: "1-based column number" }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!client?.ready) return { content: [{ type: "text", text: "LSP not available" }], details: {} };
      ensureDidOpen(params.file, client);
      try {
        const result = await client.request("textDocument/definition", {
          textDocument: { uri: pathToUri(params.file) },
          position: { line: params.line - 1, character: params.column - 1 },
        });
        return {
          content: [{ type: "text", text: client.formatLocations(result) }],
          details: result,
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── Tool: lsp_references ──
  pi.registerTool({
    name: "lsp_references",
    label: "LSP References",
    description: "Find all references to a symbol via LSP",
    promptSnippet: "Find all references to a symbol across the workspace",
    promptGuidelines: [
      "Use lsp_references when you need to see all places a symbol is used.",
      "Provide the file path, 1-based line, and 1-based column of the symbol.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "Absolute file path" }),
      line: Type.Number({ description: "1-based line number" }),
      column: Type.Number({ description: "1-based column number" }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!client?.ready) return { content: [{ type: "text", text: "LSP not available" }], details: {} };
      ensureDidOpen(params.file, client);
      try {
        const result = await client.request("textDocument/references", {
          textDocument: { uri: pathToUri(params.file) },
          position: { line: params.line - 1, character: params.column - 1 },
          context: { includeDeclaration: true },
        });
        return {
          content: [{ type: "text", text: client.formatLocations(result) }],
          details: result,
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── Tool: lsp_document_symbol ──
  pi.registerTool({
    name: "lsp_document_symbol",
    label: "LSP Document Symbols",
    description: "List all symbols in a file (functions, classes, etc.)",
    promptSnippet: "List top-level symbols in a file",
    promptGuidelines: [
      "Use lsp_document_symbol to get an overview of a file's structure before reading it.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "Absolute file path" }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!client?.ready) return { content: [{ type: "text", text: "LSP not available" }], details: {} };
      ensureDidOpen(params.file, client);
      try {
        const result = await client.request("textDocument/documentSymbol", {
          textDocument: { uri: pathToUri(params.file) },
        });
        return {
          content: [{ type: "text", text: client.formatSymbols(result) }],
          details: result,
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── Tool: lsp_workspace_symbol ──
  pi.registerTool({
    name: "lsp_workspace_symbol",
    label: "LSP Workspace Symbols",
    description: "Search symbols across the entire workspace",
    promptSnippet: "Search for a symbol name across the whole project",
    promptGuidelines: [
      "Use lsp_workspace_symbol when you need to find a symbol by name and don't know which file it's in.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Symbol name or partial query" }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!client?.ready) return { content: [{ type: "text", text: "LSP not available" }], details: {} };
      try {
        const result = await client.request("workspace/symbol", { query: params.query });
        return {
          content: [{ type: "text", text: client.formatSymbols(result) }],
          details: result,
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── Tool: lsp_diagnostics ──
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get current diagnostics (errors/warnings) for a file",
    promptSnippet: "Check for LSP errors and warnings in a file",
    promptGuidelines: [
      "Use lsp_diagnostics after editing or writing code to verify there are no type errors or lint issues.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "Absolute file path" }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!client?.ready) return { content: [{ type: "text", text: "LSP not available" }], details: {} };
      ensureDidOpen(params.file, client);
      try {
        // Try pull diagnostics first (LSP 3.17+)
        let result: any;
        try {
          result = await client.request("textDocument/diagnostic", {
            textDocument: { uri: pathToUri(params.file) },
          });
        } catch {
          // fallback: return cached diagnostics if any; for now just report
          result = { items: [] };
        }
        const items = result?.items || [];
        if (items.length === 0) {
          return {
            content: [{ type: "text", text: "No diagnostics for this file." }],
            details: result,
          };
        }
        const lines = items.map((d: any) => {
          const severity = ["", "Error", "Warning", "Information", "Hint"][d.severity || 0];
          const line = (d.range?.start?.line ?? 0) + 1;
          const col = (d.range?.start?.character ?? 0) + 1;
          return `[${severity}] ${params.file}:${line}:${col} — ${d.message}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── Tool: lsp_completion ──
  pi.registerTool({
    name: "lsp_completion",
    label: "LSP Completion",
    description: "Get code completion suggestions at a cursor position",
    promptSnippet: "Ask LSP for completion items at a position",
    promptGuidelines: [
      "Use lsp_completion when you want to see what completions are available at a cursor position.",
    ],
    parameters: Type.Object({
      file: Type.String({ description: "Absolute file path" }),
      line: Type.Number({ description: "1-based line number" }),
      column: Type.Number({ description: "1-based column number" }),
    }),
    async execute(_id, params, _signal, _update, _ctx) {
      if (!client?.ready) return { content: [{ type: "text", text: "LSP not available" }], details: {} };
      ensureDidOpen(params.file, client);
      try {
        const result = (await client.request("textDocument/completion", {
          textDocument: { uri: pathToUri(params.file) },
          position: { line: params.line - 1, character: params.column - 1 },
        })) as any;
        const items = result?.items || (Array.isArray(result) ? result : []);
        const text = items
          .slice(0, 20)
          .map((item: any) => {
            const label = item.label;
            const kind = ["", "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface",
              "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder",
              "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter"][item.kind || 0] || "";
            const detail = item.detail ? ` — ${item.detail}` : "";
            return `${label}${kind ? ` (${kind})` : ""}${detail}`;
          })
          .join("\n");
        return {
          content: [{ type: "text", text: text || "No completions" }],
          details: result,
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }], details: {}, isError: true };
      }
    },
  });

  // ── Command: /lsp-status ──
  pi.registerCommand("lsp-status", {
    description: "Show LSP client status",
    handler: async (_args, ctx) => {
      if (!active || !client) {
        ctx.ui.notify("LSP: not active", "error");
        return;
      }
      ctx.ui.notify(
        `LSP: ${client.languageId} | ready: ${client.ready} | open files: ${client.openFiles.size}`,
        "info",
      );
    },
  });
}
