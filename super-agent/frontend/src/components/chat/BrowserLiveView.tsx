/**
 * BrowserLiveView
 *
 * A floating, draggable panel that displays live browser screenshots from
 * the agent's browser tool usage. Auto-shows when a `browser_frame` event
 * arrives via the SSE stream. Does NOT auto-close when the agent finishes.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Monitor, Loader2, Maximize2, Minimize2 } from 'lucide-react'

interface BrowserLiveViewProps {
  /** If provided externally, the component uses this. Otherwise listens to window events. */
  screenshotData?: string | null
  browserToolName?: string
}

export function BrowserLiveView({ screenshotData: externalData, browserToolName: externalToolName }: BrowserLiveViewProps = {}) {
  const [visible, setVisible] = useState(false)
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [toolName, setToolName] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Drag state
  const [position, setPosition] = useState({ x: 20, y: 20 })
  const [dragging, setDragging] = useState(false)
  const dragOffset = useRef({ x: 0, y: 0 })
  const panelRef = useRef<HTMLDivElement>(null)

  // Resize state
  const [size, setSize] = useState({ width: 480, height: 360 })
  const [resizing, setResizing] = useState(false)
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 })

  // Handle external screenshotData prop changes
  useEffect(() => {
    if (externalData) {
      setScreenshot(externalData)
      setToolName(externalToolName)
      setVisible(true)
      setLoading(false)
    }
  }, [externalData, externalToolName])

  // Listen for browser-frame custom events from the stream
  useEffect(() => {
    const handleBrowserFrame = (e: Event) => {
      const { screenshotData, browserToolName } = (e as CustomEvent).detail
      if (screenshotData) {
        setScreenshot(screenshotData)
        setToolName(browserToolName)
        setVisible(true)
        setLoading(false)
      } else {
        // Event received but no data yet — show loading state
        setLoading(true)
        setVisible(true)
      }
    }

    window.addEventListener('browser-frame', handleBrowserFrame)
    return () => window.removeEventListener('browser-frame', handleBrowserFrame)
  }, [])

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start drag from the header area
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
        width: Math.max(320, resizeStart.current.width + dx),
        height: Math.max(240, resizeStart.current.height + dy),
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
  }, [])

  const toggleExpanded = useCallback(() => {
    setExpanded(prev => !prev)
  }, [])

  if (!visible) return null

  return (
    <div
      ref={panelRef}
      className={`fixed z-50 flex flex-col bg-gray-900 border border-gray-700 rounded-xl shadow-2xl overflow-hidden ${
        dragging || resizing ? 'select-none' : ''
      } ${expanded ? 'inset-10' : ''}`}
      style={expanded ? {} : { top: position.y, left: position.x, width: size.width, height: size.height }}
    >
      {/* Header — draggable */}
      <div
        className="flex items-center gap-2 px-3 py-2 bg-gray-800 border-b border-gray-700 cursor-move flex-shrink-0"
        onMouseDown={handleMouseDown}
      >
        <Monitor className="w-4 h-4 text-blue-400" />
        <span className="text-sm font-medium text-white flex-1 truncate">
          Browser Live View
          {toolName && (
            <span className="ml-2 text-xs text-gray-400 font-normal">
              ({toolName})
            </span>
          )}
        </span>
        <div className="flex items-center gap-1" data-no-drag>
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
        {loading && !screenshot && (
          <div className="flex flex-col items-center gap-2 text-gray-400">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="text-sm">Waiting for browser screenshot...</span>
          </div>
        )}

        {screenshot && (
          <>
            {/* Loading overlay between frames */}
            {loading && (
              <div className="absolute top-2 right-2 z-10">
                <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
              </div>
            )}
            <img
              src={screenshot}
              alt="Browser screenshot"
              className="max-w-full max-h-full object-contain"
              draggable={false}
            />
          </>
        )}
      </div>

      {/* Resize handle (bottom-right corner) — only when not expanded */}
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
