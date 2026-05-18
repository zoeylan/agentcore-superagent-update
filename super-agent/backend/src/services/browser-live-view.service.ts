/**
 * Browser Live View Service
 *
 * Retrieves DCV live view stream URLs from AgentCore's GetBrowserSession API.
 * The streamEndpoint returned is already a presigned URL suitable for direct
 * use with the DCV Web Client SDK.
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
   * Retrieves the live view stream URL for a browser session.
   *
   * Calls GetBrowserSession with the given browserIdentifier and sessionId,
   * then extracts the presigned streamEndpoint URL from the response.
   */
  async getLiveViewUrl(
    sessionId: string,
    browserIdentifier = 'aws.browser.v1'
  ): Promise<LiveViewResult> {
    await this.ensureSDK();

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

      return {
        sessionId,
        liveViewUrl: streamEndpoint,
        browserIdentifier,
      };
    } catch (err) {
      console.error(
        `[browser-live-view] Failed to get live view URL for session ${sessionId}:`,
        err instanceof Error ? err.message : err
      );
      throw err;
    }
  }
}

export const browserLiveViewService = new BrowserLiveViewService();
