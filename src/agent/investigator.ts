import Anthropic from "@anthropic-ai/sdk";
import { Agent, type Connection } from "agents";
import { recordIncident } from "../storage/incidents";
import { buildSystemPrompt } from "./prompt";
import { executeTool, TOOL_SCHEMAS } from "./tools";

const MODEL = "claude-sonnet-5";
const MAX_TOKENS = 2048;
const MAX_TOOL_CALLS = 8;

interface InvestigatorState {
  messages: Anthropic.MessageParam[];
}

type ClientMessage =
  | { type: "info"; message: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "answer"; text: string }
  | { type: "error"; message: string };

// Best-effort: a dead connection (client closed mid-investigation) must
// never abort the loop or leave persisted state with an unresolved
// tool_use block missing its matching tool_result.
function send(connection: Connection, message: ClientMessage): void {
  try {
    connection.send(JSON.stringify(message));
  } catch {
    // ignore — nothing to deliver to
  }
}

export class Investigator extends Agent<Env, InvestigatorState> {
  initialState: InvestigatorState = { messages: [] };

  onConnect(connection: Connection): void {
    send(connection, { type: "info", message: "connected" });
  }

  async onMessage(connection: Connection, message: string): Promise<void> {
    const client = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    const messages: Anthropic.MessageParam[] = [
      ...this.state.messages,
      { role: "user", content: message },
    ];

    const seenCalls = new Set<string>();
    let toolCallCount = 0;
    let stopReason: "cap" | "duplicate" | null = null;

    try {
      while (true) {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: buildSystemPrompt(),
          messages,
          tools: stopReason ? undefined : TOOL_SCHEMAS,
        });

        messages.push({ role: "assistant", content: response.content });

        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );

        if (toolUseBlocks.length === 0) {
          const answer = response.content
            .filter((block): block is Anthropic.TextBlock => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          this.setState({ messages });
          await recordIncident(this.env.oncall_investigator_db, {
            timestamp: Date.now(),
            symptom: message,
            summary: answer,
          });
          send(connection, { type: "answer", text: answer });
          return;
        }

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of toolUseBlocks) {
          const signature = `${block.name}:${JSON.stringify(block.input)}`;

          if (seenCalls.has(signature)) {
            stopReason = "duplicate";
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content:
                "Duplicate call detected — same tool and arguments already used this investigation. Wrap up now with what you have.",
              is_error: true,
            });
            continue;
          }
          seenCalls.add(signature);
          toolCallCount++;

          if (toolCallCount > MAX_TOOL_CALLS) {
            stopReason = "cap";
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "Step limit reached — wrap up now with what you have.",
              is_error: true,
            });
            continue;
          }

          send(connection, { type: "tool_call", name: block.name, input: block.input });
          const result = await executeTool(block.name, block.input, this.env);
          send(connection, { type: "tool_result", name: block.name, result });
          const isToolError = typeof result === "object" && result !== null && "error" in result;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
            is_error: isToolError,
          });
        }

        messages.push({ role: "user", content: toolResults });
      }
    } catch (err) {
      this.setState({ messages });
      send(connection, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
