/**
 * Browser Live View Service
 *
 * Retrieves DCV live view stream URLs from AgentCore's GetBrowserSession API,
 * then signs them with SigV4 for use with the DCV Web Client SDK.
 */

import { config } from '../config/index.js';

interface LiveViewResult {
  sessionId: string;
  liveViewUrl: string;
  browserIdentifier: string;
}

class BrowserLiveViewService {
  private client: any;
  private GetBrowserSessionCommand: any;
  private sdkLoaded = false;

  private async ensureSDK(): Promise<void> {
    if (this.sdkLoaded) return;
    try {
      const mod = await import('@aws-sdk/client-bedrock-agentcore' as string);
      const arnRegion = config.agentcore.runtimeArn?.split(':')[3];
      const region = arnRegion || config.agentcore.region;
      this.client = new mod.BedrockAgentCoreClient({ region });
      this.GetBrowserSessionCommand = mod.GetBrowserSessionCommand;
      this.sdkLoaded = true;
    } catch (err) {
      throw new Error(
        `AgentCore SDK not available for BrowserLiveView. Error: ${err}`
      );
    }
  }

  /**
   * Sign a live view stream endpoint URL with SigV4.
   * The DCV SDK requires a presigned URL to authenticate.
   */
  private async signLiveViewUrl(streamEndpoint: string): Promise<string> {
    try {
      const { SignatureV4 } = await import('@smithy/signature-v4' as string);
      const { Sha256 } = await import('@aws-crypto/sha256-js' as string);
      const { defaultProvider } = await import('@aws-sdk/credential-provider-node' as string);

      const url = new URL(streamEndpoint);
      const arnRegion = config.agentcore.runtimeArn?.split(':')[3];
      const region = arnRegion || config.agentcore.region || 'ap-northeast-1';

      const signer = new SignatureV4({
        service: 'bedrock-agentcore',
        region,
        credentials: defaultProvider(),
        sha256: Sha256,
      });

      const request = {
        method: 'GET',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : undefined,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: {
          host: url.hostname,
        },
      };

      const presigned = await signer.presign(request, { expiresIn: 300 });

      // Reconstruct URL with signed query params
      const signedUrl = new URL(streamEndpoint);
      signedUrl.search = '';
      for (const [key, value] of Object.entries(presigned.query ?? {})) {
        if (typeof value === 'string') {
          signedUrl.searchParams.set(key, value);
        }
      }

      return signedUrl.toString();
    } catch (err) {
      console.warn(`[browser-live-view] SigV4 signing failed, returning unsigned URL:`, err instanceof Error ? err.message : err);
      return streamEndpoint;
    }
  }

  /**
   * Retrieves the live view stream URL for a browser session.
   *
   * Calls GetBrowserSession with the given browserIdentifier and sessionId,
   * then signs the streamEndpoint with SigV4 for DCV SDK use.
   */
  async getLiveViewUrl(
    sessionId: string,
    browserIdentifier = 'aws.browser.v1'
  ): Promise<LiveViewResult> {
    await this.ensureSDK();

    // Single retry in case session is briefly not yet visible
    const maxAttempts = 2;
    const delayMs = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const command = new this.GetBrowserSessionCommand({
          browserIdentifier,
          sessionId,
        });

        const response = await this.client.send(command);

        const streamEndpoint = response?.streams?.liveViewStream?.streamEndpoint;
        if (!streamEndpoint) {
          throw new Error(
            `No liveViewStream.streamEndpoint in GetBrowserSession response for session ${sessionId}`
          );
        }

        // Sign the URL with SigV4
        const signedUrl = await this.signLiveViewUrl(streamEndpoint);

        console.log(`[browser-live-view] Got live view URL for session ${sessionId} (attempt ${attempt})`);
        return {
          sessionId,
          liveViewUrl: signedUrl,
          browserIdentifier,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts && (msg.includes('not found') || msg.includes('NotFound') || msg.includes('ResourceNotFoundException'))) {
          console.log(`[browser-live-view] Session ${sessionId} not ready yet, retrying in ${delayMs}ms (attempt ${attempt}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        console.error(
          `[browser-live-view] Failed to get live view URL for session ${sessionId}:`,
          msg
        );
        throw err;
      }
    }

    throw new Error(`[browser-live-view] Exhausted retries for session ${sessionId}`);
  }
}

export const browserLiveViewService = new BrowserLiveViewService();
