import assert from "node:assert/strict";
import test from "node:test";

import {
  argumentsText,
  chatJsonToResponses,
  chatStreamToResponses,
  extractToolCallsFromText,
  inputToMessages,
  responsesBodyToChat,
  sanitizeToolCall,
  sanitizeToolCallArguments,
} from "./proxy/responses.js";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = "";
  for await (const chunk of chatStreamToResponses(stream, "groq/llama", "resp_test")) {
    out += chunk;
  }
  return out;
}

test("Responses input with tools and function outputs becomes chat messages", () => {
  const chat = responsesBodyToChat({
    model: "nvidia_nim/nvidia/nemotron-3-super-120b-a12b",
    instructions: "You are a coder.",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "call_1", output: "a.ts" },
    ],
    tools: [{ type: "function", name: "bash", description: "run", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "bash" },
    reasoning: { effort: "high" },
    max_output_tokens: 64,
  });
  assert.equal(chat.model, "nvidia_nim/nvidia/nemotron-3-super-120b-a12b");
  assert.equal((chat.messages as Array<{ role: string }>)[0].role, "system");
  assert.equal((chat.messages as Array<{ content: string }>)[1].content, "list files");
  assert.equal((chat.messages as Array<{ role: string }>)[2].role, "assistant");
  assert.equal((chat.messages as Array<{ role: string }>)[3].role, "tool");
  const tools = chat.tools as Array<{ function: { name: string } }>;
  assert.equal(tools[0].function.name, "bash");
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "bash" } });
  assert.equal(chat.reasoning_effort, "high");
  assert.equal(chat.max_tokens, 64);
});

test("Responses tools with input_schema become chat function parameters", () => {
  const chat = responsesBodyToChat({
    model: "groq/llama",
    input: "list files",
    tools: [
      {
        type: "function",
        name: "bash",
        description: "run",
        input_schema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ],
  });
  const tools = chat.tools as Array<{
    function: { name: string; parameters: { required: string[] } };
  }>;
  assert.equal(tools[0].function.name, "bash");
  assert.deepEqual(tools[0].function.parameters.required, ["command"]);
});

test("empty bash/read tool schemas get OpenCode required arguments", () => {
  const chat = responsesBodyToChat({
    model: "sglang/deepseek-v4-flash",
    input: "review this repo",
    tools: [
      { type: "function", name: "bash", description: "run", parameters: { type: "object" } },
      {
        type: "function",
        name: "read",
        description: "read",
        parameters: { $schema: "https://json-schema.org/draft/07/schema", type: "object" },
      },
    ],
  });
  const tools = chat.tools as Array<{
    function: {
      name: string;
      parameters: { required?: string[]; properties?: Record<string, unknown> };
    };
  }>;
  const bash = tools.find((row) => row.function.name === "bash");
  const read = tools.find((row) => row.function.name === "read");
  assert.deepEqual(bash?.function.parameters.required, ["command"]);
  assert.ok(bash?.function.parameters.properties?.command);
  assert.deepEqual(read?.function.parameters.required, ["filePath"]);
  assert.equal("$schema" in (read?.function.parameters ?? {}), false);
});

test("empty glob/read/bash tool arguments are filled or rewritten", () => {
  assert.equal(sanitizeToolCallArguments("glob", ""), '{"pattern":"*"}');
  assert.equal(sanitizeToolCallArguments("glob", '{"pattern":""}'), '{"pattern":"*"}');
  assert.deepEqual(JSON.parse(sanitizeToolCallArguments("read", "{}") ?? "{}"), { pattern: "*" });
  assert.equal(sanitizeToolCallArguments("bash", "{}"), '{"command":"ls -la"}');
  assert.equal(sanitizeToolCallArguments("bash", '{"command":"ls"}'), '{"command":"ls"}');
  const body = chatJsonToResponses(
    {
      id: "chatcmpl_empty",
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_g",
                type: "function",
                function: { name: "glob", arguments: "{}" },
              },
              {
                id: "call_b",
                type: "function",
                function: { name: "bash", arguments: "{}" },
              },
            ],
          },
        },
      ],
    },
    "sglang/deepseek-v4-flash"
  );
  const output = body.output as Array<{ type: string; name?: string; arguments?: string }>;
  const glob = output.find((row) => row.name === "glob");
  assert.equal(glob?.arguments, '{"pattern":"*"}');
  const bash = output.find((row) => row.name === "bash");
  assert.equal(bash?.arguments, '{"command":"ls -la"}');
});

test("string Responses input is a user message", () => {
  const messages = inputToMessages("hello");
  assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
});

test("chat JSON with tool calls becomes Responses function_call items", () => {
  const body = chatJsonToResponses(
    {
      id: "chatcmpl_1",
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_9",
                type: "function",
                function: { name: "read", arguments: '{"path":"a.ts"}' },
              },
            ],
          },
        },
      ],
    },
    "groq/llama"
  );
  const output = body.output as Array<{ type: string; name?: string; call_id?: string }>;
  assert.equal(output[0].type, "function_call");
  assert.equal(output[0].name, "read");
  assert.equal(output[0].call_id, "call_9");
});

test("chat SSE text deltas become Responses output_text events", async () => {
  const sse = await collect(
    streamOf('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n')
  );
  assert.match(sse, /event: response\.created/);
  assert.match(sse, /event: response\.output_item\.added/);
  assert.match(sse, /response\.output_text\.delta/);
  assert.match(sse, /"delta":"Hi"/);
  assert.match(sse, /event: response\.completed/);
});

test("chat SSE tool_calls become Responses function_call argument deltas", async () => {
  const sse = await collect(
    streamOf(
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read","arguments":""}}]}}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"a\\"}"}}]}}]}',
        "data: [DONE]",
        "",
      ].join("\n")
    )
  );
  assert.match(sse, /"type":"function_call"/);
  assert.match(sse, /response\.function_call_arguments\.delta/);
  assert.match(sse, /"name":"read"/);
  assert.match(sse, /response\.function_call_arguments\.done/);
  const added = [...sse.matchAll(/event: response\.output_item\.added\ndata: (\{.*\})/g)].map(
    (row) => JSON.parse(row[1]) as { item?: { type?: string; arguments?: string } }
  );
  const functionAdded = added.find((row) => row.item?.type === "function_call");
  assert.equal(functionAdded?.item?.arguments, "");
  assert.equal([...sse.matchAll(/event: response\.function_call_arguments\.delta/g)].length, 1);
});

test("consecutive function_call items merge onto one assistant Chat message", () => {
  const messages = inputToMessages([
    { type: "message", role: "user", content: [{ type: "input_text", text: "list then read" }] },
    { type: "function_call", call_id: "c1", name: "glob", arguments: '{"pattern":"*"}' },
    { type: "function_call", call_id: "c2", name: "read", arguments: { filePath: "a.ts" } },
    { type: "function_call_output", call_id: "c1", output: "a.ts" },
    { type: "function_call_output", call_id: "c2", output: "export {}" },
  ]);
  const assistant = messages.filter((row) => row.role === "assistant");
  assert.equal(assistant.length, 1);
  const calls = assistant[0].tool_calls as Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].id, "c1");
  assert.equal(calls[1].function.name, "read");
  assert.equal(calls[1].function.arguments, '{"filePath":"a.ts"}');
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[3].role, "tool");
});

test("object Chat tool arguments are not dropped", () => {
  assert.equal(argumentsText({ filePath: "README.md" }), '{"filePath":"README.md"}');
  const body = chatJsonToResponses(
    {
      id: "chatcmpl_obj",
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_r",
                type: "function",
                function: { name: "read", arguments: { filePath: "src/index.ts" } },
              },
            ],
          },
        },
      ],
    },
    "groq/llama"
  );
  const output = body.output as Array<{ type: string; name?: string; arguments?: string }>;
  const read = output.find((row) => row.name === "read");
  assert.equal(read?.arguments, '{"filePath":"src/index.ts"}');
});

test("XML invoke dumps in assistant text become function_call items", () => {
  const extracted = extractToolCallsFromText(
    `I'll list the directory.\n<invoke name="read"><parameter name="filePath">/tmp/project</parameter></invoke>`
  );
  assert.equal(extracted.calls[0]?.name, "read");
  assert.equal(extracted.calls[0]?.arguments, '{"filePath":"/tmp/project"}');
  assert.match(extracted.text, /I'll list the directory/);
  const body = chatJsonToResponses(
    {
      id: "chatcmpl_xml",
      choices: [
        {
          message: {
            content: '<tool_call>{"name":"bash","arguments":{"command":"ls -la"}}</tool_call>',
          },
        },
      ],
    },
    "sglang/qwen"
  );
  const output = body.output as Array<{ type: string; name?: string; arguments?: string }>;
  const bash = output.find((row) => row.name === "bash");
  assert.equal(bash?.type, "function_call");
  assert.equal(bash?.arguments, '{"command":"ls -la"}');
});

test("namespace Responses tools flatten into Chat function tools", () => {
  const chat = responsesBodyToChat({
    model: "groq/llama",
    input: "hi",
    tools: [
      {
        type: "namespace",
        name: "mcp",
        tools: [
          {
            type: "function",
            name: "search",
            description: "search",
            parameters: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
      },
    ],
  });
  const tools = chat.tools as Array<{ function: { name: string } }>;
  assert.equal(tools[0].function.name, "mcp__search");
});

test("empty read is rewritten to glob so OpenCode does not abort a directory Read", () => {
  const rewritten = sanitizeToolCall("read", "{}");
  assert.equal(rewritten?.name, "glob");
  assert.equal(rewritten?.arguments, '{"pattern":"*"}');
});
