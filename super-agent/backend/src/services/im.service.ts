/**
 * IM (Instant Messaging) Service
 *
 * Handles incoming messages from IM platforms (Slack, Discord, etc.),
 * resolves them to chat sessions, and sends responses back.
 *
 * Updated to support:
 * - Async processing via BullMQ (messages enqueued by webhooks/gateways)
 * - replyContext for platform-specific reply metadata (e.g. DingTalk sessionWebhook)
 * - Extended IMAdapter interface with optional gateway lifecycle methods
 */

import {
  imChannelRepository,
  imThreadSessionRepository,
  type IMChannelBindingEntity,
} from '../repositories/im-channel.repository.js';
import { chatService } from './chat.service.js';
import { chatSessionRepository, type SessionSource } from '../repositories/chat.repository.js';

/** Normalized message from any IM platform. */
export interface NormalizedIMMessage {
  channelType: string;
  channelId: string;
  threadId: string;
  userId: string;
  userName?: string;
  text: string;
  /** Pre-resolved binding ID (set by Gateway adapters that already know the binding). */
  bindingId?: string;
  /**
   * Whether this message is an explicit thread/topic reply.
   * true  → Feishu root_id reply, Slack thread_ts reply, Discord thread, Telegram reply_to_message, etc.
   * false → standalone message in the main chat stream.
   * When false, the message routes to the binding's sticky session for context continuity.
   */
  isExplicitThread?: boolean;
  /** Files attached to this message (downloaded from IM platform). */
  attachedFiles?: Array<{ fileName: string; content: Buffer }>;
  /**
   * File references to download lazily (for queue-safe serialization).
   * The actual download happens in the worker, not at enqueue time.
   */
  pendingFileDownloads?: Array<{
    fileName: string;
    messageId: string;
    fileKey: string;
  }>;
}

/** Adapter interface — each IM platform implements this. */
export interface IMAdapter {
  /** Verify the incoming request signature. Returns true if valid. */
  verifyRequest(headers: Record<string, string>, body: string): boolean;
  /** Parse the raw platform event into a normalized message (or null if not a user message). */
  parseEvent(body: unknown): NormalizedIMMessage | null;
  /** Send a reply back to the IM platform. */
  sendReply(
    binding: IMChannelBindingEntity,
    threadId: string,
    text: string,
    replyContext?: Record<string, unknown>,
  ): Promise<void>;
  /** Optional: start a long-lived gateway connection (Discord Gateway, DingTalk Stream, Feishu WSClient). */
  startGateway?(): Promise<void>;
  /** Optional: stop the gateway connection on shutdown. */
  stopGateway?(): Promise<void>;
  /** Optional: dynamically add a bot connection. */
  addBot?(binding: IMChannelBindingEntity): Promise<void>;
  /** Optional: remove a bot connection. */
  removeBot?(bindingId: string): void;
}

class IMService {
  private adapters = new Map<string, IMAdapter>();

  registerAdapter(channelType: string, adapter: IMAdapter): void {
    this.adapters.set(channelType, adapter);
  }

  getAdapter(channelType: string): IMAdapter | undefined {
    return this.adapters.get(channelType);
  }

  /**
   * Start all gateway-based adapters (Discord, DingTalk, Feishu).
   * Called once at app startup after adapters are registered.
   */
  async startGateways(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      if (adapter.startGateway) {
        try {
          await adapter.startGateway();
          console.log(`[IM] Gateway started for ${type}`);
        } catch (err) {
          console.error(`[IM] Failed to start gateway for ${type}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  /**
   * Stop all gateway-based adapters. Called on graceful shutdown.
   */
  async stopGateways(): Promise<void> {
    for (const [type, adapter] of this.adapters) {
      if (adapter.stopGateway) {
        try {
          await adapter.stopGateway();
          console.log(`[IM] Gateway stopped for ${type}`);
        } catch (err) {
          console.error(`[IM] Failed to stop gateway for ${type}:`, err instanceof Error ? err.message : err);
        }
      }
    }
  }

  /**
   * Hot-reload a binding's gateway connection after config update.
   *
   * Establishes the new connection first, then tears down the old one,
   * minimizing the window where messages could be missed. For adapters
   * without gateway support (webhook-only), this is a no-op — those
   * already read fresh config from the DB on every message.
   *
   * In-flight messages (already enqueued in BullMQ) are not affected:
   * - handleMessage re-reads the binding from DB, so it gets fresh config
   * - sendReply falls back to REST API if the WS connection is unavailable
   */
  async reconnectBinding(binding: IMChannelBindingEntity): Promise<void> {
    const adapter = this.adapters.get(binding.channel_type);
    if (!adapter) return;

    // No gateway support → nothing to reconnect (webhook adapters read DB on each request)
    if (!adapter.addBot && !adapter.removeBot) return;

    if (binding.is_enabled && adapter.addBot) {
      // Connect new first, then tear down old — minimizes message gap
      try {
        // addBot implementations check for existing connections and skip if already connected,
        // so we remove the old one first but keep the window tight
        if (adapter.removeBot) {
          adapter.removeBot(binding.id);
        }
        await adapter.addBot(binding);
        console.log(`[IM] Reconnected ${binding.channel_type} binding ${binding.id}`);
      } catch (err) {
        console.error(
          `[IM] Failed to reconnect ${binding.channel_type} binding ${binding.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    } else {
      // Binding disabled — just tear down
      if (adapter.removeBot) {
        adapter.removeBot(binding.id);
        console.log(`[IM] Disconnected disabled ${binding.channel_type} binding ${binding.id}`);
      }
    }
  }

  /**
   * Handle an incoming IM message end-to-end:
   * 1. Find channel binding → determines org + scope
   * 2. Find or create thread→session mapping
   * 3. Call ChatService.processMessage (same as web UI)
   * 4. Send response back via adapter
   *
   * @param replyContext - Platform-specific context for replies (e.g. DingTalk sessionWebhook)
   */
  async handleMessage(
    msg: NormalizedIMMessage,
    replyContext?: Record<string, unknown>,
  ): Promise<{ text: string; sessionId: string }> {
    // 1. Find binding — use pre-resolved bindingId (Gateway mode) or look up by channel
    let binding: IMChannelBindingEntity | null = null;
    if (msg.bindingId) {
      binding = await imChannelRepository.findById(msg.bindingId);
    }
    if (!binding) {
      binding = await imChannelRepository.findByChannelTypeAndId(msg.channelType, msg.channelId);
    }
    if (!binding) {
      throw new Error(`No active IM binding for ${msg.channelType}:${msg.channelId}`);
    }

    // 2. Resolve or create session
    const { sessionId } = await this.resolveSession(binding, msg);

    // 2.5. Send "thinking" indicator for platforms that support it
    if (msg.channelType === 'feishu') {
      const adapter = this.adapters.get('feishu') as any;
      if (adapter?.sendThinkingIndicator) {
        const thinkingMsgId = await adapter.sendThinkingIndicator(binding, msg.threadId, replyContext);
        if (thinkingMsgId) {
          // Attach thinking message ID to replyContext so sendReply can delete it
          if (!replyContext) replyContext = {};
          replyContext.feishuThinkingMessageId = thinkingMsgId;
        }
      }
    }

    // 3. Process message through ChatService (same code path as web UI)
    // Use binding's creator as the system userId (IM platform user IDs are not UUIDs)
    const systemUserId = binding.created_by || 'system';

    // If the message has attached files, write them to the workspace first
    const attachedFileNames: string[] = [];

    // Handle pending file downloads (files referenced by metadata, downloaded lazily)
    if (msg.pendingFileDownloads && msg.pendingFileDownloads.length > 0 && msg.channelType === 'feishu') {
      const { feishuAdapter } = await import('./feishu-adapter.js');
      for (const fileRef of msg.pendingFileDownloads) {
        try {
          console.log(`[IM] Downloading pending file: ${fileRef.fileName} (messageId=${fileRef.messageId}, fileKey=${fileRef.fileKey})`);
          const fileBuffer = await feishuAdapter.downloadFile(binding, fileRef.messageId, fileRef.fileKey);
          if (fileBuffer) {
            if (!msg.attachedFiles) msg.attachedFiles = [];
            msg.attachedFiles.push({ fileName: fileRef.fileName, content: fileBuffer });
          } else {
            console.warn(`[IM] Failed to download file from Feishu: ${fileRef.fileName}`);
          }
        } catch (err) {
          console.error(`[IM] Error downloading file ${fileRef.fileName}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    if (msg.attachedFiles && msg.attachedFiles.length > 0) {
      const { workspaceManager } = await import('./workspace-manager.js');
      for (const file of msg.attachedFiles) {
        try {
          console.log(`[IM] Writing file to workspace: ${file.fileName} (${file.content.length} bytes), org=${binding.organization_id}, scope=${binding.business_scope_id}, session=${sessionId}`);
          const ok = await workspaceManager.writeWorkspaceFileRaw(
            binding.organization_id,
            binding.business_scope_id,
            sessionId,
            file.fileName,
            file.content,
          );
          if (ok) {
            attachedFileNames.push(file.fileName);
            console.log(`[IM] Wrote attached file to workspace: ${file.fileName}`);
          } else {
            console.warn(`[IM] writeWorkspaceFileRaw returned false for: ${file.fileName}`);
          }
        } catch (err) {
          console.error(`[IM] Error writing file ${file.fileName}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    // Inject file context into the message text so the agent knows about uploaded files
    let effectiveMessage = msg.text;
    if (attachedFileNames.length > 0) {
      const fileList = attachedFileNames.map(f => `  - ${f}`).join('\n');
      effectiveMessage = `[System context: The user has just uploaded the following file(s) to the workspace. You can read/access them directly by their file names:\n${fileList}]\n\n${effectiveMessage}`;
    }

    const response = await chatService.processMessage({
      sessionId,
      businessScopeId: binding.business_scope_id,
      message: effectiveMessage,
      organizationId: binding.organization_id,
      userId: systemUserId,
    });

    // 4. Send reply back
    const adapter = this.adapters.get(msg.channelType);
    if (adapter) {
      await adapter.sendReply(binding, msg.threadId, response.text, replyContext);
    }

    return { text: response.text, sessionId: response.sessionId };
  }

  private async resolveSession(
    binding: IMChannelBindingEntity,
    msg: NormalizedIMMessage,
  ): Promise<{ sessionId: string; isNew: boolean }> {
    // ── Case 1: Explicit thread reply → isolated session per thread (original behavior) ──
    if (msg.isExplicitThread) {
      const existing = await imThreadSessionRepository.findByThread(binding.id, msg.threadId);
      if (existing) {
        return { sessionId: existing.session_id, isNew: false };
      }

      // New explicit thread — create a dedicated session + mapping
      const systemUserId = binding.created_by || 'system';
      const session = await chatService.createSession(
        { business_scope_id: binding.business_scope_id, context: {} },
        binding.organization_id,
        systemUserId,
      );
      // Mark as IM source
      await chatSessionRepository.update(session.id, binding.organization_id, { source: 'im' as SessionSource });

      await imThreadSessionRepository.create({
        binding_id: binding.id,
        thread_id: msg.threadId,
        session_id: session.id,
        im_user_id: msg.userId,
      });

      return { sessionId: session.id, isNew: true };
    }

    // ── Case 2: Non-threaded message → route to sticky session ──

    // 2a. Try existing sticky session
    if (binding.sticky_session_id) {
      const session = await chatSessionRepository.findById(
        binding.sticky_session_id,
        binding.organization_id,
      );
      if (session) {
        // Record thread mapping so replies can find the right IM thread
        await imThreadSessionRepository.upsert({
          binding_id: binding.id,
          thread_id: msg.threadId,
          session_id: session.id,
          im_user_id: msg.userId,
        });
        return { sessionId: session.id, isNew: false };
      }

      // Sticky session was deleted — clear the stale reference
      await imChannelRepository.updateStickySession(binding.id, null);
    }

    // 2b. Create new sticky session
    const systemUserId = binding.created_by || 'system';
    const session = await chatService.createSession(
      { business_scope_id: binding.business_scope_id, context: {} },
      binding.organization_id,
      systemUserId,
    );
    // Mark as IM source
    await chatSessionRepository.update(session.id, binding.organization_id, { source: 'im' as SessionSource });

    // Persist sticky reference on the binding
    await imChannelRepository.updateStickySession(binding.id, session.id);

    // Record thread mapping
    await imThreadSessionRepository.upsert({
      binding_id: binding.id,
      thread_id: msg.threadId,
      session_id: session.id,
      im_user_id: msg.userId,
    });

    return { sessionId: session.id, isNew: true };
  }
}

export const imService = new IMService();
