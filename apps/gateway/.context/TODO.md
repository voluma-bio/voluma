# Gateway TODO

## Before enabling Anthropic or OpenAI (`enabled: true` in `providers.ts`)

All four, because a sandbox controls the body and the headers it sends:

1. **Price from the reply's model.** `message_start.message.model` (Anthropic) and
   `response.model` (Responses) name what was billed; record that model's price when it differs
   from the request's.
2. **Server tools and input cost.** Refuse requests whose `tools[].type` is a server tool (web
   search, code execution, hosted OpenAI tools), or price `server_tool_use`; they are billed
   outside tokens. Add the input cost (up to a full context window at the input price) to the
   reservation, which now holds output tokens only.
3. **Forward an allowlist of headers.** Today everything but auth and hop-by-hop headers goes
   through, including `openai-organization`, `openai-project`, `anthropic-beta`,
   `x-http-method-override` and headers named in `Connection:`.
4. **A reservation key per provider.** `max_tokens` and `max_output_tokens` share one slot and
   the last wins, so a sandbox can shrink the reservation by adding the key a provider ignores.
   Store the key next to the routes in `providers.ts`.

## Other

- Confirm Meta's real reply shape on staging (streamed or one JSON body); both are read.
