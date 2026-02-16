/**
 * Channel Manager — bridges messaging channels to Hub conversations.
 *
 * Design:
 * - Incoming channel messages are keyed by routeKey
 *   (channelId + accountId + externalConversationId).
 * - Each routeKey is bound to one Hub conversationId.
 * - Outgoing assistant events are delivered back through the bound route.
 *
 * This keeps channel routes isolated across conversations and avoids
 * the old "first active agent" coupling.
 *
 * @see docs/channels/README.md — Channel system overview
 * @see docs/channels/media-handling.md — Media processing pipeline
 */

import type { Hub } from "../hub/hub.js";
import type {
  ChannelPlugin,
  ChannelMessage,
  ChannelAccountState,
  DeliveryContext,
} from "./types.js";
import { listChannels } from "./registry.js";
import { loadChannelsConfig } from "./config.js";
import { MessageAggregator, DEFAULT_CHUNKER_CONFIG } from "../hub/message-aggregator.js";
import { isHeartbeatAckEvent } from "../hub/heartbeat-filter.js";
import { extractText, hasToolUse } from "../agent/extract-text.js";
import type { AsyncAgent } from "../agent/async-agent.js";
import type { ChannelInfo } from "../agent/system-prompt/types.js";
import { transcribeAudio } from "../media/transcribe.js";
import { describeImage } from "../media/describe-image.js";
import { describeVideo } from "../media/describe-video.js";
import { InboundDebouncer } from "./inbound-debouncer.js";
import { extname } from "node:path";

interface AccountHandle {
  channelId: string;
  accountId: string;
  abortController: AbortController;
  state: ChannelAccountState;
}

interface LastRoute {
  routeKey: string;
  plugin: ChannelPlugin;
  deliveryCtx: DeliveryContext;
  hubConversationId: string;
  hubAgentId: string;
  chatType?: "direct" | "group" | undefined;
}

interface RouteBinding {
  routeKey: string;
  hubConversationId: string;
  hubAgentId: string;
  lastRoute: LastRoute;
}

interface PendingRoute {
  route: LastRoute;
  acks: LastRoute[];
}

interface ConversationState {
  pendingRoutes: PendingRoute[];
  activeRoute: LastRoute | null;
  activeAcks: LastRoute[];
  ackBuffer: LastRoute[];
  aggregator: MessageAggregator | null;
  typingTimer: ReturnType<typeof setInterval> | null;
  statusMessageId: string | null;
}

interface ResolveRouteResult {
  binding: RouteBinding;
  conversation: AsyncAgent;
}

export class ChannelManager {
  private readonly hub: Hub;

  /** Running accounts keyed by "channelId:accountId" */
  private readonly accounts = new Map<string, AccountHandle>();

  /** routeKey -> route binding */
  private readonly routeBindings = new Map<string, RouteBinding>();

  /** hubConversationId -> runtime state */
  private readonly conversationStates = new Map<string, ConversationState>();

  /** hubConversationId -> unsubscribe callback */
  private readonly conversationSubscriptions = new Map<string, () => void>();

  /** Latest route seen globally (best-effort fallback for send_file) */
  private lastRoute: LastRoute | null = null;

  /** Inbound debouncer keyed by routeKey */
  private debouncer: InboundDebouncer | null = null;

  constructor(hub: Hub) {
    this.hub = hub;
  }

  /** Start all configured channel accounts */
  async startAll(): Promise<void> {
    console.log("[Channels] Starting all channels...");
    const config = loadChannelsConfig();
    const plugins = listChannels();

    if (plugins.length === 0) {
      console.log("[Channels] No plugins registered");
      return;
    }

    for (const plugin of plugins) {
      const accountIds = plugin.config.listAccountIds(config);
      if (accountIds.length === 0) {
        console.log(`[Channels] Skipping ${plugin.id} (not configured)`);
        continue;
      }

      for (const accountId of accountIds) {
        const account = plugin.config.resolveAccount(config, accountId);
        if (!account || !plugin.config.isConfigured(account)) {
          console.log(`[Channels] Skipping ${plugin.id}:${accountId} (incomplete config)`);
          continue;
        }
        await this.startAccount(plugin.id, accountId, account);
      }
    }
  }

  /**
   * Start a specific channel account.
   * Public so the desktop IPC layer can call it after saving config.
   */
  async startAccount(
    channelId: string,
    accountId: string,
    accountConfig: Record<string, unknown>,
  ): Promise<void> {
    const key = `${channelId}:${accountId}`;
    if (this.accounts.has(key)) {
      console.warn(`[Channels] ${key} is already running`);
      return;
    }

    const plugin = listChannels().find((p) => p.id === channelId);
    if (!plugin) {
      console.error(`[Channels] Plugin "${channelId}" not found`);
      return;
    }

    const abortController = new AbortController();
    const handle: AccountHandle = {
      channelId,
      accountId,
      abortController,
      state: { channelId, accountId, status: "starting" },
    };
    this.accounts.set(key, handle);

    console.log(`[Channels] Starting ${key}`);

    try {
      const startPromise = plugin.gateway.start(
        accountId,
        accountConfig,
        (message: ChannelMessage) => {
          this.routeIncoming(plugin, accountId, message);
        },
        abortController.signal,
      );

      await Promise.race([
        startPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]);

      handle.state = { channelId, accountId, status: "running" };
      console.log(`[Channels] ${key} is running`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      handle.state = { channelId, accountId, status: "error", error: errorMsg };
      console.error(`[Channels] Failed to start ${key}: ${errorMsg}`);
    }
  }

  private makeRouteKey(channelId: string, accountId: string, externalConversationId: string): string {
    return `${channelId}:${accountId}:${externalConversationId}`;
  }

  private cloneRoute(route: LastRoute): LastRoute {
    return {
      ...route,
      deliveryCtx: { ...route.deliveryCtx },
    };
  }

  private createRoute(
    routeKey: string,
    plugin: ChannelPlugin,
    accountId: string,
    externalConversationId: string,
    messageId: string,
    chatType: "direct" | "group",
    hubConversationId: string,
    hubAgentId: string,
  ): LastRoute {
    return {
      routeKey,
      plugin,
      deliveryCtx: {
        channel: plugin.id,
        accountId,
        conversationId: externalConversationId,
        replyToMessageId: messageId,
      },
      hubConversationId,
      hubAgentId,
      chatType,
    };
  }

  private getConversationState(conversationId: string): ConversationState {
    const existing = this.conversationStates.get(conversationId);
    if (existing) return existing;

    const state: ConversationState = {
      pendingRoutes: [],
      activeRoute: null,
      activeAcks: [],
      ackBuffer: [],
      aggregator: null,
      typingTimer: null,
      statusMessageId: null,
    };
    this.conversationStates.set(conversationId, state);
    return state;
  }

  private stopTypingForConversation(conversationId: string): void {
    const state = this.conversationStates.get(conversationId);
    if (!state?.typingTimer) return;
    clearInterval(state.typingTimer);
    state.typingTimer = null;
  }

  private startTypingForRoute(route: LastRoute): void {
    const state = this.getConversationState(route.hubConversationId);
    this.stopTypingForConversation(route.hubConversationId);
    if (!route.plugin.outbound.sendTyping) return;

    const send = () => route.plugin.outbound.sendTyping!(route.deliveryCtx).catch(() => {});
    void send();
    state.typingTimer = setInterval(send, 5000);
  }

  private cleanupConversationState(conversationId: string, options?: { unsubscribe?: boolean }): void {
    this.stopTypingForConversation(conversationId);

    const state = this.conversationStates.get(conversationId);
    if (state) {
      state.pendingRoutes = [];
      state.activeRoute = null;
      state.activeAcks = [];
      state.ackBuffer = [];
      state.aggregator = null;
      state.statusMessageId = null;
      this.conversationStates.delete(conversationId);
    }

    if (options?.unsubscribe) {
      const unsubscribe = this.conversationSubscriptions.get(conversationId);
      if (unsubscribe) {
        unsubscribe();
        this.conversationSubscriptions.delete(conversationId);
      }
    }
  }

  private resolveDefaultAgentAndConversation(): { agentId: string; conversation?: AsyncAgent } {
    const existingAgentId = this.hub.listAgents()[0];
    if (existingAgentId) {
      return { agentId: existingAgentId };
    }

    const mainConversation = this.hub.createAgent();
    const agentId = this.hub.getConversationAgentId(mainConversation.sessionId) ?? mainConversation.sessionId;
    return { agentId, conversation: mainConversation };
  }

  private resolveOrCreateRouteBinding(
    plugin: ChannelPlugin,
    accountId: string,
    externalConversationId: string,
    messageId: string,
    chatType: "direct" | "group",
  ): ResolveRouteResult | null {
    const routeKey = this.makeRouteKey(plugin.id, accountId, externalConversationId);
    const existing = this.routeBindings.get(routeKey);

    if (existing) {
      const existingConversation = this.hub.getConversation(existing.hubConversationId);
      if (existingConversation && !existingConversation.closed) {
        existing.lastRoute = this.createRoute(
          routeKey,
          plugin,
          accountId,
          externalConversationId,
          messageId,
          chatType,
          existing.hubConversationId,
          existing.hubAgentId,
        );
        this.routeBindings.set(routeKey, existing);
        return { binding: existing, conversation: existingConversation };
      }

      // Conversation runtime disappeared — remove stale binding and rebuild.
      this.routeBindings.delete(routeKey);
      this.cleanupConversationState(existing.hubConversationId, { unsubscribe: true });
    }

    const { agentId, conversation: maybeMainConversation } = this.resolveDefaultAgentAndConversation();
    const conversation = maybeMainConversation ?? this.hub.createConversation(undefined, { agentId });
    const hubConversationId = conversation.sessionId;
    const hubAgentId = this.hub.getConversationAgentId(hubConversationId) ?? agentId;

    const binding: RouteBinding = {
      routeKey,
      hubConversationId,
      hubAgentId,
      lastRoute: this.createRoute(
        routeKey,
        plugin,
        accountId,
        externalConversationId,
        messageId,
        chatType,
        hubConversationId,
        hubAgentId,
      ),
    };
    this.routeBindings.set(routeKey, binding);

    console.log(
      `[Channels] route bind: ${routeKey} -> conversation=${hubConversationId} (agent=${hubAgentId})`,
    );

    return { binding, conversation };
  }

  private ensureConversationSubscribed(conversation: AsyncAgent): void {
    const conversationId = conversation.sessionId;
    if (this.conversationSubscriptions.has(conversationId)) return;

    console.log(`[Channels] Subscribing to conversation ${conversationId} for outbound routing`);
    const unsubscribe = conversation.subscribe((event) => {
      this.handleConversationEvent(conversationId, event);
    });
    this.conversationSubscriptions.set(conversationId, unsubscribe);
  }

  private findRouteForConversation(conversationId: string): LastRoute | null {
    for (const binding of this.routeBindings.values()) {
      if (binding.hubConversationId === conversationId) {
        return this.cloneRoute(binding.lastRoute);
      }
    }
    return null;
  }

  private handleConversationEvent(conversationId: string, event: unknown): void {
    const state = this.getConversationState(conversationId);
    const maybeMessage = (event as { message?: { role?: string } }).message;
    const role = maybeMessage?.role;

    // Activate the next pending route + acks when a new agent run starts.
    if ((event as { type?: string }).type === "agent_start") {
      const entry = state.pendingRoutes.shift();
      if (entry) {
        state.activeRoute = entry.route;
        state.activeAcks = entry.acks;
        console.log(
          `[Channels] agent_start: conversation=${conversationId} replyTo=${entry.route.deliveryCtx.replyToMessageId}, acks=${entry.acks.length}`,
        );
      }
    }

    // Agent run complete — remove 👀 from all batch messages, conditionally stop typing.
    if ((event as { type?: string }).type === "agent_end") {
      for (const ack of state.activeAcks) {
        if (ack.plugin.outbound.removeReaction) {
          console.log(`[Channels] agent_end: removing 👀 from replyTo=${ack.deliveryCtx.replyToMessageId}`);
          void ack.plugin.outbound.removeReaction(ack.deliveryCtx).catch(() => {});
        }
      }
      state.activeRoute = null;
      state.activeAcks = [];
      state.statusMessageId = null;
      if (state.pendingRoutes.length === 0) {
        console.log(`[Channels] agent_end: conversation=${conversationId}, no more pending, stopping typing`);
        this.stopTypingForConversation(conversationId);
      } else {
        console.log(
          `[Channels] agent_end: conversation=${conversationId}, ${state.pendingRoutes.length} pending run(s), keeping typing`,
        );
      }
    }

    const route = state.activeRoute ?? this.findRouteForConversation(conversationId) ?? this.lastRoute;
    if (!route) return;

    // Handle agent errors — notify the channel user
    if ((event as { type?: string }).type === "agent_error") {
      this.stopTypingForConversation(conversationId);
      for (const ack of state.activeAcks) {
        if (ack.plugin.outbound.removeReaction) {
          void ack.plugin.outbound.removeReaction(ack.deliveryCtx).catch(() => {});
        }
      }
      state.activeRoute = null;
      state.activeAcks = [];
      state.statusMessageId = null;
      const errorMsg = (event as { message?: string }).message ?? "Unknown error";
      console.error(`[Channels] Agent error: ${errorMsg}`);
      void route.plugin.outbound.sendText(route.deliveryCtx, `[Error] ${errorMsg}`).catch((err) => {
        console.error(`[Channels] Failed to send error to channel: ${err}`);
      });
      return;
    }

    const eventType = (event as { type?: string }).type;

    // Only forward assistant message events.
    if (eventType === "message_start" || eventType === "message_update" || eventType === "message_end") {
      if (role !== "assistant") return;
    } else {
      // Non-message events (tool_execution etc.) — skip for channels.
      return;
    }

    // Keep heartbeat acknowledgements internal (same behavior as desktop/gateway stream path).
    if (isHeartbeatAckEvent(event)) {
      if (eventType === "message_end") {
        state.aggregator = null;
      }
      return;
    }

    // Ensure aggregator exists for this response.
    if (eventType === "message_start") {
      this.createAggregator(conversationId, this.cloneRoute(route), state);
    }

    // Tool narration: if the assistant message contains tool_use blocks,
    // send/edit an editable status message instead of normal reply flow.
    if (eventType === "message_end" && role === "assistant") {
      const message = (event as { message?: Parameters<typeof hasToolUse>[0] }).message;
      if (hasToolUse(message)) {
        state.aggregator?.reset();
        state.aggregator = null;

        const narration = extractText(message as Parameters<typeof extractText>[0]);
        if (narration) {
          void this.sendOrEditStatus(conversationId, route, narration);
        }
        return;
      }
    }

    if (state.aggregator) {
      state.aggregator.handleEvent(event as Parameters<MessageAggregator["handleEvent"]>[0]);
    }

    // Finalize aggregator per assistant message.
    if (eventType === "message_end" && role === "assistant") {
      state.aggregator = null;
    }
  }

  private createAggregator(conversationId: string, route: LastRoute, state: ConversationState): void {
    const { plugin, deliveryCtx } = route;
    console.log(
      `[Channels] createAggregator: conversation=${conversationId} replyTo=${deliveryCtx.replyToMessageId}`,
    );
    const chunkerConfig = plugin.chunkerConfig ?? DEFAULT_CHUNKER_CONFIG;

    state.aggregator = new MessageAggregator(
      chunkerConfig,
      async (block) => {
        try {
          console.log(
            `[Channels] Sending block ${block.index} (${block.text.length} chars${block.isFinal ? ", final" : ""}) -> ${deliveryCtx.channel}:${deliveryCtx.conversationId} replyTo=${deliveryCtx.replyToMessageId}`,
          );
          if (block.index === 0) {
            await plugin.outbound.replyText(deliveryCtx, block.text);
          } else {
            await plugin.outbound.sendText(deliveryCtx, block.text);
          }
        } catch (err) {
          console.error(`[Channels] Failed to send reply: ${err}`);
        }
      },
      () => {},
    );
  }

  private async sendOrEditStatus(
    conversationId: string,
    route: LastRoute,
    text: string,
  ): Promise<void> {
    const state = this.getConversationState(conversationId);

    try {
      if (state.statusMessageId && route.plugin.outbound.editText) {
        console.log(`[Channels] Editing status message ${state.statusMessageId}`);
        await route.plugin.outbound.editText(route.deliveryCtx, state.statusMessageId, text);
      } else if (route.plugin.outbound.replyTextEditable) {
        const msgId = await route.plugin.outbound.replyTextEditable(route.deliveryCtx, text);
        state.statusMessageId = msgId;
        console.log(`[Channels] Sent editable status message ${msgId}`);
      }
      // If plugin doesn't support editable messages, silently skip.
    } catch (err) {
      console.error(`[Channels] Failed to send/edit status: ${err}`);
    }
  }

  /** Incoming channel message -> routeKey binding -> Hub conversation write. */
  private routeIncoming(
    plugin: ChannelPlugin,
    accountId: string,
    message: ChannelMessage,
  ): void {
    const { conversationId, senderId, text, messageId } = message;
    console.log(
      `[Channels] Incoming: channel=${plugin.id} conv=${conversationId} sender=${senderId} text="${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`,
    );

    const resolved = this.resolveOrCreateRouteBinding(
      plugin,
      accountId,
      conversationId,
      messageId,
      message.chatType,
    );
    if (!resolved) {
      console.error("[Channels] Failed to resolve conversation route, dropping message");
      return;
    }

    const { binding, conversation } = resolved;
    this.ensureConversationSubscribed(conversation);

    const routeSnapshot = this.cloneRoute(binding.lastRoute);
    this.lastRoute = routeSnapshot;
    const state = this.getConversationState(binding.hubConversationId);

    console.log(
      `[Channels] route selected: ${binding.routeKey} -> conversation=${binding.hubConversationId} (agent=${binding.hubAgentId})`,
    );

    // Show typing indicator and 👀 ack on this message.
    this.startTypingForRoute(routeSnapshot);
    if (routeSnapshot.plugin.outbound.addReaction) {
      console.log(`[Channels] Adding 👀 to replyTo=${messageId}`);
      void routeSnapshot.plugin.outbound.addReaction(routeSnapshot.deliveryCtx, "👀").catch(() => {});
    }
    state.ackBuffer.push(routeSnapshot);

    // Handle media messages (processed async, then fed through debouncer).
    if (message.media && plugin.downloadMedia) {
      void this.routeMedia(plugin, accountId, message, binding.routeKey);
    } else {
      // Text messages go through debouncer to batch rapid-fire sends.
      this.getDebouncer().push(binding.routeKey, text);
    }
  }

  /**
   * Download media file, process it (transcribe/describe), and forward
   * the resulting text through the debouncer.
   */
  private async routeMedia(
    plugin: ChannelPlugin,
    accountId: string,
    message: ChannelMessage,
    routeKey: string,
  ): Promise<void> {
    const media = message.media!;
    const debouncer = this.getDebouncer();

    try {
      const filePath = await plugin.downloadMedia!(media.fileId, accountId);

      if (media.type === "image") {
        // Images: describe via Vision API before reaching agent.
        const description = await describeImage(filePath);
        if (description) {
          const parts = ["[Image]", `Description: ${description}`];
          if (media.caption) parts.push(`Caption: ${media.caption}`);
          debouncer.push(routeKey, parts.join("\n"));
        } else {
          // No API key — fall back to file path.
          const parts = ["[image message received]", `File: ${filePath}`];
          if (media.caption) parts.push(`Caption: ${media.caption}`);
          debouncer.push(routeKey, parts.join("\n"));
        }
      } else if (media.type === "audio") {
        // Audio: transcribe via Whisper API before reaching agent.
        const transcript = await transcribeAudio(filePath);
        if (transcript) {
          const parts = ["[Voice Message]", `Transcript: ${transcript}`];
          if (media.caption) parts.push(`Caption: ${media.caption}`);
          debouncer.push(routeKey, parts.join("\n"));
        } else {
          // No API key configured — fall back to file path.
          const parts = ["[audio message received]", `File: ${filePath}`];
          if (media.mimeType) parts.push(`Type: ${media.mimeType}`);
          if (media.duration) parts.push(`Duration: ${media.duration}s`);
          if (media.caption) parts.push(`Caption: ${media.caption}`);
          debouncer.push(routeKey, parts.join("\n"));
        }
      } else if (media.type === "video") {
        // Video: extract frame + describe via Vision API.
        const description = await describeVideo(filePath);
        if (description) {
          const parts = ["[Video]", `Description: ${description}`];
          if (media.duration) parts.push(`Duration: ${media.duration}s`);
          if (media.caption) parts.push(`Caption: ${media.caption}`);
          debouncer.push(routeKey, parts.join("\n"));
        } else {
          // ffmpeg unavailable or no API key — fall back to file path.
          const parts = ["[video message received]", `File: ${filePath}`];
          if (media.mimeType) parts.push(`Type: ${media.mimeType}`);
          if (media.duration) parts.push(`Duration: ${media.duration}s`);
          if (media.caption) parts.push(`Caption: ${media.caption}`);
          debouncer.push(routeKey, parts.join("\n"));
        }
      } else {
        // Document: tell agent the file path.
        const parts: string[] = [];
        parts.push("[document message received]");
        parts.push(`File: ${filePath}`);
        if (media.mimeType) parts.push(`Type: ${media.mimeType}`);
        if (media.caption) parts.push(`Caption: ${media.caption}`);
        debouncer.push(routeKey, parts.join("\n"));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Channels] Failed to process media: ${msg}`);
      debouncer.push(routeKey, message.text || `[Failed to process ${media.type}]`);
    }
  }

  /**
   * Get or create inbound debouncer.
   * Batches rapid-fire messages by routeKey, then writes once to the bound Hub conversation.
   */
  private getDebouncer(): InboundDebouncer {
    if (!this.debouncer) {
      this.debouncer = new InboundDebouncer(
        (routeKey, combinedText) => {
          const binding = this.routeBindings.get(routeKey);
          if (!binding) {
            console.warn(`[Channels] Debouncer flush dropped: unknown routeKey=${routeKey}`);
            return;
          }

          const conversation = this.hub.getConversation(binding.hubConversationId);
          if (!conversation || conversation.closed) {
            console.warn(
              `[Channels] Debouncer flush dropped: conversation unavailable ${binding.hubConversationId}`,
            );
            this.routeBindings.delete(routeKey);
            this.cleanupConversationState(binding.hubConversationId, { unsubscribe: true });
            return;
          }

          this.ensureConversationSubscribed(conversation);

          const state = this.getConversationState(binding.hubConversationId);
          const route = this.cloneRoute(binding.lastRoute);
          const acks = [...state.ackBuffer];
          state.ackBuffer = [];

          state.pendingRoutes.push({ route, acks });

          const source = {
            type: "channel" as const,
            channelId: route.plugin.id,
            accountId: route.deliveryCtx.accountId,
            conversationId: route.deliveryCtx.conversationId,
          };

          // Broadcast inbound message to local listeners (Desktop UI).
          this.hub.broadcastInbound({
            agentId: binding.hubAgentId,
            conversationId: binding.hubConversationId,
            content: combinedText,
            source,
            timestamp: Date.now(),
          });

          // Prepend source context so the LLM knows platform + chat type.
          const channelName = route.plugin.meta.name ?? "Channel";
          const chatLabel = route.chatType === "group" ? "group" : "private";
          const prefixedText = `[${channelName} · ${chatLabel}]\n${combinedText}`;

          const replyTo = route.deliveryCtx.replyToMessageId ?? "?";
          console.log(
            `[Channels] Debouncer flushing ${combinedText.length} chars to conversation=${binding.hubConversationId} (route replyTo=${replyTo}, acks=${acks.length})`,
          );
          conversation.write(prefixedText, { source });
        },
      );
    }
    return this.debouncer;
  }

  /**
   * Send a file to the active channel route.
   * Returns true if the file was sent, false if no active route or plugin doesn't support media.
   */
  async sendFile(filePath: string, caption?: string, type?: string): Promise<boolean> {
    let route: LastRoute | null = null;

    for (const state of this.conversationStates.values()) {
      if (state.activeRoute) {
        route = state.activeRoute;
        break;
      }
    }

    if (!route) {
      route = this.lastRoute;
    }
    if (!route) return false;

    const { plugin, deliveryCtx } = route;
    if (!plugin.outbound.sendMedia) return false;

    const mediaType = type || this.detectMediaType(filePath);
    try {
      await plugin.outbound.sendMedia(deliveryCtx, {
        type: mediaType as import("./types.js").OutboundMediaType,
        source: filePath,
        caption,
      });
      console.log(`[Channels] Sent ${mediaType} to ${deliveryCtx.channel}:${deliveryCtx.conversationId}`);
      return true;
    } catch (err) {
      console.error(`[Channels] Failed to send file: ${err}`);
      return false;
    }
  }

  /** Detect outbound media type from file extension */
  private detectMediaType(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    const photoExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
    const videoExts = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv"]);
    const audioExts = new Set([".mp3", ".ogg", ".wav", ".m4a", ".flac", ".aac"]);
    if (photoExts.has(ext)) return "photo";
    if (videoExts.has(ext)) return "video";
    if (audioExts.has(ext)) return "audio";
    return "document";
  }

  /**
   * Stop a specific channel account.
   * Public so the desktop IPC layer can call it when removing config.
   */
  stopAccount(channelId: string, accountId: string): void {
    const key = `${channelId}:${accountId}`;
    const handle = this.accounts.get(key);
    if (!handle) return;

    const removedConversationIds = new Set<string>();
    for (const [routeKey, binding] of this.routeBindings.entries()) {
      const route = binding.lastRoute;
      if (route.plugin.id === channelId && route.deliveryCtx.accountId === accountId) {
        this.routeBindings.delete(routeKey);
        removedConversationIds.add(binding.hubConversationId);
      }
    }

    for (const conversationId of removedConversationIds) {
      const stillBound = Array.from(this.routeBindings.values())
        .some((binding) => binding.hubConversationId === conversationId);
      if (!stillBound) {
        this.cleanupConversationState(conversationId, { unsubscribe: true });
      }
    }

    if (
      this.lastRoute
      && this.lastRoute.plugin.id === channelId
      && this.lastRoute.deliveryCtx.accountId === accountId
    ) {
      this.stopTypingForConversation(this.lastRoute.hubConversationId);
      this.lastRoute = null;
    }

    handle.abortController.abort();
    handle.state = { ...handle.state, status: "stopped" };
    this.accounts.delete(key);

    if (this.accounts.size === 0 && this.debouncer) {
      this.debouncer.dispose();
      this.debouncer = null;
    }

    console.log(`[Channels] Stopped ${key}`);
  }

  /** Stop all running channel accounts */
  stopAll(): void {
    console.log("[Channels] Stopping all channels...");

    this.debouncer?.dispose();
    this.debouncer = null;

    for (const unsubscribe of this.conversationSubscriptions.values()) {
      unsubscribe();
    }
    this.conversationSubscriptions.clear();

    for (const conversationId of this.conversationStates.keys()) {
      this.stopTypingForConversation(conversationId);
    }
    this.conversationStates.clear();

    for (const [key, handle] of this.accounts) {
      handle.abortController.abort();
      handle.state = { ...handle.state, status: "stopped" };
      console.log(`[Channels] Stopped ${key}`);
    }

    this.accounts.clear();
    this.routeBindings.clear();
    this.lastRoute = null;
  }

  /** Clear the last route (e.g. when desktop user sends a message) */
  clearLastRoute(): void {
    if (this.lastRoute) {
      this.stopTypingForConversation(this.lastRoute.hubConversationId);
      console.log("[Channels] lastRoute cleared (non-channel message received)");
      this.lastRoute = null;
    }
  }

  /** Get status of all accounts */
  listAccountStates(): ChannelAccountState[] {
    return Array.from(this.accounts.values()).map((h) => ({ ...h.state }));
  }

  /** Get channel info for connected channels (for system prompt awareness) */
  listChannelInfos(): ChannelInfo[] {
    const seen = new Set<string>();
    const infos: ChannelInfo[] = [];
    for (const handle of this.accounts.values()) {
      if (handle.state.status !== "running" || seen.has(handle.channelId)) continue;
      seen.add(handle.channelId);
      const plugin = listChannels().find((p) => p.id === handle.channelId);
      if (!plugin) continue;
      infos.push({
        name: plugin.meta.name,
        canSendMedia: typeof plugin.outbound.sendMedia === "function",
      });
    }
    return infos;
  }
}
