/** Local HTTP replay peer for responsiveness-probe.ts, isolated from the runner's timers/RSS. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

const directory = process.argv[2];
assert(directory);
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  res.setHeader("content-type", "application/json");
  if (req.url.endsWith("/heartbeat")) {
    res.end('{"stop":false}');
  } else if (req.url.endsWith("/messages") && req.method === "GET") {
    res.end(await readFile(join(directory, "rows.json")));
  } else if (req.url.endsWith("/messages")) {
    await writeFile(join(directory, "written.json"), body);
    res.writeHead(204).end();
  } else if (req.url.endsWith("/responses")) {
    res.setHeader("content-type", "text/event-stream");
    const { bytes, chunkBytes, textOnly } = JSON.parse(
      await readFile(join(directory, "provider.json"), "utf8"),
    );
    const event = async (type, payload) => {
      if (!res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`))
        await once(res, "drain");
    };
    await event("response.created", {
      response: { id: "resp_probe", status: "in_progress", output: [] },
    });
    if (textOnly) {
      const item = { type: "message", id: "msg_probe", role: "assistant", content: [] };
      await event("response.output_item.added", { output_index: 0, item });
      await event("response.content_part.added", {
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      await event("response.output_text.delta", {
        output_index: 0,
        content_index: 0,
        delta: "x".repeat(bytes),
      });
      await event("response.output_item.done", {
        output_index: 0,
        item: {
          ...item,
          content: [{ type: "output_text", text: "x".repeat(bytes), annotations: [] }],
        },
      });
    } else {
      const item = {
        type: "function_call",
        id: "fc_probe",
        call_id: "call_probe",
        name: "bash",
        arguments: "",
      };
      await event("response.output_item.added", { output_index: 0, item });
      const args = JSON.stringify({ command: "x".repeat(bytes) });
      for (let i = 0; i < args.length; i += chunkBytes)
        await event("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: 0,
          delta: args.slice(i, i + chunkBytes),
        });
      await event("response.output_item.done", {
        output_index: 0,
        item: { ...item, arguments: args },
      });
    }
    await event("response.completed", {
      response: {
        id: "resp_probe",
        status: "completed",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    res.end();
  } else {
    res.writeHead(204).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
process.send(server.address().port);
process.on("disconnect", () => {
  server.closeAllConnections();
  server.close();
});
