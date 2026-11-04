import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { ChatRequestError, readChatRequest } from '@/features/World/ai/chatRequest';
import { getToolDefinitions } from '@/features/World/ai/componentRegistry';

// ---------------------------------------------------------------------------
// Anthropic client — reads ANTHROPIC_API_KEY from env at request time
// ---------------------------------------------------------------------------

const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

// ---------------------------------------------------------------------------
// Tool definitions from the component registry
// ---------------------------------------------------------------------------

const tools: Anthropic.Messages.Tool[] = getToolDefinitions().map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema as Anthropic.Messages.Tool['input_schema'],
}));

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  let body: Awaited<ReturnType<typeof readChatRequest>>;
  try {
    body = await readChatRequest(request);
  } catch (error) {
    return NextResponse.json({ error: 'Invalid chat request' }, {
      status: error instanceof ChatRequestError ? error.status : 400, headers: privateHeaders,
    });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'AI service unavailable' }, { status: 503, headers: privateHeaders });
  const { messages, context } = body;

  // Build system prompt with live context
  const systemPrompt = `You are the AI agent controlling a 3D visualization of Web3 activity.
You can see ${context.stats.totalEvents} events across ${context.hubCount} protocol hubs.
Total volume: $${context.stats.totalVolume.toLocaleString()}.
Active connections: ${context.stats.connections}.

You can use tools to modify the scene:
- sceneColorUpdate: Change background, protocol, and user node colors (hex strings)
- cameraFocus: Focus camera on a specific hub by index (0-based) or position
- dataFilter: Filter visible data by protocols, volume, or time range
- agentSummary: Display a summary card (Phase 2)
- tradeVisualization: Highlight specific trades (Phase 2)

Be concise. When the user asks to change visual elements, use the appropriate tool.
When answering questions about the data, reference the stats you have.
Always respond with a brief text message in addition to any tool calls.`;

  try {
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      tools,
    });

    // Parse tool use from response
    const actions: Array<{ type: string; params: unknown }> = [];
    let textMessage = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        textMessage += block.text;
      } else if (block.type === 'tool_use') {
        actions.push({
          type: block.name,
          params: block.input,
        });
      }
    }

    // If the AI only used tools and didn't produce text, add a default message
    if (!textMessage && actions.length > 0) {
      const actionNames = actions.map((a) => a.type).join(', ');
      textMessage = `Applied: ${actionNames}`;
    }

    return NextResponse.json({ message: textMessage, actions }, { headers: privateHeaders });
  } catch {
    // SDK exceptions may contain upstream details. Never return or log their text.
    return NextResponse.json({ error: 'AI service unavailable' }, { status: 500, headers: privateHeaders });
  }
}
