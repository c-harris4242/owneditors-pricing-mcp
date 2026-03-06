import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";

const PORT = Number(process.env.PORT || 3000);
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

  server.registerTool(
    "get_quote",
    {
      title: "Get live OwnEditors quote",
      description:
        "Get a live quote from OwnEditors pricing using service, academic level, deadline, and page count.",
      inputSchema: z.object({
        service: z.string().min(1).describe("Service key, e.g. editing_basic"),
        level: z
          .string()
          .min(1)
          .describe("Academic level key, e.g. undergrad"),
        deadline: z
          .string()
          .min(1)
          .describe("Deadline key, e.g. 48h, 24h, 5d"),
        pages: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Number of pages. Defaults to 1 if omitted."),
      }),
      outputSchema: z.object({
        ok: z.boolean(),
        currency: z.string(),
        service: z.string(),
        level: z.string(),
        deadline: z.string(),
        unit_price: z.number(),
        pages: z.number(),
        total_price: z.number(),
      }),
    },
    async ({ service, level, deadline, pages = 1 }) => {
      const url = new URL(PRICING_API);
      url.searchParams.set("service", service);
      url.searchParams.set("level", level);
      url.searchParams.set("deadline", deadline);

      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
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
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "owneditors-pricing-mcp",
    message: "MCP wrapper is running.",
    mcp_endpoint: "/mcp",
    pricing_api: PRICING_API,
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Internal MCP server error",
      },
      id: req.body?.id ?? null,
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`owneditors-pricing-mcp listening on port ${PORT}`);
  console.log(`Using pricing API: ${PRICING_API}`);
});
