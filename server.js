import express from "express";
import cors from "cors";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const PRICING_API =
  process.env.PRICING_API ||
  "https://owneditors-ai-coach-kss3.vercel.app/api/pricing";

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function createServer() {
  const server = new McpServer({
    name: "owneditors-pricing-mcp",
    version: "1.0.0",
  });

  server.tool(
    "get_quote",
    "Get a live OwnEditors quote using service, level, deadline, and page count.",
    {
      service: z.string().min(1).describe("Service key, e.g. editing_basic"),
      level: z.string().min(1).describe("Academic level key, e.g. undergrad"),
      deadline: z.string().min(1).describe("Deadline key, e.g. 48h or 5d"),
      pages: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of pages. Defaults to 1 if omitted."),
    },
    async ({ service, level, deadline, pages = 1 }) => {
      const url = new URL(PRICING_API);
      url.searchParams.set("service", service);
      url.searchParams.set("level", level);
      url.searchParams.set("deadline", deadline);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.ok) {
        const message =
          data?.error ||
          `Pricing lookup failed with HTTP ${res.status}. Check service, level, and deadline.`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: message,
                  received: { service, level, deadline, pages },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      const unitPrice = roundMoney(data.price);
      const totalPrice = roundMoney(unitPrice * pages);

      const output = {
        ok: true,
        currency: data.currency || "USD",
        service: data.service || service,
        level: data.level || level,
        deadline: data.deadline || deadline,
        unit_price: unitPrice,
        pages,
        total_price: totalPrice,
      };

      return {
        content: [
          {
            type: "text",
            text: `Quote: ${output.currency} ${output.unit_price.toFixed(
              2
            )} per page × ${output.pages} page(s) = ${output.currency} ${output.total_price.toFixed(2)}`,
          },
        ],
        structuredContent: output,
      };
    }
  );

  return server;
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

async function handleMcp(req, res) {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
}

// Expose MCP on BOTH root and /mcp
app.all("/", handleMcp);
app.all("/mcp", handleMcp);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP server listening on http://0.0.0.0:${PORT}`);
  console.log(`Using pricing API: ${PRICING_API}`);
});
