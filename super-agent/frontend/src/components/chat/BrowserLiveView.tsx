/**
 * BrowserLiveView
 *
 * A floating, draggable panel that displays a real-time DCV live view stream
 * from the agent's browser session. Falls back to screenshot-based display
 * if DCV connection fails.
 *
 * Flow:
 * 1. Listens for `browser-live-view-ready` window events (carries liveViewUrl)
 * 2. Loads DCV SDK from `/dcv-sdk/dcvjs-umd/dcv.js`
 * 3. Authenticates with the presigned URL
 * 4. Connects and displays real-time video stream
 * 5. Also listens for `browser-frame` events as screenshot fallback
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Monitor, Loader2, Maximize2, Minimize2, Wifi, WifiOff } from 'lucide-react'

declare global {
  interface Window {
    dcv: any;
  }
}

type ConnectionMode = 'none' | 'connecting' | 'dcv' | 'screenshot'

export function BrowserLiveView() {
  const [visible, setVisible] = useState(false)
  const [mode, setMode] = useState<ConnectionMode>('none')
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [toolName, setToolName] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [dcvLoaded, setDcvLoaded] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)

  // Drag state
  const [position, setPosition] = useState({ x: 20, y: 20 })
  const [dragging, setDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement>(null)

  // Resize state
  const [size, setSize] = useState({ width: 640, height: 480 })
  const [resizing, setResizing] = useState(false)
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 })

  // DCV connection refs
  const connectionRef = useRef<any>(null)
  const authRef = useRef<any>(null)
  const dcvContainerRef = useRef<HTMLDivElement>(null)

  // Track whether we already loaded the SDK script
  const sdkLoadAttempted = useRef(false)

  // Load DCV SDK
  const loadDCVSDK = useCallback(() => {
    if (window.dcv) {
      setDcvLoaded(true)
      return
    }
    if (sdkLoadAttempted.current) return
    sdkLoadAttempted.current = true

    const script = document.createElement('script')
    script.src = '/dcv-sdk/dcvjs-umd/dcv.js'
    script.type = 'text/javascript'
    script.onload = () => {
      console.log('[BrowserLiveView] DCV SDK loaded successfully')
      if (window.dcv && window.dcv.setLogLevel && window.dcv.LogLevel) {
        window.dcv.setLogLevel(window.dcv.LogLevel.INFO)
      }
      setDcvLoaded(true)
    }
    script.onerror = () => {
      console.error('[BrowserLiveView] Failed to load DCV SDK')
      setError('Failed to load DCV SDK')
    }
    document.head.appendChild(script)
  }, [])

  // Connect to DCV using presigned URL
  const connectToDCV = useCallback((liveViewUrl: string) => {
    if (!window.dcv) {
      setError('DCV SDK not available')
      setMode('screenshot')
      return
    }

    setMode('connecting')
    setError(null)

    // Set worker paths
    const baseUrl = window.location.origin + '/dcv-sdk/dcvjs-umd'
    const workerPath = baseUrl + '/dcv/'
    if (window.dcv.setWorkerPath) {
      window.dcv.setWorkerPath(workerPath)
    }
    if (window.dcv.setBaseUrl) {
      window.dcv.setBaseUrl(baseUrl)
    }

    let authSuccessful = false

    authRef.current = window.dcv.authenticate(liveViewUrl, {
      promptCredentials: (_authType: any, callback: any) => {
        // Presigned URLs have credentials embedded
        callback(null, null)
      },
      error: (_auth: any, authError: any) => {
        if (authSuccessful) return
        console.error('[BrowserLiveView] DCV authentication failed:', authError)
        const msg = authError?.message || authError?.toString() || 'Authentication failed'
        setError(`DCV auth failed: ${msg}`)
        setMode('screenshot') // Fall back to screenshots
        authRef.current = null
      },
      success: (_auth: any, result: any) => {
        authSuccessful = true
        console.log('[BrowserLiveView] DCV authentication successful')

        if (!result || !result[0]) {
          setError('No session data from DCV auth')
          setMode('screenshot')
          return
        }

        const { sessionId: dcvSessionId, authToken } = result[0]

        // Wait for DOM to have the dcv-display element
        setTimeout(() => {
          connectToSession(liveViewUrl, dcvSessionId, authToken)
        }, 100)
      },
      httpExtraSearchParams: () => {
        const searchParams = new URL(liveViewUrl).searchParams
        return searchParams
      },
    })
  }, [])

  const connectToSession = useCallback((serverUrl: string, dcvSessionId: string, authToken: string) => {
    const displayElement = document.getElementById('dcv-live-display')
    if (!displayElement) {
      console.error('[BrowserLiveView] dcv-live-display element not found, retrying...')
      setTimeout(() => connectToSession(serverUrl, dcvSessionId, authToken), 100)
      return
    }

    const baseUrl = window.location.origin + '/dcv-sdk/dcvjs-umd'

    const connectOptions = {
      url: serverUrl,
      sessionId: dcvSessionId,
      authToken,
      divId: 'dcv-live-display',
      baseUrl,
      observers: {
        httpExtraSearchParams: () => {
          const params = new URL(serverUrl).searchParams
          return params
        },
        firstFrame: () => {
          console.log('[BrowserLiveView] First frame received - DCV stream active')
          setMode('dcv')
          setError(null)
        },
        displayLayout: (serverWidth: number, serverHeight: number) => {
          console.log(`[BrowserLiveView] Display layout: ${serverWidth}x${serverHeight}`)
        },
        error: (connError: any) => {
          console.error('[BrowserLiveView] DCV connection error:', connError)
          setError(`DCV error: ${connError?.message || connError}`)
        },
      },
    }

    window.dcv.connect(connectOptions)
      .then((conn: any) => {
        console.log('[BrowserLiveView] DCV connection established')
        connectionRef.current = conn
        setMode('dcv')
      })
      .catch((connErr: any) => {
        console.error('[BrowserLiveView] DCV connect failed:', connErr)
        setError(`DCV connection failed: ${connErr?.message || connErr}`)
        setMode('screenshot') // Fall back to screenshots
      })
  }, [])

  // Disconnect DCV
  const disconnectDCV = useCallback(() => {
    if (connectionRef.current) {
      try {
        connectionRef.current.close()
      } catch (err) {
        console.warn('[BrowserLiveView] Error closing DCV connection:', err)
      }
      connectionRef.current = null
    }
    if (authRef.current) {
      try {
        authRef.current.cancel()
      } catch (err) {
        console.warn('[BrowserLiveView] Error cancelling DCV auth:', err)
      }
      authRef.current = null
    }
  }, [])

  // Listen for browser-live-view-ready events (DCV stream URL)
  useEffect(() => {
    // Track which session we've already connected to — ignore duplicates
    let connectedSessionId: string | null = null

    const handleLiveViewReady = (e: Event) => {
      const { liveViewUrl, sessionId: evtSessionId } = (e as CustomEvent).detail
      if (!liveViewUrl) return

      // Ignore duplicate events for the same session
      if (connectedSessionId === evtSessionId) {
        console.log('[BrowserLiveView] Ignoring duplicate live view event for session:', evtSessionId)
        return
      }

      console.log('[BrowserLiveView] Live view ready event received, sessionId:', evtSessionId)
      connectedSessionId = evtSessionId
      setSessionId(evtSessionId)
      setVisible(true)
      setError(null)

      // Disconnect any previous connection (different session)
      disconnectDCV()

      // Load SDK if not loaded, then connect
      if (!dcvLoaded && !window.dcv) {
        loadDCVSDK()
        const checkInterval = setInterval(() => {
          if (window.dcv) {
            clearInterval(checkInterval)
            connectToDCV(liveViewUrl)
          }
        }, 100)
        setTimeout(() => clearInterval(checkInterval), 10000)
      } else {
        connectToDCV(liveViewUrl)
      }
    }

    window.addEventListener('browser-live-view-ready', handleLiveViewReady)
    return () => {
      window.removeEventListener('browser-live-view-ready', handleLiveViewReady)
    }
  }, [dcvLoaded, loadDCVSDK, connectToDCV, disconnectDCV])

  // Listen for browser-frame events (screenshot fallback)
  // Also makes the panel visible early — as soon as any browser tool runs
  useEffect(() => {
    const handleBrowserFrame = (e: Event) => {
      const { screenshotData, browserToolName } = (e as CustomEvent).detail
      if (screenshotData) {
        setScreenshot(screenshotData)
        setToolName(browserToolName)
        // Show panel immediately on first browser frame
        if (!visible) {
          setVisible(true)
        }
        // Use screenshot mode if DCV isn't connected yet
        if (mode !== 'dcv' && mode !== 'connecting') {
          setMode('screenshot')
        }
      }
    }

    window.addEventListener('browser-frame', handleBrowserFrame)
    return () => window.removeEventListener('browser-frame', handleBrowserFrame)
  }, [mode, visible])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnectDCV()
    }
  }, [disconnectDCV])

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    e.preventDefault()
    setDragging(true)
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    }
  }, [position])

  useEffect(() => {
    if (!dragging) return
    const handleMouseMove = (e: MouseEvent) => {
      setPosition({
        x: e.clientX - dragOffset.current.x,
        y: e.clientY - dragOffset.current.y,
      })
    }
    const handleMouseUp = () => setDragging(false)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging])

  // Resize handlers
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setResizing(true)
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height,
    }
  }, [size])

  useEffect(() => {
    if (!resizing) return
    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - resizeStart.current.x
      const dy = e.clientY - resizeStart.current.y
      setSize({
        width: Math.max(400, resizeStart.current.width + dx),
        height: Math.max(300, resizeStart.current.height + dy),
      })
    }
    const handleMouseUp = () => setResizing(false)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [resizing])

  const handleClose = useCallback(() => {
    setVisible(false)
    // Don't disconnect DCV — user might re-open
  }, [])

  const toggleExpanded = useCallback(() => {
    setExpanded(prev => !prev)
  }, [])

  if (!visible) return null

  const statusLabel = mode === 'dcv'
    ? 'Live Stream'
    : mode === 'connecting'
    ? 'Connecting...'
    : mode === 'screenshot'
    ? 'Screenshots'
    : 'Waiting...'

  const StatusIcon = mode === 'dcv' ? Wifi : mode === 'connecting' ? Loader2 : WifiOff

  return (
    <div
      ref={panelRef}
      className={`fixed z-50 flex flex-col bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden ${
        dragging || resizing ? 'select-none' : ''
      } ${expanded ? 'inset-10' : ''}`}
      style={expanded ? {} : { top: position.y, left: position.x, width: size.width, height: size.height }}
    >
      {/* Header - draggable */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-gray-800 border-b border-gray-700 cursor-move flex-shrink-0"
        onMouseDown={handleMouseDown}
      >
        <Monitor className="w-4 h-4 text-blue-400" />
        <span className="text-sm font-medium text-white flex-1 truncate">
          Browser Live View
          {sessionId && (
            <span className="ml-2 text-xs text-gray-400 font-normal">
              ({sessionId.slice(0, 12)}...)
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5" data-no-drag>
          {/* Status indicator */}
          <span className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded ${
            mode === 'dcv' ? 'bg-green-900/50 text-green-400' :
            mode === 'connecting' ? 'bg-yellow-900/50 text-yellow-400' :
            'bg-gray-700 text-gray-400'
          }`}>
            <StatusIcon className={`w-3 h-3 ${mode === 'connecting' ? 'animate-spin' : ''}`} />
            {statusLabel}
          </span>
          <button
            onClick={toggleExpanded}
            className="p-1 rounded hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            title={expanded ? 'Restore' : 'Maximize'}
          >
            {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-red-600/30 text-gray-400 hover:text-red-400 transition-colors"
            title="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 relative overflow-hidden bg-gray-950 flex items-center justify-center">
        {/* Error banner */}
        {error && (
          <div className="absolute top-0 left-0 right-0 z-10 px-3 py-1.5 bg-red-900/80 text-red-200 text-xs truncate">
            {error}
          </div>
        )}

        {/* DCV display container */}
        {(mode === 'dcv' || mode === 'connecting') && (
          <div
            id="dcv-live-display"
            ref={dcvContainerRef}
            style={{
              width: '100%',
              height: '100%',
              position: 'absolute',
              top: 0,
              left: 0,
            }}
          />
        )}

        {/* Loading state while connecting */}
        {mode === 'connecting' && (
          <div className="flex flex-col items-center gap-2 text-gray-400 z-10">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="text-sm">Connecting to DCV live stream...</span>
          </div>
        )}

        {/* Screenshot fallback */}
        {mode === 'screenshot' && screenshot && (
          <img
            src={screenshot}
            alt="Browser screenshot"
            className="max-w-full max-h-full object-contain"
            draggable={false}
          />
        )}

        {/* Initial waiting state */}
        {mode === 'none' && !error && (
          <div className="flex flex-col items-center gap-2 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="text-sm">Waiting for browser session...</span>
          </div>
        )}

        {/* Screenshot overlay in DCV mode — shown as small thumbnail for tool context */}
        {mode === 'dcv' && toolName && (
          <div className="absolute bottom-2 right-2 z-10 bg-gray-800/80 rounded px-2 py-1 text-xs text-gray-300">
            {toolName}
          </div>
        )}
      </div>

      {/* Resize handle (bottom-right corner) - only when not expanded */}
      {!expanded && (
        <div
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
          onMouseDown={handleResizeMouseDown}
        >
          <svg
            className="w-3 h-3 absolute bottom-0.5 right-0.5 text-gray-600"
            viewBox="0 0 12 12"
            fill="currentColor"
          >
            <circle cx="10" cy="10" r="1.5" />
            <circle cx="6" cy="10" r="1.5" />
            <circle cx="10" cy="6" r="1.5" />
          </svg>
        </div>
      )}
    </div>
  )
}
