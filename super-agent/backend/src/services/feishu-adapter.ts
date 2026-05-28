/**
 * Feishu (Lark) Adapter — WebSocket Mode
 *
 * Uses @larksuiteoapi/node-sdk WSClient for receiving messages via
 * long-lived WebSocket connection. No public webhook URL needed.
 *
 * Replaces the old HTTP event subscription approach.
 *
 * Credentials in binding:
 *   - bot_token_enc: app_secret
 *   - config.app_id: app_id
 *   - config.domain: 'feishu' (default) or 'lark' (international)
 */

import * as lark from '@larksuiteoapi/node-sdk';
import type { IMAdapter, NormalizedIMMessage } from './im.service.js';
import type { IMChannelBindingEntity } from '../repositories/im-channel.repository.js';
import { imQueueService } from './im-queue.service.js';

type FeishuDomain = 'feishu' | 'lark';

function getApiBase(domain: FeishuDomain = 'feishu'): string {
  return domain === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

// ── Token Cache ──

interface CachedToken { token: string; expiresAt: number; }
const tokenCache = new Map<string, CachedToken>();
const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;

async function getTenantAccessToken(
  appId: string,
  appSecret: string,
  domain: FeishuDomain = 'feishu',
): Promise<string> {
  const cacheKey = `${appId}:${domain}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const base = getApiBase(domain);
  const resp = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!resp.ok) {
    throw new Error(`Feishu tenant_access_token failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json() as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  // Check business-level error code (Feishu returns HTTP 200 with code != 0 on errors)
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Feishu token error: code=${data.code} msg=${data.msg}`);
  }

  const expireSec = data.expire ?? 7200;
  tokenCache.set(cacheKey, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + expireSec * 1000 - TOKEN_SAFETY_MARGIN_MS,
  });
  return data.tenant_access_token;
}

// ── Active WSClient connections ──

interface FeishuConnection {
  binding: IMChannelBindingEntity;
  wsClient: lark.WSClient;
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
}
const activeConnections = new Map<string, FeishuConnection>();

// ── Feishu Event Types ──

interface FeishuEventPayload {
  challenge?: string;
  type?: string;
  schema?: string;
  header?: { event_type: string; token: string };
  event?: {
    sender?: { sender_id?: { open_id?: string }; sender_type?: string };
    message?: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      chat_id: string;
      message_type: string;
      content: string;
    };
  };
}

export class FeishuAdapter implements IMAdapter {
  // ── Legacy webhook verification (kept for backward compat) ──

  verifyRequest(headers: Record<string, string>, body: string): boolean {
    const token = headers['x-feishu-verification-token-internal'];
    if (!token) return true;
    try {
      const payload = JSON.parse(body);
      return payload.header?.token === token;
    } catch {
      return false;
    }
  }

  parseEvent(body: unknown): NormalizedIMMessage | null {
    // WSClient mode handles messages via WebSocket, not HTTP.
    // Kept for legacy webhook fallback.
    const payload = body as FeishuEventPayload;
    if (!payload.event?.message || payload.event.message.message_type !== 'text') return null;
    if (payload.event.sender?.sender_type === 'bot') return null;

    let text: string;
    try {
      text = JSON.parse(payload.event.message.content).text;
    } catch {
      return null;
    }
    if (!text?.trim()) return null;

    return {
      channelType: 'feishu',
      channelId: payload.event.message.chat_id,
      threadId: payload.event.message.root_id || payload.event.message.message_id,
      userId: payload.event.sender?.sender_id?.open_id || 'unknown',
      text: text.trim(),
      isExplicitThread: !!payload.event.message.root_id,
    };
  }

  static isChallenge(body: unknown): string | null {
    const p = body as FeishuEventPayload;
    if (p.type === 'url_verification' && p.challenge) return p.challenge;
    return null;
  }

  // ── WSClient Gateway lifecycle ──

  async startGateway(): Promise<void> {
    const bindings = await this.discoverBindings();
    if (bindings.length === 0) {
      console.log('[FEISHU] No enabled Feishu bindings found, gateway idle');
      return;
    }
    for (const binding of bindings) {
      try {
        await this.connectBot(binding);
      } catch (err) {
        console.error(`[FEISHU] Failed to connect binding ${binding.id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  async stopGateway(): Promise<void> {
    // WSClient doesn't have a public close method; dropping references is sufficient
    for (const [bindingId] of activeConnections) {
      console.log(`[FEISHU] WSClient removed for binding ${bindingId}`);
    }
    activeConnections.clear();
  }

  async addBot(binding: IMChannelBindingEntity): Promise<void> {
    if (activeConnections.has(binding.id)) return;
    await this.connectBot(binding);
  }

  removeBot(bindingId: string): void {
    activeConnections.delete(bindingId);
  }

  // ── Send reply via REST API ──

  async sendReply(
    binding: IMChannelBindingEntity,
    threadId: string,
    text: string,
    replyContext?: Record<string, unknown>,
  ): Promise<void> {
    const cfg = binding.config as Record<string, string>;
    const appId = cfg?.app_id;
    const appSecret = binding.bot_token_enc;
    const domain = (cfg?.domain as FeishuDomain) || 'feishu';

    if (!appId || !appSecret) {
      console.error(`[FEISHU] Missing app_id/app_secret for binding ${binding.id}`);
      return;
    }

    // Use real chat_id from replyContext (set by WSClient handler), fall back to binding.channel_id
    const chatId = (replyContext?.feishuChatId as string) || binding.channel_id;

    const token = await getTenantAccessToken(appId, appSecret, domain);
    const base = getApiBase(domain);
    const chunks = this.splitMessage(text, 30000);

    for (const chunk of chunks) {
      const resp = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
          ...(threadId ? { root_id: threadId } : {}),
        }),
      });
      if (!resp.ok) {
        console.error(`[FEISHU] API error: ${resp.status} ${await resp.text()}`);
      } else {
        // Check business-level error
        const result = await resp.json() as { code: number; msg: string };
        if (result.code !== 0) {
          console.error(`[FEISHU] Business error: code=${result.code} msg=${result.msg}`);
        }
      }
    }
  }

  /**
   * Send a "thinking" indicator message and return its message_id.
   * The message will be deleted when the actual reply is sent.
   */
  async sendThinkingIndicator(
    binding: IMChannelBindingEntity,
    threadId: string,
    replyContext?: Record<string, unknown>,
  ): Promise<string | null> {
    const cfg = binding.config as Record<string, string>;
    const appId = cfg?.app_id;
    const appSecret = binding.bot_token_enc;
    const domain = (cfg?.domain as FeishuDomain) || 'feishu';

    if (!appId || !appSecret) return null;

    const chatId = (replyContext?.feishuChatId as string) || binding.channel_id;
    const token = await getTenantAccessToken(appId, appSecret, domain);
    const base = getApiBase(domain);

    try {
      const resp = await fetch(`${base}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({
            elements: [{
              tag: 'div',
              text: { tag: 'plain_text', content: '🤔 思考中...' },
            }],
          }),
          ...(threadId ? { root_id: threadId } : {}),
        }),
      });

      if (resp.ok) {
        const result = await resp.json() as { code: number; data?: { message_id?: string } };
        if (result.code === 0 && result.data?.message_id) {
          return result.data.message_id;
        }
      }
    } catch (err) {
      console.warn('[FEISHU] Failed to send thinking indicator:', err instanceof Error ? err.message : err);
    }
    return null;
  }

  /**
   * Delete a message by its message_id.
   */
  private async deleteMessage(
    appId: string,
    appSecret: string,
    domain: FeishuDomain,
    messageId: string,
  ): Promise<void> {
    try {
      const token = await getTenantAccessToken(appId, appSecret, domain);
      const base = getApiBase(domain);
      const resp = await fetch(`${base}/open-apis/im/v1/messages/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        console.warn(`[FEISHU] Failed to delete thinking message: ${resp.status}`);
      }
    } catch (err) {
      console.warn('[FEISHU] Error deleting message:', err instanceof Error ? err.message : err);
    }
  }

  // ── Private: WSClient connection ──

  private async connectBot(binding: IMChannelBindingEntity): Promise<void> {
    const cfg = binding.config as Record<string, string>;
    const appId = cfg?.app_id;
    const appSecret = binding.bot_token_enc;
    const domain = (cfg?.domain as FeishuDomain) || 'feishu';

    if (!appId || !appSecret) {
      console.warn(`[FEISHU] Missing app_id or app_secret for binding ${binding.id}, skipping`);
      return;
    }

    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    });

    const bindingId = binding.id;

    wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: unknown) => {
          try {
            const event = data as {
              sender?: { sender_id?: { open_id?: string }; sender_type?: string };
              message?: {
                message_id: string;
                root_id?: string;
                chat_id: string;
                message_type: string;
                content: string;
              };
            };

            // Debug: log all incoming message types
            console.log(`[FEISHU] Received message_type: ${event.message?.message_type}, content: ${event.message?.content?.substring(0, 200)}`);

            if (!event.message) return;
            if (event.sender?.sender_type === 'bot') return;

            const messageType = event.message.message_type;
            let text = '';

            if (messageType === 'text') {
              // Plain text message
              try {
                text = JSON.parse(event.message.content).text;
              } catch {
                return;
              }
              if (!text?.trim()) return;
              text = text.trim();
            } else if (messageType === 'file' || messageType === 'media') {
              // File or media (video/audio) message — defer download to worker
              try {
                const content = JSON.parse(event.message.content);
                const fileKey = content.file_key;
                const fileName = content.file_name || `file_${Date.now()}`;
                if (!fileKey) return;

                text = `请帮我审核这份合同文件：${fileName}`;
                // Don't download here — pass metadata for lazy download in worker
                const normalized: NormalizedIMMessage = {
                  channelType: 'feishu',
                  channelId: event.message.chat_id,
                  threadId: event.message.root_id || event.message.message_id,
                  userId: event.sender?.sender_id?.open_id || 'unknown',
                  text,
                  bindingId: bindingId,
                  isExplicitThread: !!event.message.root_id,
                  pendingFileDownloads: [{ fileName, messageId: event.message.message_id, fileKey }],
                };

                await imQueueService.enqueue(normalized, {
                  feishuChatId: event.message.chat_id,
                  feishuMessageId: event.message.message_id,
                });
                return; // already enqueued, skip the common enqueue below
              } catch (err) {
                console.warn('[FEISHU] Failed to process file message:', err);
                return;
              }
            } else if (messageType === 'image') {
              // Image message — defer download to worker
              try {
                const content = JSON.parse(event.message.content);
                const imageKey = content.image_key;
                if (!imageKey) return;

                const fileName = `image_${Date.now()}.png`;
                text = `[用户发送了图片: ${fileName}]`;

                const normalized: NormalizedIMMessage = {
                  channelType: 'feishu',
                  channelId: event.message.chat_id,
                  threadId: event.message.root_id || event.message.message_id,
                  userId: event.sender?.sender_id?.open_id || 'unknown',
                  text,
                  bindingId: bindingId,
                  isExplicitThread: !!event.message.root_id,
                  pendingFileDownloads: [{ fileName, messageId: event.message.message_id, fileKey: imageKey }],
                };

                await imQueueService.enqueue(normalized, {
                  feishuChatId: event.message.chat_id,
                  feishuMessageId: event.message.message_id,
                });
                return; // already enqueued
              } catch (err) {
                console.warn('[FEISHU] Failed to process image message:', err);
                return;
              }
            } else {
              // Unsupported message type — skip
              console.log(`[FEISHU] Skipping unsupported message_type: ${messageType}`);
              return;
            }

            const normalized: NormalizedIMMessage = {
              channelType: 'feishu',
              channelId: event.message.chat_id,
              threadId: event.message.root_id || event.message.message_id,
              userId: event.sender?.sender_id?.open_id || 'unknown',
              text,
              bindingId: bindingId,
              isExplicitThread: !!event.message.root_id,
            };

            await imQueueService.enqueue(normalized, {
              feishuChatId: event.message.chat_id,
              feishuMessageId: event.message.message_id,
            });
          } catch (err) {
            console.error(`[FEISHU] Error handling WSClient message:`, err instanceof Error ? err.message : err);
          }
        },
      }),
    });

    activeConnections.set(bindingId, { binding, wsClient, appId, appSecret, domain });
    console.log(`[FEISHU] WSClient connected for binding ${bindingId} (domain: ${domain})`);
  }

  private async discoverBindings(): Promise<IMChannelBindingEntity[]> {
    const { prisma } = await import('../config/database.js');
    return await prisma.im_channel_bindings.findMany({
      where: { channel_type: 'feishu', is_enabled: true },
    }) as unknown as IMChannelBindingEntity[];
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) chunks.push(text.substring(i, i + maxLen));
    return chunks;
  }

  /**
   * Download a file/image from Feishu using the message resource API.
   * Public method called by IM service during worker processing.
   */
  async downloadFile(
    binding: IMChannelBindingEntity,
    messageId: string,
    fileKey: string,
  ): Promise<Buffer | null> {
    const cfg = binding.config as Record<string, string>;
    const appId = cfg?.app_id;
    const appSecret = binding.bot_token_enc;
    const domain = (cfg?.domain as FeishuDomain) || 'feishu';

    if (!appId || !appSecret) return null;

    const token = await getTenantAccessToken(appId, appSecret, domain);
    return this.downloadFeishuFile(token, messageId, fileKey, domain);
  }

  /**
   * Download a file/image from Feishu using the message resource API.
   * Returns the file content as a Buffer, or null on failure.
   */
  private async downloadFeishuFile(
    token: string,
    messageId: string,
    fileKey: string,
    domain: FeishuDomain = 'feishu',
  ): Promise<Buffer | null> {
    const base = getApiBase(domain);
    const url = `${base}/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`;

    console.log(`[FEISHU] Downloading file: messageId=${messageId}, fileKey=${fileKey}`);

    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`[FEISHU] File download failed: ${resp.status} ${resp.statusText} - ${body}`);
        return null;
      }

      const contentType = resp.headers.get('content-type') || '';
      console.log(`[FEISHU] File download response: status=${resp.status}, content-type=${contentType}`);

      // If the response is JSON, it's an error response from Feishu
      if (contentType.includes('application/json')) {
        const errorBody = await resp.text();
        console.error(`[FEISHU] File download returned JSON error: ${errorBody}`);
        return null;
      }

      const arrayBuffer = await resp.arrayBuffer();
      console.log(`[FEISHU] File downloaded successfully: ${arrayBuffer.byteLength} bytes`);
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.error('[FEISHU] File download error:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}

export const feishuAdapter = new FeishuAdapter();
